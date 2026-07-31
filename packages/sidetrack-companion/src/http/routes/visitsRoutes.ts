// Visit routes: projection, inbox, per-URL resolve, attribute, and ignore.
// The batch-resolve mega-route (POST /v1/visits/batch-resolve) stays INLINE
// in server.ts's composition — its cache/lane machinery is entangled with
// server.ts-private state that cannot move without dragging half the file.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { join } from 'node:path';

import { resolveUrlAttributionArmed } from '../../attribution-v1/armedResolve.js';
import { currentAttributionV1StateRevision, emitAttributionV1Shadow, incumbentTopFromResolution, loadAttributionV1State } from '../../attribution-v1/emit.js';
import { attributionArm } from '../../attribution-v1/serve.js';
import { SqliteConnectionsStore } from '../../connections/snapshot.js';
import { ENTITY_TITLE_ENRICHED, effectiveUrlTitle, enrichmentLookupFromMerged, loadEnrichmentLookup, lookupSynthesizedTitle } from '../../enrichment/titleEnrichment.js';
import { USER_FLOW_REJECTED, USER_ORGANIZED_ITEM, isUserFlowRejectedPayload, isUserOrganizedItemPayload } from '../../feedback/events.js';
import { generateCandidates } from '../../ranker/candidates.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import { isLaneOpportunityId, recordLaneOutcome } from '../../tabsession/lanePrequential.js';
import type { UrlResolutionResult } from '../../tabsession/resolver.js';
import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload } from '../../timeline/events.js';
import { autoApplyUrlAttribution } from '../../urls/autoApply.js';
import { URL_IGNORED } from '../../urls/events.js';
import { serializeUrlProjection, urlInbox } from '../../urls/projection.js';

import { HttpRouteError, RESOLVER_SIGNAL_EVENT_TYPES, aggregateIdForFeedbackEvent, baseVectorForAggregate, connectionsGraphSig, domainTombstoneSetFor, invalidateResolveCaches, loadUrlProjection, objectRecord, optionalAttributionPolicyMode, optionalAttributionPolicyTelemetry, readBody, readEventsFromStoreOrLog, requireIdempotencyKey, requireVaultRoot, runIdempotent, serveResolveSwr } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

// Resolver-cache key discriminator (F3/F4). The persistent SQLite resolver
// cache is keyed on (visit_id, snapshot_revision) and SURVIVES restart. Two
// quantities the bare snapshotRevision misses:
//   1. The SERVING ARM. Flipping SIDETRACK_ATTRIBUTION_ARM (env + restart)
//      must not serve entries computed under the other arm — otherwise a
//      v1->vote flip keeps serving the incumbent's abstain (and vice-versa)
//      for every URL whose snapshotRevision has not rolled.
//   2. The AttributionV1State revision (vote arm only). The vote decision is a
//      pure function of the drain-time state (recency/domain/title), which
//      changes on EVERY filing — but the connections snapshotRevision is
//      W1c-floored / M3-sticky and may not roll on a re-file, so a
//      snapshot-only key serves a stale vote ("file a neighbor, fresh visit
//      lights up" would break). Fold the state mtime in so a state drain busts.
// The incumbent arm ('v1') is a pure function of the snapshot, so its key does
// NOT include the state revision (only the arm tag) — no false busts there.
//
// Async because the vote arm's state revision comes from the memoized state,
// which must be REFRESHED before the cache read (a cheap fs.stat when warm) so
// the read key reflects the CURRENT drain, not whatever a prior resolve loaded.
// loadAttributionV1State is idempotent + mtime-memoized, and the served vote
// arm calls it again inside armedResolve — so this pre-warm costs at most one
// extra fs.stat, never a re-parse.
export const resolverCacheRevision = async (
  snapshotRevision: string,
  vaultRoot: string,
): Promise<string> => {
  const arm = attributionArm();
  if (arm === 'v1') return `${snapshotRevision}|arm=v1`;
  await loadAttributionV1State(vaultRoot);
  return `${snapshotRevision}|arm=${arm}|st=${currentAttributionV1StateRevision()}`;
};

// The SWR staleness signature for the resolve routes (F4). The in-memory SWR
// cache keys the STALENESS check on the connections graph sig, which is
// deliberately W1c-floored / M3-sticky (stable between graph-moving drains). But
// the served VOTE arm's answer depends on the AttributionV1State, which changes
// on every filing WITHOUT necessarily rolling the graph sig — so a bare graph
// sig would keep serving the pre-filing vote from the SWR entry. Append the arm
// + state revision so a v1<->vote flip and every attribution-state drain move
// the sig and trigger the background refresh. For the incumbent arm this only
// appends the constant `|arm=v1` (no false busts — the incumbent is a pure
// function of the graph). Async for the same cheap-stat state warm-up as
// resolverCacheRevision.
export const armedResolveSig = async (graphSig: string, vaultRoot: string): Promise<string> => {
  const arm = attributionArm();
  if (arm === 'v1') return `${graphSig}|arm=v1`;
  await loadAttributionV1State(vaultRoot);
  return `${graphSig}|arm=${arm}|st=${currentAttributionV1StateRevision()}`;
};

export const resolverSignalEventsForCanonicalUrls = (
  events: readonly AcceptedEvent[],
  canonicalUrls: readonly string[],
): readonly AcceptedEvent[] => {
  const targets = new Set(canonicalUrls);
  return events.filter((event) => {
    if (event.type === USER_FLOW_REJECTED && isUserFlowRejectedPayload(event.payload)) {
      return true;
    }
    if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) {
      return false;
    }
    return event.payload.itemKind === 'canonical-url' && targets.has(event.payload.itemId);
  });
};

const resolverCanonicalUrlKey = (raw: string): string => raw.replace(/#.*$/u, '').replace(/\/+$/u, '');

const candidateSourceWeight = (sources: readonly string[]): number => {
  if (sources.includes('same_canonical_url')) return 0.9;
  if (sources.includes('opener_chain')) return 0.85;
  if (sources.includes('navigation_chain')) return 0.8;
  if (sources.includes('content_embedding_neighborhood')) return 0.75;
  if (sources.includes('content_term_overlap')) return 0.7;
  if (sources.includes('same_repo_or_domain')) return 0.65;
  if (sources.includes('same_search_query')) return 0.6;
  if (sources.includes('same_copied_snippet')) return 0.55;
  if (sources.includes('same_title_path_tokens')) return 0.45;
  if (sources.includes('embedding_neighborhood')) return 0.4;
  if (sources.includes('cross_replica_continuation')) return 0.35;
  return 0.1;
};

const timelineEventsForResolverCandidates = (
  events: readonly AcceptedEvent[],
): readonly AcceptedEvent[] =>
  events.filter((event) => event.type === BROWSER_TIMELINE_OBSERVED);

export const resolverTimelineEventsForCanonicalUrls = (
  events: readonly AcceptedEvent[],
  canonicalUrls: ReadonlySet<string>,
): readonly AcceptedEvent[] => {
  const normalizedTargets = new Set([...canonicalUrls].map(resolverCanonicalUrlKey));
  return events.filter((event) => {
    if (event.type !== BROWSER_TIMELINE_OBSERVED || !isBrowserTimelineObservedPayload(event.payload)) {
      return false;
    }
    const visitKey = resolverCanonicalUrlKey(event.payload.canonicalUrl ?? event.payload.url);
    return normalizedTargets.has(visitKey);
  });
};

export const resolverExpandedCandidateUrlsForCanonicalUrls = (
  events: readonly AcceptedEvent[],
  canonicalUrls: readonly string[],
  maxPerUrl = 80,
): ReadonlyMap<string, readonly string[]> => {
  if (canonicalUrls.length === 0) return new Map();
  const timelineEvents = timelineEventsForResolverCandidates(events);
  if (timelineEvents.length === 0) return new Map();
  const context = { merged: [...timelineEvents], existingEdges: [] };
  const out = new Map<string, readonly string[]>();
  for (const canonicalUrl of canonicalUrls) {
    const targetVisitKey = resolverCanonicalUrlKey(canonicalUrl);
    const ranked = generateCandidates(targetVisitKey, context)
      .map((candidate) => ({
        canonicalUrl: resolverCanonicalUrlKey(candidate.toVisitId),
        weight: candidateSourceWeight(candidate.sources),
      }))
      .filter(
        (candidate) =>
          candidate.canonicalUrl.length > 0 &&
          candidate.canonicalUrl !== targetVisitKey &&
          /^https?:\/\//iu.test(candidate.canonicalUrl),
      )
      .sort(
        (left, right) =>
          right.weight - left.weight || left.canonicalUrl.localeCompare(right.canonicalUrl),
      );
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const candidate of ranked) {
      if (seen.has(candidate.canonicalUrl)) continue;
      seen.add(candidate.canonicalUrl);
      deduped.push(candidate.canonicalUrl);
      if (deduped.length >= maxPerUrl) break;
    }
    out.set(canonicalUrl, deduped);
  }
  return out;
};

export const RESOLVER_EXPAND_EVENT_TYPES = [
  BROWSER_TIMELINE_OBSERVED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
] as const;

export const visitsRoutesA: readonly RouteDefinition[] = [
  // -- Per-canonical-URL attribution surface --------------------------
  // The user-facing Inbox/Connections triages PAGES (canonical URLs),
  // not tab sessions. These routes mirror /v1/tabsessions/* but key by
  // canonical URL so multiple visits of the same page collapse to one
  // attribution unit. Tab-session attribution stays available for
  // back-compat sync from older replicas.
  {
    method: 'GET',
    pattern: /^\/v1\/visits\/projection$/u,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const { projection, snapshotRevision } = await loadUrlProjection(context, context.eventLog);
      return [
        200,
        {
          // PR #141 added a TTL cache here; superseded by Stage 5.2 R2.
          data: serializeUrlProjection(projection),
          ...(snapshotRevision === null ? {} : { snapshotRevision }),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/visits\/inbox$/u,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const url = new URL(request.url ?? '/v1/visits/inbox', 'http://internal');
      const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
      const offsetRaw = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
      const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
      const { projection, snapshotRevision } = await loadUrlProjection(context, context.eventLog);
      const rawItems = urlInbox(projection, { limit, offset });
      // Title enrichment (url kind): overlay each visit's displayed
      // latestTitle where the raw title is structurally junk (empty /
      // URL-shaped). Folded lookup is memoized on the event-log signature;
      // effectiveUrlTitle never overwrites a real title. Flag-off ⇒ null
      // lookup ⇒ raw items returned unchanged.
      const inboxLookup = await loadEnrichmentLookup(
        requireVaultRoot(context),
        context.eventLog,
      );
      const items =
        inboxLookup === null
          ? rawItems
          : rawItems.map((item) => {
              const overlaid = effectiveUrlTitle(inboxLookup, item.canonicalUrl, item.latestTitle);
              return overlaid === item.latestTitle
                ? item
                : { ...item, ...(overlaid === undefined ? {} : { latestTitle: overlaid }) };
            });
      return [
        200,
        {
          data: {
            items,
            total: urlInbox(projection, { limit: Number.MAX_SAFE_INTEGER, offset: 0 }).length,
            limit,
            offset,
          },
          ...(snapshotRevision === null ? {} : { snapshotRevision }),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/visits\/(?<canonicalUrl>[^/]+)\/resolve$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      if (context.connectionsStore === undefined) {
        throw new HttpRouteError(503, 'CONNECTIONS_NOT_WIRED', 'Connections is not configured.');
      }
      const url = new URL(request.url ?? '/v1/visits/resolve', 'http://internal');
      if (url.searchParams.get('dryRun') !== 'true') {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          'URL resolver is dry-run only in this phase.',
        );
      }
      // SWR serve-key is per URL + query only (NOT graph-sig): the sig is
      // checked separately so a drain serves the stale entry instantly and
      // refreshes THIS key in the background instead of evicting.
      const visResKey = `visres:${decodeURIComponent(match.canonicalUrl ?? '')}|${url.search}`;
      const graphSig = await connectionsGraphSig(
        context.connectionsStore,
        join(requireVaultRoot(context), '_BAC', 'connections', 'current.json'),
      );
      // Arm + state-aware SWR sig (F4): a vote-arm state drain (or a v1<->vote
      // flip) busts the SWR entry even when the sticky graph sig is unchanged.
      const resolveSwrSig = await armedResolveSig(graphSig, requireVaultRoot(context));
      return serveResolveSwr(
        visResKey,
        resolveSwrSig,
        async (): Promise<readonly [number, unknown]> => {
          const canonicalUrl = decodeURIComponent(match.canonicalUrl ?? '');
          const expandEventCandidates =
            url.searchParams.get('eventCandidates') === '1' ||
            url.searchParams.get('eventCandidates') === 'true';
          const sqliteStore =
            context.connectionsStore instanceof SqliteConnectionsStore
              ? context.connectionsStore
              : null;
          const usesSqliteSubgraph = sqliteStore !== null;
          const preloadedMerged =
            usesSqliteSubgraph && expandEventCandidates
              ? await readEventsFromStoreOrLog(
                  context,
                  context.eventLog!,
                  (event) =>
                    event.type === BROWSER_TIMELINE_OBSERVED ||
                    event.type === USER_FLOW_REJECTED ||
                    event.type === USER_ORGANIZED_ITEM,
                  RESOLVER_EXPAND_EVENT_TYPES,
                )
              : null;
          const expandedCandidateUrls =
            preloadedMerged === null
              ? []
              : (resolverExpandedCandidateUrlsForCanonicalUrls(preloadedMerged, [canonicalUrl]).get(
                  canonicalUrl,
                ) ?? []);
          const snapshot =
            usesSqliteSubgraph
              ? expandedCandidateUrls.length === 0
                ? await sqliteStore.readResolverSubgraphForUrl(canonicalUrl)
                : await sqliteStore.readResolverSubgraphForUrls([
                    canonicalUrl,
                    ...expandedCandidateUrls,
                  ])
              : await context.connectionsStore!.readCurrent();
          if (snapshot === null) {
            throw new HttpRouteError(
              409,
              'CONNECTIONS_SNAPSHOT_MISSING',
              'Connections snapshot is not ready.',
            );
          }
          if (canonicalUrl.length === 0) {
            throw new HttpRouteError(400, 'VALIDATION_ERROR', 'Validation failed.');
          }
          const snapshotRevision = snapshot.snapshotRevision;
          if (
            snapshotRevision !== undefined &&
            usesSqliteSubgraph &&
            !expandEventCandidates
          ) {
            const cached = await sqliteStore.getCachedResolverResult(
              canonicalUrl,
              await resolverCacheRevision(snapshotRevision, requireVaultRoot(context)),
            );
            if (cached !== null) {
              return [
                200,
                {
                  data: cached as UrlResolutionResult,
                  snapshotRevision,
                },
              ];
            }
          }
          const merged =
            preloadedMerged ??
            (usesSqliteSubgraph
              ? await readEventsFromStoreOrLog(
                  context,
                  context.eventLog!,
                  (event) =>
                    event.type === USER_FLOW_REJECTED ||
                    event.type === USER_ORGANIZED_ITEM ||
                    event.type === ENTITY_TITLE_ENRICHED,
                  [...RESOLVER_SIGNAL_EVENT_TYPES, ENTITY_TITLE_ENRICHED],
                )
              : await context.eventLog!.readMerged());
          const resolverEvents =
            usesSqliteSubgraph && expandEventCandidates
              ? [
                  ...resolverSignalEventsForCanonicalUrls(merged, [canonicalUrl]),
                  ...resolverTimelineEventsForCanonicalUrls(
                    merged,
                    new Set([canonicalUrl, ...expandedCandidateUrls]),
                  ),
                ]
              : usesSqliteSubgraph
                ? resolverSignalEventsForCanonicalUrls(merged, [canonicalUrl])
                : merged;
          // Attribution ARM switch (SIDETRACK_ATTRIBUTION_ARM, default
          // 'vote3'). 'v1' keeps the incumbent graph-resolver serving; the
          // vote arm returns the servable vote3 decision (reproducing the
          // frozen-baseline win the incumbent leaves dark — see
          // attribution-v1/serve.ts). Same UrlResolutionResult shape either
          // way, so caching + the round-guard stack compose unchanged. When
          // the vote arm serves it ALSO runs the incumbent for the reverse
          // shadow (gated behind the v1-shadow flag) inside armedResolve.
          // Title enrichment (url kind): last-resort synthesized title for a
          // junk-titled visit, folded from the SAME merged log this resolve
          // already read (the ENTITY_TITLE_ENRICHED type was added to the
          // read filter above) — no extra scan. undefined ⇒ prior behavior.
          const singleEnrichmentSynthesized = lookupSynthesizedTitle(
            enrichmentLookupFromMerged(
              requireVaultRoot(context),
              await context.eventLog!.logSignature(),
              merged,
            ),
            'url',
            canonicalUrl,
          );
          const result = await resolveUrlAttributionArmed({
            vaultRoot: requireVaultRoot(context),
            canonicalUrl,
            snapshot,
            events: resolverEvents,
            // F1 privacy gate: hand the vote arm the served tombstone set so a
            // purged URL/domain never re-enters attribution through the new
            // serve boundary (no-op for the incumbent arm).
            tombstones: await domainTombstoneSetFor(context),
            ...(singleEnrichmentSynthesized === undefined
              ? {}
              : { synthesizedTitle: singleEnrichmentSynthesized }),
            ...(usesSqliteSubgraph && !expandEventCandidates
              ? { useEventCandidateSimilarity: false }
              : {}),
          });
          if (
            snapshotRevision !== undefined &&
            usesSqliteSubgraph &&
            !expandEventCandidates
          ) {
            await sqliteStore.cacheResolverResult(
              canonicalUrl,
              await resolverCacheRevision(snapshotRevision, requireVaultRoot(context)),
              result,
            );
          }
          // Attribution v1 SHADOW lane (SIDETRACK_ATTRIBUTION_V1_SHADOW,
          // default ON). Runs the v1 scorer beside whatever serves and
          // records a compact comparison. Best-effort + fully self-
          // contained: it never throws and never touches `result`, so the
          // served response is byte-identical with the flag on or off.
          // The O(nodes) title lookup runs LAZILY inside emit — only after
          // its flag + fresh-state gates pass — so with the shadow flag off
          // this call is a cheap no-op and no snapshot scan happens. Skipped
          // when the vote arm serves (armedResolve already records the
          // reverse arm-shadow) to avoid double state loads on the hot path.
          if (attributionArm() === 'v1') {
            await emitAttributionV1Shadow({
              vaultRoot: requireVaultRoot(context),
              canonicalUrl,
              snapshot,
              incumbentTop: incumbentTopFromResolution(result),
            });
          }
          return [
            200,
            {
              data: result,
              ...(snapshotRevision === undefined ? {} : { snapshotRevision }),
            },
          ];
        },
      );
    },
  },
];

export const visitsRoutesB: readonly RouteDefinition[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/visits\/(?<canonicalUrl>[^/]+)\/resolve$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      if (context.connectionsStore === undefined) {
        throw new HttpRouteError(503, 'CONNECTIONS_NOT_WIRED', 'Connections is not configured.');
      }
      const eventLog = context.eventLog;
      const connectionsStore = context.connectionsStore;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'urlResolveAutoApply', idempotencyKey, async () => {
        const body = objectRecord(await readBody(request)) ?? {};
        if (body['dryRun'] !== false) {
          throw new HttpRouteError(
            400,
            'VALIDATION_ERROR',
            'Validation failed.',
            'Body must set dryRun:false for auto-apply.',
          );
        }
        const canonicalUrl = decodeURIComponent(match.canonicalUrl ?? '');
        const usesSqliteSubgraph = connectionsStore instanceof SqliteConnectionsStore;
        const snapshot =
          usesSqliteSubgraph
            ? await connectionsStore.readResolverSubgraphForUrl(canonicalUrl)
            : await connectionsStore.readCurrent();
        if (snapshot === null) {
          throw new HttpRouteError(
            409,
            'CONNECTIONS_SNAPSHOT_MISSING',
            'Connections snapshot is not ready.',
          );
        }
        if (canonicalUrl.length === 0) {
          throw new HttpRouteError(400, 'VALIDATION_ERROR', 'Validation failed.');
        }
        const snapshotProjection = snapshot.urlProjection;
        if (
          snapshotProjection !== undefined &&
          snapshotProjection.byCanonicalUrl[canonicalUrl] === undefined
        ) {
          throw new HttpRouteError(404, 'URL_NOT_FOUND', 'URL was not found.');
        }
        const policyMode = optionalAttributionPolicyMode(body['policyMode'], 'policyMode');
        const policyTelemetry = optionalAttributionPolicyTelemetry(
          body['policyTelemetry'],
          'policyTelemetry',
        );
        const resolverEvents = usesSqliteSubgraph
          ? await readEventsFromStoreOrLog(
              context,
              eventLog,
              (event) => resolverSignalEventsForCanonicalUrls([event], [canonicalUrl]).length > 0,
              RESOLVER_SIGNAL_EVENT_TYPES,
            )
          : await eventLog.readMerged();
        const result = await autoApplyUrlAttribution({
          eventLog,
          snapshot,
          canonicalUrl,
          events: resolverEvents,
          ...(context.vaultRoot === undefined ? {} : { vaultRoot: context.vaultRoot }),
          ...(snapshotProjection === undefined ? {} : { urlProjection: snapshotProjection }),
          ...(usesSqliteSubgraph ? { useEventCandidateSimilarity: false } : {}),
          ...(policyMode === undefined ? {} : { policyMode }),
          ...(policyTelemetry === undefined ? {} : { policyTelemetry }),
        });
        // PR #141 invalidated the TTL cache here; Stage 5.2 R2 reads
        // from the snapshot store so no manual invalidation is needed.
        return [
          result.status === 'applied' ? 201 : 200,
          {
            data: {
              status: result.status,
              resolution: result.resolution,
              ...(result.accepted === undefined ? {} : { accepted: result.accepted }),
            },
          },
        ];
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/visits\/(?<canonicalUrl>[^/]+)\/attribute$/u,
    authRequired: true,
    handle: async (request, requestId, match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      // canonicalUrl is URL-encoded in the path component (slashes and
      // colons survive encoding). Decode and validate non-empty.
      const canonicalUrl = decodeURIComponent(match.canonicalUrl ?? '');
      if (canonicalUrl.length === 0) {
        throw new HttpRouteError(400, 'VALIDATION_ERROR', 'Validation failed.');
      }
      const eventLog = context.eventLog;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'urlAttribute', idempotencyKey, async () => {
        const body = objectRecord(await readBody(request));
        const workstreamId = body?.['workstreamId'];
        const servedOpportunityId = body?.['servedOpportunityId'];
        if (
          !(workstreamId === null || (typeof workstreamId === 'string' && workstreamId.length > 0))
        ) {
          throw new HttpRouteError(
            400,
            'VALIDATION_ERROR',
            'Validation failed.',
            'Body must contain workstreamId as a non-empty string or null.',
          );
        }
        if (servedOpportunityId !== undefined && !isLaneOpportunityId(servedOpportunityId)) {
          throw new HttpRouteError(
            400,
            'VALIDATION_ERROR',
            'Validation failed.',
            'servedOpportunityId must be a valid lane opportunity id when provided.',
          );
        }
        // Stage 5.2 R5 — see matching note on the tab-session POST route
        // above. post-write goes through loadUrlProjection (snapshot-first
        // with event-log fallback); Half 2 W2 will upgrade to a row-local
        // fold for true read-your-writes without a full re-projection.
        const { projection: priorProjection } = await loadUrlProjection(context, eventLog);
        const fromWorkstreamId =
          priorProjection.byCanonicalUrl.get(canonicalUrl)?.currentAttribution?.workstreamId;
        const payload = {
          payloadVersion: 1,
          itemKind: 'canonical-url',
          itemId: canonicalUrl,
          action: 'move',
          ...(fromWorkstreamId === undefined || fromWorkstreamId === null
            ? {}
            : { fromContainer: fromWorkstreamId }),
          toContainer: workstreamId,
          ...(servedOpportunityId === undefined
            ? {}
            : { details: { servedOpportunityId } }),
        } as const;
        const aggregateId = aggregateIdForFeedbackEvent(USER_ORGANIZED_ITEM, payload);
        const accepted = await eventLog.appendClient({
          clientEventId: idempotencyKey,
          aggregateId,
          type: USER_ORGANIZED_ITEM,
          payload,
          baseVector: await baseVectorForAggregate(eventLog, aggregateId),
        });
        if (servedOpportunityId !== undefined) {
          // The causal event above is canonical. This compact mirror makes the
          // ID-first prequential join cheap even when the experimental 700 MB
          // SQLite event mirror is disabled. Failure never rolls back the user
          // decision; it is visible and recoverable from event payload details.
          await recordLaneOutcome(requireVaultRoot(context), {
            opportunityId: servedOpportunityId,
            canonicalUrl,
            workstreamId,
            atMs: accepted.acceptedAtMs,
          }).catch((error: unknown) => {
            // PII-free structured operation marker; never log URL/workstream.
            console.warn('[lane-prequential]', {
              requestId,
              operation: 'lane-prequential.outcome-record',
              outcome: 'error',
              errorCategory: error instanceof Error ? error.name : 'unknown',
            });
          });
        }
        invalidateResolveCaches();
        // Stage 5.2 R5 — see matching block in the tab-session POST
        // route. (PR #141's invalidateCachedUrlProjection was a TTL
        // cache buster that R2/R5 makes redundant.)
        const { projection: postProjection } = await loadUrlProjection(context, eventLog);
        return [
          201,
          {
            data: {
              accepted,
              projection: serializeUrlProjection(postProjection),
            },
          },
        ];
      });
    },
  },
  {
    // Stage 5 polish — explicit "don't bother me about this URL"
    // signal. Distinct from POST /attribute with workstreamId:null
    // (which says "meaningful but no workstream"). Writes a
    // urls.ignored event; the URL projection's currentIgnored field
    // hides it from Inbox + auto-apply.
    method: 'POST',
    pattern: /^\/v1\/visits\/(?<canonicalUrl>[^/]+)\/ignore$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const canonicalUrl = decodeURIComponent(match.canonicalUrl ?? '');
      if (canonicalUrl.length === 0) {
        throw new HttpRouteError(400, 'VALIDATION_ERROR', 'Validation failed.');
      }
      const eventLog = context.eventLog;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'urlIgnore', idempotencyKey, async () => {
        const body = objectRecord(await readBody(request)) ?? {};
        const rawReason = body['reason'];
        const reason =
          rawReason === 'noise' || rawReason === 'duplicate' || rawReason === 'private'
            ? rawReason
            : 'noise';
        const payload = {
          payloadVersion: 1 as const,
          canonicalUrl,
          reason,
        };
        const aggregateId = `url-ignored:${canonicalUrl}`;
        const accepted = await eventLog.appendClient({
          clientEventId: idempotencyKey,
          aggregateId,
          type: URL_IGNORED,
          payload,
          baseVector: await baseVectorForAggregate(eventLog, aggregateId),
        });
        invalidateResolveCaches();
        const { projection: postProjection } = await loadUrlProjection(context, eventLog);
        return [
          201,
          {
            data: {
              accepted,
              projection: serializeUrlProjection(postProjection),
            },
          },
        ];
      });
    },
  },
];
