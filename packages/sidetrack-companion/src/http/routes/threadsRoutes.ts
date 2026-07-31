// Thread routes: the per-URL thread-suggestion read (threadSuggestionRoutes)
// plus create/list/projection/markdown/export/archive/unarchive
// (threadsRoutesA).
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { loadAttributionV1State, titleForCanonicalUrl, titleForCanonicalUrlWithSource } from '../../attribution-v1/emit.js';
import { SqliteConnectionsStore } from '../../connections/snapshot.js';
import { loadEnrichmentLookup, lookupSynthesizedTitle } from '../../enrichment/titleEnrichment.js';
import { USER_FLOW_REJECTED, USER_ORGANIZED_ITEM } from '../../feedback/events.js';
import { canonicalizePageUrl } from '../../page-content/store.js';
import { tombstoneByThread as tombstoneByThreadRaw } from '../../recall/indexFile.js';
import type { EventLog } from '../../sync/eventLog.js';
import { guessLanesEnabled, type GuessLaneVoteSignals, voteSignalsFor } from '../../tabsession/guessLanes.js';
import { resolveThreadAttribution } from '../../tabsession/resolver.js';
import { THREAD_ARCHIVED, THREAD_UNARCHIVED, THREAD_UPSERTED } from '../../threads/events.js';
import { projectThread } from '../../threads/projection.js';
import { DEFAULT_SELF_NOMINATION_MIN_VISITS, evaluateThreadSelfNomination, type ThreadSelfNomination } from '../../threads/selfNomination.js';
import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload } from '../../timeline/events.js';
import { dayBucketFor } from '../../timeline/projection.js';
import { suggestionQuerySchema, threadUpsertSchema } from '../schemas.js';

import { HttpRouteError, RESOLVER_SIGNAL_EVENT_TYPES, connectionsGraphSig, loadUrlProjection, mutationResponse, objectRecord, readBody, readEventsFromStoreOrLog, readVaultMarkdown, recallIndexPath, requireVaultRoot, requireWorkstreamTrust } from '../routeSupport.js';
import type { CompanionHttpConfig, RouteDefinition } from '../routeSupport.js';

interface ThreadSuggestionTarget {
  readonly threadId: string;
  readonly providerThreadId?: string;
  readonly threadUrl?: string;
}

const readThreadSuggestionTarget = async (
  vaultRoot: string,
  requestedThreadId: string,
): Promise<ThreadSuggestionTarget> => {
  const root = join(vaultRoot, '_BAC', 'threads');
  const names = await readdir(root).catch(() => []);
  for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(await readFile(join(root, name), 'utf8')) as {
        readonly bac_id?: unknown;
        readonly threadId?: unknown;
        readonly threadUrl?: unknown;
      };
      const bacId = typeof parsed.bac_id === 'string' ? parsed.bac_id : undefined;
      const providerThreadId = typeof parsed.threadId === 'string' ? parsed.threadId : undefined;
      if (bacId === requestedThreadId || providerThreadId === requestedThreadId) {
        return {
          threadId: bacId ?? requestedThreadId,
          ...(providerThreadId === undefined ? {} : { providerThreadId }),
          ...(typeof parsed.threadUrl === 'string' ? { threadUrl: parsed.threadUrl } : {}),
        };
      }
    } catch {
      // Ignore malformed thread records.
    }
  }
  return { threadId: requestedThreadId };
};

// GET /v1/suggestions/thread/<id> is the dominant "consumer #2"
// (ground-truth request log: the sidepanel fires one fetch PER
// visible thread row on every render — observed ~1.3 req/s per
// thread, ~600ms each: readCurrent 14MB + readMerged whole log +
// resolveThreadAttribution graph PPR/sim/cluster, UNCACHED). Same
// fix: cache per (threadId, current.json stat, query). TTL bounds
// the event-log-derived attribution freshness (deliberately NOT
// keyed on event seq — that floods, see connections cache note);
// in-flight dedupe collapses the concurrent duplicate fetches the
// extension fires on re-render.
const THREAD_SUGGESTIONS_TTL_MS = ((): number => {
  const raw = process.env['SIDETRACK_THREAD_SUGGESTIONS_TTL_MS'];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
})();

interface ThreadSuggestionsCacheEntry {
  readonly result: readonly [number, unknown];
  readonly computedAtMs: number;
}

const threadSuggestionsCache = new Map<string, ThreadSuggestionsCacheEntry>();

const threadSuggestionsInFlight = new Map<string, Promise<readonly [number, unknown]>>();

const cachedThreadSuggestions = async (
  key: string,
  ttlMs: number,
  build: () => Promise<readonly [number, unknown]>,
): Promise<readonly [number, unknown]> => {
  const cached = threadSuggestionsCache.get(key);
  if (cached !== undefined && Date.now() - cached.computedAtMs < ttlMs) {
    return cached.result;
  }
  const inFlight = threadSuggestionsInFlight.get(key);
  if (inFlight !== undefined) return inFlight;
  const compute = (async (): Promise<readonly [number, unknown]> => {
    try {
      const result = await build();
      if (result[0] === 200) {
        threadSuggestionsCache.set(key, { result, computedAtMs: Date.now() });
        if (threadSuggestionsCache.size > 64) {
          const now = Date.now();
          for (const [k, v] of threadSuggestionsCache) {
            if (now - v.computedAtMs >= ttlMs) threadSuggestionsCache.delete(k);
          }
        }
      }
      return result;
    } finally {
      threadSuggestionsInFlight.delete(key);
    }
  })();
  threadSuggestionsInFlight.set(key, compute);
  return compute;
};

// Guess-lane vote signals (title/domain/recency) for a canonical URL, for the
// resolve routes that call the resolver DIRECTLY (thread suggestions,
// tab-session resolve) rather than through the armed URL resolver. Reuses the
// SAME memoized AttributionV1State the shadow/vote arm load — a warm memo is a
// single fs.stat — plus the O(nodes) title lookup. Returns undefined when guess
// lanes are off or there is no fresh state artifact (the vote lanes then report
// typed emptiness), so this is a cheap no-op on the flag-off / no-artifact path.
const guessLaneVoteSignalsForUrl = async (
  vaultRoot: string,
  snapshot: Parameters<typeof titleForCanonicalUrl>[0] | null,
  canonicalUrl: string | undefined,
  // Title-enrichment overlay (url kind) for this URL, resolved by the caller
  // from the folded lookup. Last-resort title fallback (titleForCanonicalUrl
  // applies it before returning undefined). undefined ⇒ prior behavior.
  synthesizedTitle?: string,
): Promise<GuessLaneVoteSignals | undefined> => {
  if (!guessLanesEnabled() || snapshot === null || canonicalUrl === undefined) return undefined;
  const state = await loadAttributionV1State(vaultRoot);
  if (state === null) return undefined;
  // Resolve the title AND its provenance so a match that rode on a SYNTHESIZED
  // (enrichment overlay) title marks the title lane with ' · synthesized title'.
  const resolved = titleForCanonicalUrlWithSource(snapshot, canonicalUrl, synthesizedTitle);
  const title = resolved?.title ?? null;
  return voteSignalsFor(state, canonicalUrl, title, resolved?.source === 'synthesized');
};

const readThreadWorkstreamId = async (
  vaultRoot: string,
  threadId: string,
): Promise<string | undefined> => {
  try {
    const parsed = JSON.parse(
      await readFile(join(vaultRoot, '_BAC', 'threads', `${threadId}.json`), 'utf8'),
    ) as { readonly primaryWorkstreamId?: unknown };
    return typeof parsed.primaryWorkstreamId === 'string' ? parsed.primaryWorkstreamId : undefined;
  } catch {
    return undefined;
  }
};

// Read the thread record fields the self-nomination signal needs
// (membership + title/provider for the suggested name). Keyed on the
// bac_id (`_BAC/threads/<bac_id>.json`), the same identity the resolver
// target carries. Best-effort: a missing / malformed record yields no
// membership and no title so the nomination degrades to ineligible.
const readThreadNominationRecord = async (
  vaultRoot: string,
  threadBacId: string,
): Promise<{
  readonly primaryWorkstreamId?: string;
  readonly title?: string;
  readonly provider?: string;
}> => {
  try {
    const parsed = JSON.parse(
      await readFile(join(vaultRoot, '_BAC', 'threads', `${threadBacId}.json`), 'utf8'),
    ) as {
      readonly primaryWorkstreamId?: unknown;
      readonly title?: unknown;
      readonly provider?: unknown;
    };
    return {
      ...(typeof parsed.primaryWorkstreamId === 'string'
        ? { primaryWorkstreamId: parsed.primaryWorkstreamId }
        : {}),
      ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
      ...(typeof parsed.provider === 'string' ? { provider: parsed.provider } : {}),
    };
  } catch {
    return {};
  }
};

// Env-tunable recurrence floor for thread self-nomination. Falls back
// to the domain default (3) when unset / non-numeric.
const threadSelfNominationMinVisits = (): number => {
  const raw = Number(process.env['SIDETRACK_THREAD_SELF_NOMINATION_MIN_VISITS']);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_SELF_NOMINATION_MIN_VISITS;
};

// Count how many distinct UTC calendar days a thread URL was visited,
// from `browser.timeline.observed` events (the same events that feed
// the URL projection's visitCount). Reads only that event type via the
// typed index — O(matching rows), not the whole log.
const distinctVisitDaysForUrl = async (
  context: CompanionHttpConfig,
  eventLog: EventLog,
  canonicalUrl: string,
): Promise<number> => {
  const events = await readEventsFromStoreOrLog(
    context,
    eventLog,
    (event) => {
      if (event.type !== BROWSER_TIMELINE_OBSERVED) return false;
      if (!isBrowserTimelineObservedPayload(event.payload)) return false;
      const key = event.payload.canonicalUrl ?? event.payload.url;
      return key === canonicalUrl;
    },
    [BROWSER_TIMELINE_OBSERVED],
  );
  const days = new Set<string>();
  for (const event of events) {
    if (!isBrowserTimelineObservedPayload(event.payload)) continue;
    days.add(dayBucketFor(event.payload.observedAt));
  }
  return days.size;
};

// Assemble the recurring-thread self-nomination block for the thread
// suggestions route. The expensive signals (URL projection lookup +
// distinct-day scan) are only computed when the cheap gates already
// point to eligibility — no suggestion survived the threshold AND the
// thread has no workstream home — so an already-organized or already-
// suggested thread costs nothing extra. Best-effort: any failure
// degrades to an ineligible block rather than failing the route.
const computeThreadSelfNomination = async (
  context: CompanionHttpConfig,
  eventLog: EventLog,
  vaultRoot: string,
  target: ThreadSuggestionTarget,
  hasSuggestionAboveThreshold: boolean,
): Promise<ThreadSelfNomination> => {
  const ineligible = (
    reason: ThreadSelfNomination['reason'],
    visitCount = 0,
    distinctDays = 0,
  ): ThreadSelfNomination => ({ eligible: false, visitCount, distinctDays, ...(reason ? { reason } : {}) });
  try {
    const record = await readThreadNominationRecord(vaultRoot, target.threadId);
    if (record.primaryWorkstreamId !== undefined) return ineligible('already-filed');
    if (hasSuggestionAboveThreshold) return ineligible('has-suggestion');
    if (target.threadUrl === undefined || target.threadUrl.length === 0) {
      return ineligible('below-visit-threshold');
    }
    let canonicalUrl: string;
    try {
      canonicalUrl = canonicalizePageUrl(target.threadUrl);
    } catch {
      canonicalUrl = target.threadUrl;
    }
    const { projection } = await loadUrlProjection(context, eventLog);
    const visitRecord = projection.byCanonicalUrl.get(canonicalUrl);
    const visitCount = visitRecord?.visitCount ?? 0;
    const isIgnored = visitRecord?.currentIgnored !== undefined;
    // Distinct-day scan is the one unbounded read; skip it unless the
    // visit count already clears the floor.
    const minVisits = threadSelfNominationMinVisits();
    const distinctDays =
      visitCount >= minVisits
        ? await distinctVisitDaysForUrl(context, eventLog, canonicalUrl)
        : 0;
    return evaluateThreadSelfNomination({
      title: record.title ?? '',
      ...(record.provider === undefined ? {} : { provider: record.provider }),
      visitCount,
      distinctDays,
      hasWorkstream: false,
      hasSuggestionAboveThreshold,
      isIgnored,
      minVisits,
    });
  } catch {
    return ineligible('below-visit-threshold');
  }
};

const parseThreadUpsertBody = async (vaultRoot: string, body: unknown) => {
  const full = threadUpsertSchema.safeParse(body);
  if (full.success) {
    return full.data;
  }
  const record = objectRecord(body);
  const bacId = record?.['bac_id'];
  if (typeof bacId !== 'string') {
    return threadUpsertSchema.parse(body);
  }
  const existing = objectRecord(
    JSON.parse(
      await readFile(join(vaultRoot, '_BAC', 'threads', `${bacId}.json`), 'utf8'),
    ) as unknown,
  );
  if (existing === undefined) {
    return threadUpsertSchema.parse(body);
  }
  const rawWorkstreamId = record?.['primaryWorkstreamId'];
  return threadUpsertSchema.parse({
    ...existing,
    bac_id: bacId,
    ...(rawWorkstreamId === null
      ? { primaryWorkstreamId: undefined }
      : typeof rawWorkstreamId === 'string'
        ? { primaryWorkstreamId: rawWorkstreamId }
        : {}),
    lastSeenAt:
      typeof existing['lastSeenAt'] === 'string'
        ? existing['lastSeenAt']
        : new Date().toISOString(),
    title: typeof existing['title'] === 'string' ? existing['title'] : bacId,
  });
};

export const threadSuggestionRoutes: readonly RouteDefinition[] = [
  {
    method: 'GET',
    pattern: /^\/v1\/suggestions\/thread\/(?<threadId>[A-Za-z0-9_-]+)$/,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      const vaultRoot = requireVaultRoot(context);
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
      if (match.threadId === undefined) {
        throw new Error('Missing threadId path parameter.');
      }
      // Capture the guard-narrowed values: TS narrowing from the
      // throws above does not carry into the cached builder closure.
      const threadId = match.threadId;
      const eventLog = context.eventLog;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const query = suggestionQuerySchema.parse({
        limit: url.searchParams.get('limit') ?? undefined,
        threshold: url.searchParams.get('threshold') ?? undefined,
      });
      const suggestionsCacheKey = `thread:${threadId}|${await connectionsGraphSig(
        context.connectionsStore,
        join(vaultRoot, '_BAC', 'connections', 'current.json'),
      )}|l=${String(query.limit)}|th=${String(query.threshold ?? '')}`;
      return cachedThreadSuggestions(
        suggestionsCacheKey,
        THREAD_SUGGESTIONS_TTL_MS,
        async (): Promise<readonly [number, unknown]> => {
          const target = await readThreadSuggestionTarget(vaultRoot, threadId);
          const snapshot =
            context.connectionsStore instanceof SqliteConnectionsStore
              ? await context.connectionsStore.readResolverSubgraphForThread(target)
              : await context.connectionsStore!.readCurrent();
          if (snapshot === null) {
            throw new HttpRouteError(
              409,
              'CONNECTIONS_SNAPSHOT_MISSING',
              'Connections snapshot is not ready.',
            );
          }
          // resolveThreadAttribution only consumes USER_FLOW_REJECTED /
          // USER_ORGANIZED_ITEM from `events` (same as the URL/tab-session
          // resolver), so read just those via the events_type_idx instead of
          // the whole log — this was the dominant cost of the per-thread
          // suggestion fan-out (readMerged whole log, 7-22s under load).
          const merged = await readEventsFromStoreOrLog(
            context,
            eventLog,
            (event) => event.type === USER_FLOW_REJECTED || event.type === USER_ORGANIZED_ITEM,
            RESOLVER_SIGNAL_EVENT_TYPES,
          );
          // Guess-lane vote signals (title/domain/recency) for the thread's own
          // URL, keyed off the memoized v1 state the shadow already loads. The
          // graph/similarity/topic lanes come from the resolver's own evidence;
          // these three fill the vote lanes so a graph-empty thread still shows
          // the title/domain/recency opinions instead of "No signal yet".
          const threadVoteSignals =
            target.threadUrl === undefined
              ? undefined
              : await guessLaneVoteSignalsForUrl(
                  vaultRoot,
                  snapshot,
                  target.threadUrl,
                  lookupSynthesizedTitle(
                    await loadEnrichmentLookup(vaultRoot, eventLog),
                    'url',
                    target.threadUrl,
                  ),
                );
          const resolution = resolveThreadAttribution({
            threadId: target.threadId,
            ...(target.providerThreadId === undefined
              ? {}
              : { providerThreadId: target.providerThreadId }),
            ...(target.threadUrl === undefined ? {} : { threadUrl: target.threadUrl }),
            snapshot,
            events: merged,
            ...(threadVoteSignals === undefined ? {} : { guessLaneVoteSignals: threadVoteSignals }),
          });
          // Compatibility route: callers still receive a ranked
          // Suggestion[] array, but the score now comes from the same
          // graph resolver used by URL/current-tab suggestions.
          const envThreshold = Number.parseFloat(process.env['SIDETRACK_SUGGEST_THRESHOLD'] ?? '');
          const defaultThreshold = Number.isFinite(envThreshold) ? envThreshold : 0.25;
          const threshold = query.threshold ?? defaultThreshold;
          const suggestions = resolution.fusedCandidates
            .map((candidate) => {
              const score = 1 / (1 + Math.exp(-candidate.rawFusionLogit));
              return {
                workstreamId: candidate.workstreamId,
                score,
                breakdown: {
                  ppr: candidate.pprScore,
                  similarity: candidate.simTopScore,
                  cluster: candidate.clusterPosterior,
                  corroboration: candidate.corroborationCount,
                  margin: resolution.decision.margin,
                },
                resolver: {
                  modelRevision: resolution.reasons.modelRevision,
                  graphRevision: resolution.reasons.graphRevision,
                  dominantSource: candidate.dominantSource,
                  action: resolution.decision.action,
                },
              };
            })
            .filter((suggestion) => suggestion.score >= threshold)
            .slice(0, query.limit);
          context.recallActivity?.recordSuggestion({
            threadId,
            resultCount: suggestions.length,
          });
          // Recurring-thread self-nomination: when the resolver
          // abstained (no candidate cleared the threshold) but the user
          // keeps returning to this thread, offer to start a workstream
          // from it instead of rendering a dead-end empty card. See
          // threads/selfNomination.ts for the eligibility policy.
          const selfNomination = await computeThreadSelfNomination(
            context,
            eventLog,
            vaultRoot,
            target,
            suggestions.length > 0,
          );
          // Guess lanes ride as a TOP-LEVEL field (alongside data +
          // selfNomination), not inside the Suggestion[] data array —
          // resolution.lanes is present iff SIDETRACK_GUESS_LANES is on.
          // The policy gate rides the same way: this compatibility route
          // projects Suggestion[] and never exposed the decision object, so
          // the panel's pipeline strip reads the gate top-level here (it
          // reads decision.gate on the URL/tab-session routes).
          return [
            200,
            {
              data: suggestions,
              selfNomination,
              ...(resolution.lanes === undefined ? {} : { lanes: resolution.lanes }),
              ...(resolution.decision.gate === undefined
                ? {}
                : { gate: resolution.decision.gate }),
            },
          ];
        },
      );
    },
  },
];

export const threadsRoutesA: readonly RouteDefinition[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/threads$/,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const input = await parseThreadUpsertBody(vaultRoot, await readBody(request));
      // Enforce trust for MCP-key callers regardless of the (voluntary,
      // now logging-only) tool header. A thread upsert that sets a
      // primaryWorkstreamId is a move; gate it on the DESTINATION
      // workstream.
      await requireWorkstreamTrust(
        context,
        request,
        input.primaryWorkstreamId,
        'sidetrack.threads.move',
      );
      // ALSO gate on the SOURCE workstream — the thread's CURRENT
      // primaryWorkstreamId — mirroring archive/unarchive which gate on
      // readThreadWorkstreamId. Without this, an mcp caller could steal a
      // thread OUT of an untrusted workstream (destination-only checks let
      // "move untrusted A → trusted B" and detach-to-null slip through with
      // zero source trust). A brand-new thread (no bac_id, nothing on disk)
      // has no source scope, so this is a no-op create. Detach (destination
      // null/absent) is still gated on the source here.
      if (input.bac_id !== undefined) {
        const sourceWorkstreamId = await readThreadWorkstreamId(vaultRoot, input.bac_id);
        if (sourceWorkstreamId !== undefined && sourceWorkstreamId !== input.primaryWorkstreamId) {
          await requireWorkstreamTrust(
            context,
            request,
            sourceWorkstreamId,
            'sidetrack.threads.move',
          );
        }
      }
      const result = await context.vaultWriter.upsertThread(input, requestId);
      // Mirror the upsert as a `thread.upserted` AcceptedEvent so
      // peers see thread state via sync. The legacy thread.json
      // write above is the immediate read source for callers that
      // don't yet consume the projection.
      if (context.eventLog !== undefined) {
        await context.eventLog
          .appendServerObserved({
            clientEventId: requestId,
            aggregateId: result.bac_id,
            type: THREAD_UPSERTED,
            payload: {
              bac_id: result.bac_id,
              provider: input.provider,
              threadUrl: input.threadUrl,
              title: input.title,
              lastSeenAt: input.lastSeenAt,
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(input.primaryWorkstreamId === undefined
                ? {}
                : { primaryWorkstreamId: input.primaryWorkstreamId }),
              ...(input.tags === undefined ? {} : { tags: input.tags }),
              ...(input.trackingMode === undefined ? {} : { trackingMode: input.trackingMode }),
            },
          })
          .catch(() => undefined);
      }
      return [200, mutationResponse(result, requestId)];
    },
  },
  {
    // List all chat threads: { data: [{ bac_id, title }] }. The panel's
    // enrichment worker + eval enumerate threads to select junk-titled
    // ones for on-device title synthesis; there was no GET list route
    // (only the per-thread projection/markdown ones), so the worker's
    // GET /v1/threads 404'd — caught live driving the WebGPU eval
    // (2026-07-27). Reads the same `_BAC/threads/*.json` records
    // buildSignals/readThreads already use; title/id only (no bodies —
    // callers fetch markdown per thread on demand).
    method: 'GET',
    pattern: /^\/v1\/threads$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const { readFile: readFileFs, readdir: readdirFs } = await import('node:fs/promises');
      const dir = join(vaultRoot, '_BAC', 'threads');
      const names = await readdirFs(dir).catch(() => [] as string[]);
      const records = await Promise.all(
        names
          .filter((name) => name.endsWith('.json'))
          .map(async (name) => {
            try {
              const parsed = JSON.parse(
                await readFileFs(join(dir, name), 'utf8'),
              ) as { readonly bac_id?: unknown; readonly title?: unknown; readonly deleted?: unknown };
              if (typeof parsed.bac_id !== 'string' || parsed.deleted === true) return null;
              return {
                bac_id: parsed.bac_id,
                title: typeof parsed.title === 'string' ? parsed.title : '',
              };
            } catch {
              return null;
            }
          }),
      );
      return [200, { data: records.filter((r): r is { bac_id: string; title: string } => r !== null) }];
    },
  },
  {
    // Read the causal projection for a thread. Optional: existing
    // callers continue to read `_BAC/threads/<bac_id>.json` via
    // markdown / list endpoints. This endpoint exposes register
    // status + conflict candidates so a side panel can render a
    // picker for two replicas that touched the same thread.
    method: 'GET',
    pattern: /^\/v1\/threads\/(?<bacId>[A-Za-z0-9_-]+)\/projection$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      if (context.eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'Event log is not configured on this companion.',
        );
      }
      const events = await context.eventLog.readByAggregate(match.bacId);
      const projection = projectThread(match.bacId, events);
      return [200, { data: projection }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/threads\/(?<bacId>[A-Za-z0-9_-]+)\/markdown$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      return [200, await readVaultMarkdown(requireVaultRoot(context), 'threads', match.bacId)];
    },
  },
  {
    // §13 step 13 — user-facing Markdown export of a single thread.
    // Same shape + atomic-write path as the workstream export. Normal
    // bridge-key route.
    method: 'POST',
    pattern: /^\/v1\/threads\/(?<bacId>[A-Za-z0-9_-]+)\/export$/,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      requireVaultRoot(context);
      const result = await context.vaultWriter.exportThread(match.bacId);
      return [200, { data: { files: [...result.files] } }];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/threads\/(?<bacId>[A-Za-z0-9_-]+)\/archive$/,
    authRequired: true,
    handle: async (_request, requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      const vaultRoot = requireVaultRoot(context);
      await requireWorkstreamTrust(
        context,
        _request,
        await readThreadWorkstreamId(vaultRoot, match.bacId),
        'sidetrack.threads.archive',
      );
      const result = await context.vaultWriter.archiveThread(match.bacId, requestId);
      // Mirror as a thread.archived event so peers see the status
      // change via sync. clientEventId is deterministic per
      // (replica, thread) so a duplicate archive call collapses on
      // the eventLog's idempotency check.
      if (context.eventLog !== undefined && context.replica !== undefined) {
        await context.eventLog
          .appendServerObserved({
            clientEventId: `thread-archive:${context.replica.replicaId}:${match.bacId}`,
            aggregateId: match.bacId,
            type: THREAD_ARCHIVED,
            payload: { bac_id: match.bacId },
          })
          .catch(() => undefined);
      }
      // Tombstone every recall index entry for this thread so
      // /v1/recall/query stops returning rows from archived threads.
      // OR-Set semantics: rows stay on disk with tombstoned=true; a
      // future replica merging an older un-archived write won't
      // resurrect them. Best-effort — a missing index file is a
      // benign no-op (tombstoneByThread returns 0).
      const lifecycle = context.recallLifecycle;
      const tombstoneByThread =
        lifecycle === undefined
          ? (threadId: string) => tombstoneByThreadRaw(recallIndexPath(vaultRoot), threadId)
          : (threadId: string) => lifecycle.tombstoneByThread(threadId);
      await tombstoneByThread(match.bacId).catch(() => {
        /* index optional; archive succeeds regardless */
      });
      return [200, mutationResponse(result, requestId)];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/threads\/(?<bacId>[A-Za-z0-9_-]+)\/unarchive$/,
    authRequired: true,
    handle: async (_request, requestId, match, context) => {
      if (match.bacId === undefined) {
        throw new Error('Missing bacId path parameter.');
      }
      await requireWorkstreamTrust(
        context,
        _request,
        await readThreadWorkstreamId(requireVaultRoot(context), match.bacId),
        'sidetrack.threads.unarchive',
      );
      const result = await context.vaultWriter.unarchiveThread(match.bacId, requestId);
      if (context.eventLog !== undefined && context.replica !== undefined) {
        await context.eventLog
          .appendServerObserved({
            clientEventId: `thread-unarchive:${context.replica.replicaId}:${match.bacId}:${requestId}`,
            aggregateId: match.bacId,
            type: THREAD_UNARCHIVED,
            payload: { bac_id: match.bacId },
          })
          .catch(() => undefined);
      }
      // We deliberately do NOT clear the recall-index tombstones on
      // unarchive — an OR-Set tombstone is permanent (the lifecycle's
      // incremental indexer will write fresh, untombstoned rows for
      // any new captures on this thread).
      return [200, mutationResponse(result, requestId)];
    },
  },
];
