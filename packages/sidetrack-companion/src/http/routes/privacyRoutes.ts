// Privacy routes: the privacy projection read, privacy event ingestion, and
// domain-tombstone creation.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { DOMAIN_TOMBSTONE, DOMAIN_TOMBSTONE_CATEGORY_TOKENS, registrableDomain, registrableDomainFromUrl, type DomainTombstoneCategoryToken, type DomainTombstonePayload } from '../../privacy/domainTombstone.js';
import { upsertDomainTombstone } from '../../privacy/domainTombstoneStore.js';
import { PRIVACY_GATE_FLIPPED, PRIVACY_PERMISSION_GRANTED, PRIVACY_PERMISSION_REVOKED, isPrivacyGateFlippedPayload, isPrivacyPermissionGrantedPayload, isPrivacyPermissionRevokedPayload } from '../../privacy/events.js';
import { projectPrivacy } from '../../privacy/projection.js';

import { HttpRouteError, baseVectorForAggregate, invalidateDomainTombstoneCache, objectRecord, readBody, readEventsFromStoreOrLog, requireIdempotencyKey, runIdempotent } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

const PRIVACY_AGGREGATE_ID = 'privacy';

export const isPrivacyEventType = (
  value: unknown,
): value is
  | typeof PRIVACY_GATE_FLIPPED
  | typeof PRIVACY_PERMISSION_GRANTED
  | typeof PRIVACY_PERMISSION_REVOKED =>
  value === PRIVACY_GATE_FLIPPED ||
  value === PRIVACY_PERMISSION_GRANTED ||
  value === PRIVACY_PERMISSION_REVOKED;

const isPrivacyPayloadForType = (
  type: string,
  payload: unknown,
): payload is Record<string, unknown> => {
  if (type === PRIVACY_GATE_FLIPPED) return isPrivacyGateFlippedPayload(payload);
  if (type === PRIVACY_PERMISSION_GRANTED) return isPrivacyPermissionGrantedPayload(payload);
  if (type === PRIVACY_PERMISSION_REVOKED) return isPrivacyPermissionRevokedPayload(payload);
  return false;
};

const PRIVACY_EVENT_TYPES = [
  PRIVACY_GATE_FLIPPED,
  PRIVACY_PERMISSION_GRANTED,
  PRIVACY_PERMISSION_REVOKED,
] as const;

export const privacyRoutes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/privacy\/projection$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      return [
        200,
        {
          data: projectPrivacy(
            await readEventsFromStoreOrLog(
              context,
              context.eventLog,
              (event) => isPrivacyEventType(event.type),
              PRIVACY_EVENT_TYPES,
            ),
          ),
        },
      ];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/privacy\/events$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const eventLog = context.eventLog;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'privacyEvent', idempotencyKey, async () => {
        const body = objectRecord(await readBody(request));
        const type = body?.['type'];
        const payload = body?.['payload'];
        if (!isPrivacyEventType(type) || !isPrivacyPayloadForType(type, payload)) {
          throw new HttpRouteError(
            400,
            'VALIDATION_ERROR',
            'Validation failed.',
            'Body must be a valid privacy event envelope.',
          );
        }
        const accepted = await eventLog.appendClient({
          clientEventId: idempotencyKey,
          aggregateId: PRIVACY_AGGREGATE_ID,
          type,
          payload,
          baseVector: await baseVectorForAggregate(eventLog, PRIVACY_AGGREGATE_ID),
        });
        return [
          201,
          {
            data: {
              accepted,
              projection: projectPrivacy(
                await readEventsFromStoreOrLog(
                  context,
                  eventLog,
                  (event) => isPrivacyEventType(event.type),
                  PRIVACY_EVENT_TYPES,
                ),
              ),
            },
          },
        ];
      });
    },
  },
  {
    // Domain-tombstone privacy purge. Invoked by the extension's
    // per-rule "Purge captured data" action. Persists a DOMAIN_TOMBSTONE
    // (event log for audit/sync + a materialized JSON list for the
    // read-boundary gate), hard-deletes matching recall-v2 vectors, and
    // invalidates the tombstone cache so every serve boundary excludes
    // the domain immediately.
    //
    // MUTATING + NOT in MCP_ALLOWED_MUTATING_ROUTES ⇒ auto-DENIED to
    // mcp-key callers by the dispatch layer (data-lifecycle is never an
    // agent-sanctioned operation). authRequired gates the extension key.
    method: 'POST',
    pattern: /^\/v1\/privacy\/domain-tombstone$/u,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      if (context.vaultRoot === undefined) {
        throw new HttpRouteError(
          503,
          'VAULT_UNAVAILABLE',
          'Vault root is unavailable — cannot persist a domain tombstone.',
        );
      }
      const eventLog = context.eventLog;
      const vaultRoot = context.vaultRoot;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'domainTombstone', idempotencyKey, async () => {
        const body = objectRecord(await readBody(request));
        const kind = body?.['kind'];
        const rawDomain = body?.['domain'];
        if (kind !== 'domain' && kind !== 'similar') {
          throw new HttpRouteError(
            400,
            'VALIDATION_ERROR',
            'kind must be "domain" or "similar".',
          );
        }
        if (typeof rawDomain !== 'string' || rawDomain.trim().length === 0) {
          throw new HttpRouteError(400, 'VALIDATION_ERROR', 'domain is required.');
        }
        // Normalize the domain to eTLD+1 defensively (a hostname or full
        // URL both collapse to the registrable domain).
        const domain = rawDomain.includes('/')
          ? registrableDomainFromUrl(rawDomain)
          : registrableDomain(rawDomain);
        if (domain.length === 0) {
          throw new HttpRouteError(400, 'VALIDATION_ERROR', 'domain has no registrable eTLD+1.');
        }
        // Optional HOST scope. When present, the purge is host-scoped: only
        // the host + its own subdomains are hidden/deleted; sibling hosts
        // under the same eTLD+1 survive (data-preserving direction —
        // over-purging destroys data the user kept). The host must belong to
        // the resolved eTLD+1 family (its registrable domain === domain);
        // otherwise the scope is incoherent and we reject rather than
        // silently widen. Absent ⇒ family-wide (legacy eTLD+1 semantics).
        const rawHost = body?.['host'];
        let host: string | undefined;
        if (rawHost !== undefined) {
          if (typeof rawHost !== 'string' || rawHost.trim().length === 0) {
            throw new HttpRouteError(400, 'VALIDATION_ERROR', 'host must be a non-empty string.');
          }
          const normalizedHost = rawHost.trim().toLowerCase().replace(/\.$/u, '');
          if (registrableDomain(normalizedHost) !== domain) {
            throw new HttpRouteError(
              400,
              'VALIDATION_ERROR',
              'host must belong to the same registrable domain family.',
            );
          }
          host = normalizedHost;
        }
        const rawTokens = body?.['categoryTokens'];
        const categoryTokens: DomainTombstoneCategoryToken[] = Array.isArray(rawTokens)
          ? (rawTokens.filter((token): token is DomainTombstoneCategoryToken =>
              (DOMAIN_TOMBSTONE_CATEGORY_TOKENS as readonly string[]).includes(token as string),
            ))
          : [];
        const tombstone: DomainTombstonePayload = {
          payloadVersion: 1,
          kind,
          domain,
          ...(host === undefined ? {} : { host }),
          ...(kind === 'similar' && categoryTokens.length > 0 ? { categoryTokens } : {}),
          tombstonedAt: new Date().toISOString(),
        };
        // 1. Append to the event log (audit + sync durability). The scope
        //    (host or family) is folded into the client/aggregate ids so a
        //    sibling-host tombstone is a DISTINCT event rather than being
        //    idempotency-collapsed onto the family one.
        const scopeKey = host ?? domain;
        await eventLog
          .appendServerObserved({
            clientEventId: `${DOMAIN_TOMBSTONE}:${kind}:${scopeKey}`,
            aggregateId: `privacy:domain-tombstone:${scopeKey}`,
            type: DOMAIN_TOMBSTONE,
            payload: tombstone as unknown as Record<string, unknown>,
          })
          .catch(() => undefined);
        // 2. Materialize the tombstone list the serve boundaries read.
        const all = await upsertDomainTombstone(vaultRoot, tombstone);
        // 3. Invalidate the read-boundary cache so the next serve hides it.
        invalidateDomainTombstoneCache();
        // 4. Hard-delete matching recall-v2 vectors/docs/chunks (derived
        //    store scrub). Best-effort — a store that can't purge just
        //    relies on the serve-boundary filter. The raw JSONL log is
        //    intentionally NOT rewritten (append indexes reject in-process
        //    shard rewrites; a full offline scrub is a separate tool). A
        //    HOST-scoped tombstone purges only the host + its subdomains so
        //    sibling hosts under the same eTLD+1 keep their data.
        let vectorsPurged = 0;
        try {
          const { purgeRecallV2StoreByDomain, purgeRecallV2StoreByHost } = await import(
            '../../recall-v2/pipeline.js'
          );
          vectorsPurged =
            host === undefined
              ? await purgeRecallV2StoreByDomain(vaultRoot, domain)
              : await purgeRecallV2StoreByHost(vaultRoot, host);
        } catch {
          vectorsPurged = 0;
        }
        return [
          201,
          {
            data: {
              tombstoned: true,
              domain,
              ...(host === undefined ? {} : { host }),
              kind,
              vectorsPurged,
              tombstoneCount: all.length,
            },
          },
        ];
      });
    },
  },
];
