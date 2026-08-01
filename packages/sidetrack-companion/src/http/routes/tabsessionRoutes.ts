// Tab-session routes: projection, inbox, and the per-tab-session
// resolve/attribute endpoints.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { join } from 'node:path';

import { loadAttributionV1State } from '../../attribution-v1/emit.js';
import { SqliteConnectionsStore } from '../../connections/snapshot.js';
import { USER_FLOW_REJECTED, USER_ORGANIZED_ITEM, isUserFlowRejectedPayload, isUserOrganizedItemPayload } from '../../feedback/events.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import type { EventLog } from '../../sync/eventLog.js';
import { eventStoreCoverageToken, getSharedEventStoreServeStale } from '../../sync/eventStore.js';
import { autoApplyTabSessionAttribution } from '../../tabsession/autoApply.js';
import { guessLanesEnabled, type GuessLaneVoteSignals, voteSignalsFor } from '../../tabsession/guessLanes.js';
import { createEmptyTabSessionProjectionAccumulator, deserializeTabSessionProjection, foldEventIntoTabSessionProjectionAccumulator, projectTabSessions, serializeTabSessionProjection, tabSessionInbox, tabSessionProjectionFromAccumulator, type TabSessionProjection } from '../../tabsession/projection.js';
import { resolveAttribution } from '../../tabsession/resolver.js';
import { overlayUrlAttributionOntoTabSessions } from '../../tabsession/urlAttributionOverlay.js';
import { deserializeUrlProjection } from '../../urls/projection.js';

import { HttpRouteError, RESOLVER_SIGNAL_EVENT_TYPES, aggregateIdForFeedbackEvent, baseVectorForAggregate, connectionsGraphSig, invalidateResolveCaches, objectRecord, optionalAttributionPolicyMode, optionalAttributionPolicyTelemetry, projectUrlsFromStoreOrLog, readBody, readEventsFromStoreOrLog, requireIdempotencyKey, requireVaultRoot, runIdempotent, serveResolveSwr } from '../routeSupport.js';
import type { CompanionHttpConfig, RouteDefinition } from '../routeSupport.js';

const resolverSignalEventsForTabSession = (
  events: readonly AcceptedEvent[],
  tabSessionId: string,
): readonly AcceptedEvent[] =>
  events.filter((event) => {
    if (event.type === USER_FLOW_REJECTED && isUserFlowRejectedPayload(event.payload)) {
      return true;
    }
    if (event.type !== USER_ORGANIZED_ITEM || !isUserOrganizedItemPayload(event.payload)) {
      return false;
    }
    return event.payload.itemKind === 'tab-session' && event.payload.itemId === tabSessionId;
  });

const tabSessionProjectionCache = new Map<string, { sig: string; proj: TabSessionProjection }>();

const projectTabSessionsFromStoreOrLog = async (
  context: CompanionHttpConfig,
  eventLog: EventLog,
): Promise<TabSessionProjection> => {
  const key = context.vaultRoot ?? '<none>';
  // Serve-stale + watermark-keyed memo: no route awaits a catch-up pass, and
  // a stale fold must be cached under the store's OWN coverage token — never
  // under logSignature(), which advances on appends the fold never saw (the
  // memo-poisoning shape). Log-fallback path keeps the log signature.
  const store =
    context.vaultRoot === undefined
      ? null
      : await getSharedEventStoreServeStale(context.vaultRoot);
  const sig = store === null ? await eventLog.logSignature() : eventStoreCoverageToken(store);
  const cached = tabSessionProjectionCache.get(key);
  if (cached !== undefined && cached.sig === sig) return cached.proj;
  let proj: TabSessionProjection;
  if (store === null) {
    proj = projectTabSessions(await eventLog.readMerged());
  } else {
    const accumulator = createEmptyTabSessionProjectionAccumulator();
    await store.forEachChunk((chunk) => {
      for (const event of chunk) foldEventIntoTabSessionProjectionAccumulator(accumulator, event);
    }, 2000);
    proj = tabSessionProjectionFromAccumulator(accumulator);
  }
  tabSessionProjectionCache.set(key, { sig, proj });
  return proj;
};

const loadTabSessionProjection = async (
  context: CompanionHttpConfig,
  eventLog: EventLog,
): Promise<{ projection: TabSessionProjection; snapshotRevision: string | null }> => {
  if (context.connectionsStore instanceof SqliteConnectionsStore) {
    const metadata = await context.connectionsStore.readSnapshotMetadata();
    if (metadata?.tabSessionProjection !== undefined && metadata.urlProjection !== undefined) {
      return {
        projection: overlayUrlAttributionOntoTabSessions(
          deserializeTabSessionProjection(metadata.tabSessionProjection),
          deserializeUrlProjection(metadata.urlProjection),
        ),
        snapshotRevision: metadata.snapshotRevision ?? null,
      };
    }
  }
  const snapshot = await context.connectionsStore?.readCurrent();
  const snapshotRevision = snapshot?.snapshotRevision ?? null;
  const tab =
    snapshot?.tabSessionProjection !== undefined
      ? deserializeTabSessionProjection(snapshot.tabSessionProjection)
      : await projectTabSessionsFromStoreOrLog(context, eventLog);
  // Same snapshot's URL projection (no extra re-fold in steady state) —
  // a chat thread the user filed via the Current-tab card is a URL
  // attribution; overlay it so All-threads / inbox / the resolver stop
  // re-asking. Single seam → every tab-session consumer is consistent.
  const url =
    snapshot?.urlProjection !== undefined
      ? deserializeUrlProjection(snapshot.urlProjection)
      : await projectUrlsFromStoreOrLog(context, eventLog);
  return {
    projection: overlayUrlAttributionOntoTabSessions(tab, url),
    snapshotRevision,
  };
};

export const tabsessionRoutes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/tabsessions\/projection$/u,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const { projection, snapshotRevision } = await loadTabSessionProjection(
        context,
        context.eventLog,
      );
      return [
        200,
        {
          // PR #141 added a single-flight+TTL cache for this route;
          // Stage 5.2 R2 supersedes it with snapshot-first reads via
          // loadTabSessionProjection (same goal, architecturally aligned
          // with the W2 accumulator wiring).
          data: serializeTabSessionProjection(projection),
          ...(snapshotRevision === null ? {} : { snapshotRevision }),
        },
      ];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/tabsessions\/inbox$/u,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const url = new URL(request.url ?? '/v1/tabsessions/inbox', 'http://internal');
      const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
      const offsetRaw = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
      const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
      const { projection, snapshotRevision } = await loadTabSessionProjection(
        context,
        context.eventLog,
      );
      const items = tabSessionInbox(projection, { limit, offset });
      return [
        200,
        {
          data: {
            items,
            total: tabSessionInbox(projection, { limit: Number.MAX_SAFE_INTEGER, offset: 0 })
              .length,
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
    pattern: /^\/v1\/tabsessions\/(?<tabSessionId>[^/]+)\/resolve$/u,
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
      const url = new URL(request.url ?? '/v1/tabsessions/resolve', 'http://internal');
      if (url.searchParams.get('dryRun') !== 'true') {
        throw new HttpRouteError(
          400,
          'VALIDATION_ERROR',
          'Validation failed.',
          'Tab-session resolver is dry-run only in this phase.',
        );
      }
      // SWR serve-key is per tab-session + query only (NOT graph-sig): the
      // sig is checked separately so a drain serves the stale entry instantly
      // and refreshes THIS key in the background instead of evicting.
      const tabResKey = `tabres:${decodeURIComponent(match.tabSessionId ?? '')}|${url.search}`;
      const graphSig = await connectionsGraphSig(
        context.connectionsStore,
        join(requireVaultRoot(context), '_BAC', 'connections', 'current.json'),
      );
      return serveResolveSwr(
        tabResKey,
        graphSig,
        async (): Promise<readonly [number, unknown]> => {
          const tabSessionId = decodeURIComponent(match.tabSessionId ?? '');
          const usesSqliteSubgraph = context.connectionsStore instanceof SqliteConnectionsStore;
          const snapshot =
            usesSqliteSubgraph
              ? await context.connectionsStore.readResolverSubgraphForTabSession(tabSessionId)
              : await context.connectionsStore!.readCurrent();
          if (snapshot === null) {
            throw new HttpRouteError(
              409,
              'CONNECTIONS_SNAPSHOT_MISSING',
              'Connections snapshot is not ready.',
            );
          }
          const resolverEvents = usesSqliteSubgraph
            ? await readEventsFromStoreOrLog(
                context,
                context.eventLog!,
                (event) => resolverSignalEventsForTabSession([event], tabSessionId).length > 0,
                RESOLVER_SIGNAL_EVENT_TYPES,
              )
            : await context.eventLog!.readMerged();
          // Stage 5.2 R2 — snapshot-first via loadTabSessionProjection.
          const { projection } = await loadTabSessionProjection(context, context.eventLog!);
          const sessionRecord = projection.bySessionId.get(tabSessionId);
          if (sessionRecord === undefined) {
            throw new HttpRouteError(404, 'TAB_SESSION_NOT_FOUND', 'Tab session was not found.');
          }
          // Guess-lane vote signals for the session's latest URL/title (its most
          // representative page). Fills the title/domain/recency lanes; the
          // graph lanes come from the resolver's own evidence. Absent latest URL
          // ⇒ those three lanes report typed emptiness.
          const tabVoteSignals =
            guessLanesEnabled() && sessionRecord.latestUrl !== undefined
              ? await (async (): Promise<GuessLaneVoteSignals | undefined> => {
                  const state = await loadAttributionV1State(requireVaultRoot(context));
                  return state === null
                    ? undefined
                    : voteSignalsFor(
                        state,
                        sessionRecord.latestUrl!,
                        sessionRecord.latestTitle ?? null,
                      );
                })()
              : undefined;
          return [
            200,
            {
              data: resolveAttribution({
                tabSessionId,
                snapshot,
                projection,
                events: resolverEvents,
                ...(usesSqliteSubgraph ? { useEventCandidateSimilarity: false } : {}),
                ...(tabVoteSignals === undefined ? {} : { guessLaneVoteSignals: tabVoteSignals }),
              }),
              ...(snapshot.snapshotRevision === undefined
                ? {}
                : { snapshotRevision: snapshot.snapshotRevision }),
            },
          ];
        },
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/tabsessions\/(?<tabSessionId>[^/]+)\/resolve$/u,
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
      return await runIdempotent(
        context,
        'tabSessionResolveAutoApply',
        idempotencyKey,
        async () => {
          const body = objectRecord(await readBody(request)) ?? {};
          if (body['dryRun'] !== false) {
            throw new HttpRouteError(
              400,
              'VALIDATION_ERROR',
              'Validation failed.',
              'Body must set dryRun:false for auto-apply.',
            );
          }
          const tabSessionId = decodeURIComponent(match.tabSessionId ?? '');
          const usesSqliteSubgraph = connectionsStore instanceof SqliteConnectionsStore;
          const snapshot =
            usesSqliteSubgraph
              ? await connectionsStore.readResolverSubgraphForTabSession(tabSessionId)
              : await connectionsStore.readCurrent();
          if (snapshot === null) {
            throw new HttpRouteError(
              409,
              'CONNECTIONS_SNAPSHOT_MISSING',
              'Connections snapshot is not ready.',
            );
          }
          // Stage 5.2 R4 — stale-snapshot guard. Auto-apply mutates
          // attribution state; the caller MUST act on a fresh-enough
          // snapshot. If a `dependencyKey` is supplied and it doesn't
          // match the current snapshotRevision, reject with 409. Stale
          // suggestions are fine; stale mutations are not.
          const dependencyKey = body['dependencyKey'];
          if (
            typeof dependencyKey === 'string' &&
            snapshot.snapshotRevision !== undefined &&
            dependencyKey !== snapshot.snapshotRevision
          ) {
            throw new HttpRouteError(
              409,
              'STALE_SNAPSHOT',
              'Caller-supplied dependencyKey is stale.',
              `Expected snapshotRevision=${snapshot.snapshotRevision}; client sent dependencyKey=${dependencyKey}. Re-fetch the resolve dry-run and retry.`,
            );
          }
          // Stage 5.2 R2 — snapshot-first via loadTabSessionProjection;
          // the event-log fallback covers a snapshot loaded from disk that
          // was produced before R1 (no embedded projection).
          const { projection } = await loadTabSessionProjection(context, eventLog);
          if (!projection.bySessionId.has(tabSessionId)) {
            throw new HttpRouteError(404, 'TAB_SESSION_NOT_FOUND', 'Tab session was not found.');
          }
          const resolverEvents = usesSqliteSubgraph
            ? await readEventsFromStoreOrLog(
                context,
                eventLog,
                (event) => resolverSignalEventsForTabSession([event], tabSessionId).length > 0,
                RESOLVER_SIGNAL_EVENT_TYPES,
              )
            : await eventLog.readMerged();
          const policyMode = optionalAttributionPolicyMode(body['policyMode'], 'policyMode');
          const policyTelemetry = optionalAttributionPolicyTelemetry(
            body['policyTelemetry'],
            'policyTelemetry',
          );
          const result = await autoApplyTabSessionAttribution({
            eventLog,
            snapshot,
            tabSessionId,
            events: resolverEvents,
            ...(context.vaultRoot === undefined ? {} : { vaultRoot: context.vaultRoot }),
            ...(usesSqliteSubgraph ? { useEventCandidateSimilarity: false } : {}),
            ...(policyMode === undefined ? {} : { policyMode }),
            ...(policyTelemetry === undefined ? {} : { policyTelemetry }),
          });
          // PR #141 invalidated the TTL cache here; Stage 5.2 R2 reads
          // from the snapshot store so no manual invalidation is needed
          // (the materializer's next drain publishes the fresh snapshot).
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
        },
      );
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/tabsessions\/(?<tabSessionId>[^/]+)\/attribute$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const tabSessionId = decodeURIComponent(match.tabSessionId ?? '');
      if (tabSessionId.length === 0) {
        throw new HttpRouteError(400, 'VALIDATION_ERROR', 'Validation failed.');
      }
      const eventLog = context.eventLog;
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'tabSessionAttribute', idempotencyKey, async () => {
        const body = objectRecord(await readBody(request));
        const workstreamId = body?.['workstreamId'];
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
        // Stage 5.2 R5 — pre-write reads prior attribution from snapshot
        // (cheap); post-write goes through the same loadTabSessionProjection
        // helper, which prefers the snapshot's embedded projection over a
        // full event-log re-projection. Read-your-writes is preserved
        // because the materializer's drain debounce (250ms) typically
        // publishes the new snapshot before the panel re-reads; when it
        // hasn't, the helper's event-log fallback covers the gap. Half 2's
        // W2 will upgrade this to a true row-local fold.
        const { projection: priorProjection } = await loadTabSessionProjection(context, eventLog);
        const fromWorkstreamId =
          priorProjection.bySessionId.get(tabSessionId)?.currentAttribution?.workstreamId;
        const payload = {
          payloadVersion: 1,
          itemKind: 'tab-session',
          itemId: tabSessionId,
          action: 'move',
          ...(fromWorkstreamId === undefined || fromWorkstreamId === null
            ? {}
            : { fromContainer: fromWorkstreamId }),
          toContainer: workstreamId,
        } as const;
        const aggregateId = aggregateIdForFeedbackEvent(USER_ORGANIZED_ITEM, payload);
        const accepted = await eventLog.appendClient({
          clientEventId: idempotencyKey,
          aggregateId,
          type: USER_ORGANIZED_ITEM,
          payload,
          baseVector: await baseVectorForAggregate(eventLog, aggregateId),
        });
        invalidateResolveCaches();
        // Stage 5.2 R5 — post-write response goes through the
        // snapshot-first helper so we don't pay a full event-log
        // re-projection when the materializer has already published
        // the next snapshot. Falls back to the event log only when the
        // snapshot is null or pre-R1. (PR #141's
        // invalidateCachedTabSessionProjection was a TTL cache buster
        // that R2/R5 makes redundant.)
        const { projection: postProjection } = await loadTabSessionProjection(context, eventLog);
        return [
          201,
          {
            data: {
              accepted,
              projection: serializeTabSessionProjection(postProjection),
            },
          },
        ];
      });
    },
  },
];
