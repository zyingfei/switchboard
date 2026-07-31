// Connections routes: ranker retrain, impression-bootstrap, the graph read,
// node-neighbors, edge read, and path-finding.
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { applyFeedbackOverlayToSnapshot } from '../../connections/feedbackOverlay.js';
import { SqliteConnectionsStore, type ConnectionsStore } from '../../connections/snapshot.js';
import { overlayTopicRevisionOnSnapshot } from '../../connections/topicSnapshotOverlay.js';
import { USER_FLOW_CONFIRMED, USER_FLOW_REJECTED, USER_ORGANIZED_ITEM, USER_SNIPPET_PROMOTED } from '../../feedback/events.js';
import { projectFeedback } from '../../feedback/projection.js';
import { canonicalizePageUrl, readPageContentCoverageMap } from '../../page-content/store.js';
import type { DomainTombstoneSet } from '../../privacy/domainTombstone.js';
import { createTopicRevisionStore } from '../../producers/topic-revision.js';
import { runRecallImpressionBootstrap } from '../../ranker/impressionBootstrap.js';
import { maybeRetrainClosestVisitRanker, runMaybeRetrainInWorker } from '../../ranker/retrain.js';
import { runRecallWithShadow as runRecallV2 } from '../../recall-v2/pipeline.js';

import { FEEDBACK_EVENT_TYPE_LIST, HttpRouteError, RANKER_BOOTSTRAP_FEEDBACK_EVENT_TYPES, connectionsGraphSig, domainTombstoneSetFor, isFeedbackEventType, objectRecord, readBody, readEventsFromStoreOrLog, requireVaultRoot } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

// Does a connections node belong to a tombstoned domain? Matches on the
// node's URL metadata; falls back to a `timeline-visit:<canonicalUrl>`
// id when metadata is bare (that id convention encodes the URL).
const connectionNodeIsTombstoned = (
  node: {
    readonly id: string;
    readonly label?: string;
    readonly metadata?: { readonly url?: unknown; readonly canonicalUrl?: unknown; readonly title?: unknown };
  },
  tombstones: DomainTombstoneSet,
): boolean => {
  const meta = node.metadata ?? {};
  const url =
    typeof meta.canonicalUrl === 'string'
      ? meta.canonicalUrl
      : typeof meta.url === 'string'
        ? meta.url
        : node.id.startsWith('timeline-visit:')
          ? node.id.slice('timeline-visit:'.length)
          : undefined;
  if (url === undefined) return false;
  const title = typeof meta.title === 'string' ? meta.title : node.label;
  return tombstones.matchesPage({ url, ...(title === undefined ? {} : { title }) });
};

// Filter a served /v1/connections result envelope: drop nodes on a
// tombstoned domain and any edge touching a dropped node. Returns the
// input unchanged when nothing matches (cheap common case).
const excludeTombstonedNodesFromConnectionsResult = (
  result: readonly [number, unknown],
  tombstones: DomainTombstoneSet,
): readonly [number, unknown] => {
  if (tombstones.isEmpty) return result;
  const [status, body] = result;
  if (typeof body !== 'object' || body === null) return result;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return result;
  const snapshot = (data as { snapshot?: unknown }).snapshot;
  if (typeof snapshot !== 'object' || snapshot === null) return result;
  const snap = snapshot as {
    nodes?: unknown;
    edges?: unknown;
    nodeCount?: number;
    edgeCount?: number;
  };
  if (!Array.isArray(snap.nodes)) return result;
  const nodes = snap.nodes as { id: string; label?: string; metadata?: Record<string, unknown> }[];
  const droppedIds = new Set<string>();
  const keptNodes = nodes.filter((node) => {
    if (connectionNodeIsTombstoned(node, tombstones)) {
      droppedIds.add(node.id);
      return false;
    }
    return true;
  });
  if (droppedIds.size === 0) return result;
  const edges = Array.isArray(snap.edges)
    ? (snap.edges as { fromNodeId?: string; toNodeId?: string }[]).filter(
        (edge) =>
          !droppedIds.has(edge.fromNodeId ?? '') && !droppedIds.has(edge.toNodeId ?? ''),
      )
    : snap.edges;
  const nextSnapshot = {
    ...snapshot,
    nodes: keptNodes,
    edges,
    nodeCount: keptNodes.length,
    ...(Array.isArray(edges) ? { edgeCount: edges.length } : {}),
  };
  return [status, { ...(body as object), data: { ...(data as object), snapshot: nextSnapshot } }];
};

// Loose URL-shape check: rejects strings that won't parse as a URL
// before we hand them to `canonicalizePageUrl` (which throws). The
// concrete defect that surfaced this in dogfood: some materializer
// path emitted `timeline-visit` nodes whose id was the visit instance
// id (`timeline-visit:visit_<ts>_<hash>`) with no `metadata.canonicalUrl`,
// so the existing "slice off the prefix" fallback returned the visit
// id itself — which `new URL(...)` rejects with ERR_INVALID_URL,
// 500-ing the whole /v1/connections endpoint.
const looksLikeUrl = (s: string): boolean => {
  if (s.length === 0) return false;
  // Require a scheme separator. Everything we actually want here
  // (http, https, chrome-extension, file, about, moz-extension, …)
  // has `://` or `:`; `visit_<ts>_<hash>` has neither.
  return s.includes('://') || /^[a-z][a-z0-9+.-]*:/i.test(s);
};

const deriveTimelineVisitUrl = (node: {
  readonly id: string;
  readonly metadata: { readonly canonicalUrl?: unknown };
}): string | undefined => {
  const fromMeta = node.metadata.canonicalUrl;
  if (typeof fromMeta === 'string' && looksLikeUrl(fromMeta)) return fromMeta;
  if (node.id.startsWith('timeline-visit:')) {
    const sliced = node.id.slice('timeline-visit:'.length);
    if (looksLikeUrl(sliced)) return sliced;
  }
  return undefined;
};

const applyPageContentCoverageToSnapshot = async (
  vaultRoot: string,
  snapshot: import('../../connections/snapshot.js').ConnectionsSnapshot,
): Promise<import('../../connections/snapshot.js').ConnectionsSnapshot> => {
  const timelineUrls = snapshot.nodes
    .filter((node) => node.kind === 'timeline-visit')
    .map((node) => deriveTimelineVisitUrl(node) ?? '')
    .filter((url) => url.length > 0);
  if (timelineUrls.length === 0) return snapshot;
  const coverageByUrl = await readPageContentCoverageMap(vaultRoot, timelineUrls);
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => {
      if (node.kind !== 'timeline-visit') return node;
      const canonicalUrl = deriveTimelineVisitUrl(node);
      if (canonicalUrl === undefined) return node;
      const coverage = coverageByUrl.get(canonicalizePageUrl(canonicalUrl));
      if (coverage === undefined) return node;
      return {
        ...node,
        metadata: {
          ...node.metadata,
          pageContent: {
            state: coverage.state,
            ...(coverage.quality === undefined ? {} : { quality: coverage.quality }),
            ...(coverage.lastIndexedAt === undefined
              ? {}
              : { lastIndexedAt: coverage.lastIndexedAt }),
            ...(coverage.extractionSource === undefined
              ? {}
              : { extractionSource: coverage.extractionSource }),
            ...(coverage.chunkCount === undefined ? {} : { chunkCount: coverage.chunkCount }),
            ...(coverage.indexedCharCount === undefined
              ? {}
              : { indexedCharCount: coverage.indexedCharCount }),
            ...(coverage.error === undefined ? {} : { error: coverage.error }),
          },
        },
      };
    }),
  };
};

const trimTrailingUrlSlash = (value: string): string =>
  value.length > 0 ? value.replace(/\/+$/u, '') : value;

const metadataString = (
  metadata: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
};

const addNodeAnchorAlias = (
  aliases: Map<string, string>,
  alias: string | undefined,
  targetNodeId: string,
): void => {
  if (alias === undefined || alias.length === 0) return;
  if (!aliases.has(alias)) aliases.set(alias, targetNodeId);
  const trimmed = trimTrailingUrlSlash(alias);
  if (trimmed.length > 0 && !aliases.has(trimmed)) aliases.set(trimmed, targetNodeId);
};

const resolveConnectionsNodeId = (
  snapshot: import('../../connections/snapshot.js').ConnectionsSnapshot,
  nodeId: string,
): string => {
  if (snapshot.nodes.some((node) => node.id === nodeId)) return nodeId;

  const aliases = new Map<string, string>();
  for (const node of snapshot.nodes) {
    addNodeAnchorAlias(aliases, node.id, node.id);
    const canonicalUrl = metadataString(node.metadata, ['canonicalUrl', 'url', 'latestUrl']);
    if (canonicalUrl !== undefined) {
      if (node.kind === 'timeline-visit') {
        addNodeAnchorAlias(aliases, `timeline-visit:${canonicalUrl}`, node.id);
        addNodeAnchorAlias(aliases, canonicalUrl, node.id);
      }
    }
    addNodeAnchorAlias(aliases, metadataString(node.metadata, ['timelineVisitId']), node.id);
  }

  return aliases.get(nodeId) ?? aliases.get(trimTrailingUrlSlash(nodeId)) ?? nodeId;
};

// GET /v1/connections rebuilds a ~14MB response per call: readCurrent
// (14MB) + readMerged (whole event log → feedback overlay) +
// applyPageContentCoverage + JSON-serialize ~14MB — UNCACHED,
// measured ~1.5-2.7s/call. The extension's connections view polls it
// across (observed) 6+ stacked sockets ⇒ a pinned core (the second,
// non-connections CPU runaway, "consumer #2"). current.json is
// stable under the W1c drain floor and the event log only advances
// on the extension's ~1/min flush, so a CHEAP fingerprint —
// current.json + shadow file stat (mtime+size) + replica.peekSeq()
// (cheap in-memory event-log version, the only thing the feedback
// overlay depends on) + the query string — hits constantly between
// flushes. A TTL ceiling bounds any fingerprint miss; in-flight
// dedupe collapses the concurrent polls into one compute.
const CONNECTIONS_RESPONSE_TTL_MS = ((): number => {
  const raw = process.env['SIDETRACK_CONNECTIONS_RESPONSE_TTL_MS'];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
})();

interface ConnectionsResponseCacheEntry {
  readonly result: readonly [number, unknown];
  readonly etag: string;
  readonly computedAtMs: number;
}

const connectionsResponseCache = new Map<string, ConnectionsResponseCacheEntry>();

const connectionsResponseInFlight = new Map<string, Promise<readonly [number, unknown]>>();

const connectionsResponseGraphKey = (key: string): string => key.split('|q=', 1)[0] ?? key;

const pruneConnectionsResponseCacheForGraph = (key: string): void => {
  const graphKey = connectionsResponseGraphKey(key);
  for (const cachedKey of connectionsResponseCache.keys()) {
    if (connectionsResponseGraphKey(cachedKey) !== graphKey) {
      connectionsResponseCache.delete(cachedKey);
    }
  }
};

const statSig = async (path: string): Promise<string> => {
  try {
    const s = await stat(path);
    return `${String(s.mtimeMs)}:${String(s.size)}`;
  } catch {
    return 'absent';
  }
};

// NOTE: deliberately NOT keyed on replica.peekSeq()/event-log
// position. The feedback + page-content overlays do depend on the
// event log, but it advances on EVERY extension event flush (~1/min
// of edge events, many per flush), so a seq-keyed cache never hits
// under the real workload (validated: 0 hits, CPU unchanged). Key
// only on what makes the GRAPH change — current.json (W1c-floored,
// so stable between drains) + the shadow revision file + the query.
// The overlays' freshness is bounded by CONNECTIONS_RESPONSE_TTL_MS
// instead: graph structure is exact, contextual overlays are
// ≤TTL stale. Consistent with the W2b "connections is contextual,
// not user-immediate-feedback; staleness is acceptable" stance.
const connectionsResponseCacheKey = async (
  store: ConnectionsStore,
  vaultRoot: string,
  querySearch: string,
): Promise<string> => {
  const root = join(vaultRoot, '_BAC', 'connections');
  const [cur, shadow] = await Promise.all([
    connectionsGraphSig(store, join(root, 'current.json')),
    statSig(join(root, 'topics', 'current.shadow.json')),
  ]);
  return `cur=${cur}|shadow=${shadow}|q=${querySearch}`;
};

// Stable short ETag derived from the (already collision-resistant)
// cache key. Exposed for HTTP If-None-Match → 304 (staged separately).
const connectionsResponseEtag = (key: string): string =>
  `"c-${createHash('sha256').update(key).digest('hex').slice(0, 16)}"`;

const cachedConnectionsResponse = async (
  key: string,
  ttlMs: number,
  build: () => Promise<readonly [number, unknown]>,
): Promise<{ result: readonly [number, unknown]; etag: string }> => {
  const cached = connectionsResponseCache.get(key);
  if (cached !== undefined && Date.now() - cached.computedAtMs < ttlMs) {
    return { result: cached.result, etag: cached.etag };
  }
  const inFlight = connectionsResponseInFlight.get(key);
  if (inFlight !== undefined) {
    return { result: await inFlight, etag: connectionsResponseEtag(key) };
  }
  // Each cached /v1/connections response holds its nodes/edges arrays,
  // which in turn keep that revision's materialized graph alive. Once a
  // newer graph key is requested, drop older revision responses before
  // build() calls readCurrent() and allocates the replacement snapshot.
  pruneConnectionsResponseCacheForGraph(key);
  const compute = (async (): Promise<readonly [number, unknown]> => {
    try {
      const result = await build();
      // Only pin successful full-snapshot responses; errors/empties
      // are cheap and must not be cached.
      if (result[0] === 200) {
        connectionsResponseCache.set(key, {
          result,
          etag: connectionsResponseEtag(key),
          computedAtMs: Date.now(),
        });
        // Bound resident memory: each cached response pins that revision's
        // full filtered nodes/edges arrays (~14MB). First drop expired
        // entries, then HARD-cap the count by evicting the oldest (by
        // compute time). The cache is a pure memo keyed on revision+query,
        // so a re-computed variant returns byte-identical output — eviction
        // can only change hit rate, never bytes. Caps the worst-case
        // resident set at ~N×fullGraph instead of 16×.
        const MAX_CONNECTIONS_RESPONSE_CACHE = 4;
        const now = Date.now();
        for (const [k, v] of connectionsResponseCache) {
          if (now - v.computedAtMs >= ttlMs) connectionsResponseCache.delete(k);
        }
        if (connectionsResponseCache.size > MAX_CONNECTIONS_RESPONSE_CACHE) {
          const oldestFirst = [...connectionsResponseCache.entries()].sort(
            (a, b) => a[1].computedAtMs - b[1].computedAtMs,
          );
          for (const [k] of oldestFirst.slice(
            0,
            oldestFirst.length - MAX_CONNECTIONS_RESPONSE_CACHE,
          )) {
            connectionsResponseCache.delete(k);
          }
        }
      }
      return result;
    } finally {
      connectionsResponseInFlight.delete(key);
    }
  })();
  connectionsResponseInFlight.set(key, compute);
  return { result: await compute, etag: connectionsResponseEtag(key) };
};

const optionalFiniteNumber = (value: unknown, fieldName: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpRouteError(
      400,
      'VALIDATION_ERROR',
      'Validation failed.',
      `${fieldName} must be a finite number when provided.`,
    );
  }
  return value;
};

export const connectionsRoutes: readonly RouteDefinition[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/connections\/ranker\/retrain$/u,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
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
      const vaultRoot = requireVaultRoot(context);
      const body = objectRecord(await readBody(request)) ?? {};
      const force = body['force'] === true;
      const threshold =
        optionalFiniteNumber(body['threshold'], 'threshold') ?? (force ? 1 : undefined);
      const randomNegativeCandidatesPerPositive = optionalFiniteNumber(
        body['randomNegativeCandidatesPerPositive'],
        'randomNegativeCandidatesPerPositive',
      );
      const trainNumRound = optionalFiniteNumber(body['numRound'], 'numRound');
      // Stage 5 polish — route through the worker helper so BOTH the
      // cold-path file reads (readMerged + readCurrent) AND the
      // LightGBM training math run off the main event loop. /v1/status
      // + every other warm-path poll stay responsive while retrain is
      // in flight. The handler now returns to the request body only
      // after the worker round-trip, but it never executes any
      // CPU-heavy or I/O-heavy work on its own thread.
      // SIDETRACK_RANKER_RETRAIN_INLINE=1 opts back into the legacy
      // inline path for fixtures + tests that don't carry a built
      // worker bundle.
      const trainOptions = trainNumRound === undefined ? undefined : { numRound: trainNumRound };
      let result: Awaited<ReturnType<typeof maybeRetrainClosestVisitRanker>>;
      if (process.env['SIDETRACK_RANKER_RETRAIN_INLINE'] === '1') {
        // Inline path also gets called for tests, which inject
        // `context.eventLog` + `context.connectionsStore` directly.
        const snapshot = await context.connectionsStore.readCurrent();
        if (snapshot === null) {
          throw new HttpRouteError(
            409,
            'CONNECTIONS_SNAPSHOT_MISSING',
            'Connections snapshot is not ready.',
          );
        }
        result = await maybeRetrainClosestVisitRanker({
          vaultRoot,
          merged: await context.eventLog.readMerged(),
          snapshot,
          ...(threshold === undefined ? {} : { threshold }),
          ...(force ? { force: true } : {}),
          ...(randomNegativeCandidatesPerPositive === undefined
            ? {}
            : { randomNegativeCandidatesPerPositive }),
          ...(trainOptions === undefined ? {} : { trainOptions }),
        });
      } else {
        result = await runMaybeRetrainInWorker({
          vaultRoot,
          ...(threshold === undefined ? {} : { threshold }),
          ...(force ? { force: true } : {}),
          ...(randomNegativeCandidatesPerPositive === undefined
            ? {}
            : { randomNegativeCandidatesPerPositive }),
          ...(trainOptions === undefined ? {} : { trainOptions }),
        });
      }
      if (result.status === 'trained') {
        await context.refreshConnections?.();
      }
      return [200, { data: result }];
    },
  },
  {
    // P1b — main-process impression-bootstrap. Reconstructs LightGBM training
    // groups from historical explicit feedback by re-running /v2 recall here
    // (warm pipeline, I/O-bound → interleaves with /v1/status), trains
    // OFF-THREAD via the train-groups worker, ship-gates, and promotes the
    // active closest-visit revision on PASS. Manual + idempotent (the trainer
    // dedupes already-referenced feedback).
    //
    // Two envs gate this route (both read at the handler below):
    //   SIDETRACK_RANKER_RECONSTRUCT_FEEDBACK — INVERTED opt-out, NOT an
    //     opt-in. The bootstrap is ON by default (env absent or any value
    //     other than '0' ⇒ enabled); only the literal '0' disables it and
    //     returns 403. There is no "=1 to enable" — do not add one.
    //   SIDETRACK_RANKER_RECONSTRUCT_CAP — positive integer cap on how many
    //     historical feedback events are reconstructed per run, oldest-first;
    //     non-finite / non-positive / absent falls back to the default 200.
    method: 'POST',
    pattern: /^\/v1\/ranker\/impression-bootstrap$/u,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      // Inverted opt-out: only '0' disables; absence/anything-else = enabled.
      if (process.env['SIDETRACK_RANKER_RECONSTRUCT_FEEDBACK'] === '0') {
        throw new HttpRouteError(403, 'BOOTSTRAP_DISABLED', 'Impression bootstrap is disabled.');
      }
      if (context.eventLog === undefined || context.connectionsStore === undefined) {
        throw new HttpRouteError(
          503,
          'CONNECTIONS_NOT_WIRED',
          'Event log / connections is not configured.',
        );
      }
      const vaultRoot = requireVaultRoot(context);
      const snapshot = await context.connectionsStore.readCurrent();
      if (snapshot === null) {
        throw new HttpRouteError(
          409,
          'CONNECTIONS_SNAPSHOT_MISSING',
          'Connections snapshot is not ready.',
        );
      }
      const embedderState = context.getEmbedderStatus?.()?.state;
      const history = await readEventsFromStoreOrLog(
        context,
        context.eventLog,
        (event) =>
          event.type === USER_FLOW_CONFIRMED ||
          event.type === USER_FLOW_REJECTED ||
          event.type === USER_ORGANIZED_ITEM ||
          event.type === USER_SNIPPET_PROMOTED,
        RANKER_BOOTSTRAP_FEEDBACK_EVENT_TYPES,
      );
      const capRaw = Number(process.env['SIDETRACK_RANKER_RECONSTRUCT_CAP']);
      const reconstructCap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 200;
      let reconstructed = 0;
      const result = await runRecallImpressionBootstrap({
        vaultRoot,
        history,
        snapshot,
        reconstructFeedback: async (req) => {
          if (reconstructed >= reconstructCap) {
            return null;
          }
          reconstructed += 1;
          // Yield a macrotask before each (CPU-heavy) reconstruction so
          // /v1/status and other warm-path requests interleave. Back-to-back
          // runRecall calls otherwise saturate the event loop — measured a
          // ~42s /status freeze without this. With the yield the bootstrap
          // takes the same wall-clock but /status stays responsive.
          await new Promise((resolve) => setImmediate(resolve));
          return runRecallV2(
            { vaultRoot, ...(embedderState === undefined ? {} : { embedderState }) },
            req.recallRequest,
          );
        },
      });
      if (result.status === 'trained') {
        await context.refreshConnections?.();
      }
      return [200, { data: { ...result, reconstructed, historyEventCount: history.length } }];
    },
  },
  // Sync Contract v1 — Connections (Class B evidence graph) routes.
  //
  // GET /v1/connections                            full snapshot or
  //                                                workstream-scoped
  //                                                subgraph
  // GET /v1/connections/nodes/<id>/neighbors?hops= subgraph around an anchor
  // GET /v1/connections/edges/<id>                 edge + producing event
  // GET /v1/connections/path?fromNodeId=...        BFS path between two nodes
  //
  // All bridge-key authenticated. ScopedResult-shaped envelope so
  // the side panel + MCP can render partial-data states honestly.
  {
    method: 'GET',
    pattern: /^\/v1\/connections(?:\?.*)?$/u,
    authRequired: true,
    handle: async (request, requestId, _match, context) => {
      void requestId;
      if (context.connectionsStore === undefined) {
        throw new HttpRouteError(503, 'CONNECTIONS_NOT_WIRED', 'Connections is not configured.');
      }
      const url = new URL(request.url ?? '/v1/connections', 'http://internal');
      const workstreamId = url.searchParams.get('workstreamId') ?? undefined;
      const nodeKind = url.searchParams.get('nodeKind') ?? undefined;
      const edgeKind = url.searchParams.get('edgeKind') ?? undefined;
      const provider = url.searchParams.get('provider') ?? undefined;
      const originReplicaId = url.searchParams.get('originReplicaId') ?? undefined;
      const topicVariantRaw = url.searchParams.get('topicVariant') ?? undefined;
      if (topicVariantRaw !== undefined && topicVariantRaw !== 'shadow') {
        throw new HttpRouteError(
          400,
          'INVALID_REQUEST',
          'topicVariant must be omitted or "shadow".',
        );
      }
      const topicVariant = topicVariantRaw === 'shadow' ? topicVariantRaw : undefined;

      const cacheVaultRoot = requireVaultRoot(context);
      const cacheKey = await connectionsResponseCacheKey(
        context.connectionsStore,
        cacheVaultRoot,
        url.search,
      );
      const { result: connectionsResult } = await cachedConnectionsResponse(
        cacheKey,
        CONNECTIONS_RESPONSE_TTL_MS,
        async (): Promise<readonly [number, unknown]> => {
          let snap = await context.connectionsStore!.readCurrent();
          if (snap === null) {
            // Materializer hasn't run yet — return an empty scoped
            // envelope so callers don't have to special-case 404.
            return [
              200,
              {
                data: {
                  scope: 'companion-extended',
                  snapshot: {
                    scope: { ...(topicVariant === undefined ? {} : { topicVariant }) },
                    nodes: [],
                    edges: [],
                    updatedAt: '1970-01-01T00:00:00.000Z',
                    nodeCount: 0,
                    edgeCount: 0,
                  },
                },
              },
            ];
          }
          if (topicVariant === 'shadow') {
            const shadowRevision = await createTopicRevisionStore(
              requireVaultRoot(context),
            ).readShadowRevision();
            if (shadowRevision === null) {
              return [
                200,
                {
                  data: {
                    scope: 'companion-extended',
                    snapshot: {
                      scope: { topicVariant },
                      nodes: [],
                      edges: [],
                      updatedAt: snap.updatedAt,
                      nodeCount: 0,
                      edgeCount: 0,
                      ...(snap.snapshotRevision === undefined
                        ? {}
                        : { snapshotRevision: `${snap.snapshotRevision}:shadow-missing` }),
                    },
                  },
                },
              ];
            }
            snap = overlayTopicRevisionOnSnapshot(snap, shadowRevision);
          }
          if (context.eventLog !== undefined) {
            snap = applyFeedbackOverlayToSnapshot(
              snap,
              projectFeedback(
                await readEventsFromStoreOrLog(
                  context,
                  context.eventLog,
                  (event) => isFeedbackEventType(event.type),
                  FEEDBACK_EVENT_TYPE_LIST,
                ),
              ),
            );
          }
          snap = await applyPageContentCoverageToSnapshot(requireVaultRoot(context), snap);
          // Coarse filters — honoured by simple matchers. workstreamId
          // narrows to nodes either matching the ws id directly or
          // having metadata.workstreamId pointing to it; edges between
          // selected nodes survive.
          let nodes = snap.nodes;
          let edges = snap.edges;
          if (workstreamId !== undefined) {
            const wsNodeId = `workstream:${workstreamId}`;
            const keepNodeIds = new Set<string>([wsNodeId]);
            for (const n of nodes) {
              if (n.metadata.workstreamId === workstreamId) keepNodeIds.add(n.id);
            }
            // Pull in edge endpoints reachable from the kept set in one
            // hop so the projection is comprehensible.
            for (const e of edges) {
              if (keepNodeIds.has(e.fromNodeId)) keepNodeIds.add(e.toNodeId);
              if (keepNodeIds.has(e.toNodeId)) keepNodeIds.add(e.fromNodeId);
            }
            nodes = nodes.filter((n) => keepNodeIds.has(n.id));
            edges = edges.filter(
              (e) => keepNodeIds.has(e.fromNodeId) && keepNodeIds.has(e.toNodeId),
            );
          }
          if (nodeKind !== undefined) {
            nodes = nodes.filter((n) => n.kind === nodeKind);
            const kept = new Set(nodes.map((n) => n.id));
            edges = edges.filter((e) => kept.has(e.fromNodeId) && kept.has(e.toNodeId));
          }
          if (edgeKind !== undefined) {
            edges = edges.filter((e) => e.kind === edgeKind);
          }
          if (provider !== undefined) {
            nodes = nodes.filter((n) => n.metadata.provider === provider);
            const kept = new Set(nodes.map((n) => n.id));
            edges = edges.filter((e) => kept.has(e.fromNodeId) && kept.has(e.toNodeId));
          }
          if (originReplicaId !== undefined) {
            nodes = nodes.filter((n) => n.originReplicaIds.includes(originReplicaId));
            const kept = new Set(nodes.map((n) => n.id));
            edges = edges.filter((e) => kept.has(e.fromNodeId) && kept.has(e.toNodeId));
          }
          return [
            200,
            {
              data: {
                scope: 'companion-extended',
                snapshot: {
                  scope: {
                    ...(workstreamId === undefined ? {} : { workstreamId }),
                    ...(topicVariant === undefined ? {} : { topicVariant }),
                  },
                  nodes,
                  edges,
                  updatedAt: snap.updatedAt,
                  nodeCount: nodes.length,
                  edgeCount: edges.length,
                  ...(snap.snapshotRevision === undefined
                    ? {}
                    : { snapshotRevision: snap.snapshotRevision }),
                },
              },
            },
          ];
        },
      );
      // Domain-tombstone privacy gate — applied POST-cache (outside the
      // revision-keyed connections cache) so a purge takes effect on the
      // next serve without waiting for the graph revision to change.
      // Drops matching nodes and any edge touching a dropped node.
      const tombstones = await domainTombstoneSetFor(context);
      const filtered = excludeTombstonedNodesFromConnectionsResult(
        connectionsResult,
        tombstones,
      );
      return filtered;
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/connections\/nodes\/(?<connectionsNodeId>[^/?]+)\/neighbors(?:\?.*)?$/u,
    authRequired: true,
    handle: async (request, _requestId, match, context) => {
      if (context.connectionsStore === undefined) {
        throw new HttpRouteError(503, 'CONNECTIONS_NOT_WIRED', 'Connections is not configured.');
      }
      // Path params are URI-encoded (we accept the whole node id
      // as the URL segment); decode and validate length.
      const nodeId = decodeURIComponent(match.connectionsNodeId ?? '');
      const url = new URL(request.url ?? '/v1/connections', 'http://internal');
      const hopsRaw = Number.parseInt(url.searchParams.get('hops') ?? '1', 10);
      const hops = Number.isFinite(hopsRaw) && hopsRaw >= 0 ? Math.min(hopsRaw, 4) : 1;
      if (context.connectionsStore instanceof SqliteConnectionsStore) {
        let sub = await context.connectionsStore.readSubgraphForNode(nodeId, hops);
        if (sub !== null && sub.nodes.length > 0) {
          if (context.eventLog !== undefined) {
            sub = applyFeedbackOverlayToSnapshot(
              sub,
              projectFeedback(
                await readEventsFromStoreOrLog(
                  context,
                  context.eventLog,
                  (event) => isFeedbackEventType(event.type),
                  FEEDBACK_EVENT_TYPE_LIST,
                ),
              ),
            );
          }
          sub = await applyPageContentCoverageToSnapshot(requireVaultRoot(context), sub);
          return [200, { data: { scope: 'companion-extended', snapshot: sub } }];
        }
      }
      let snap = await context.connectionsStore.readCurrent();
      if (snap === null) {
        return [
          200,
          {
            data: {
              scope: 'companion-extended',
              snapshot: {
                scope: { nodeId, hops },
                nodes: [],
                edges: [],
                updatedAt: '1970-01-01T00:00:00.000Z',
                nodeCount: 0,
                edgeCount: 0,
              },
            },
          },
        ];
      }
      if (context.eventLog !== undefined) {
        snap = applyFeedbackOverlayToSnapshot(
          snap,
          projectFeedback(
            await readEventsFromStoreOrLog(
              context,
              context.eventLog,
              (event) => isFeedbackEventType(event.type),
              FEEDBACK_EVENT_TYPE_LIST,
            ),
          ),
        );
      }
      snap = await applyPageContentCoverageToSnapshot(requireVaultRoot(context), snap);
      const { subgraphForNode } = await import('../../connections/snapshot.js');
      const resolvedNodeId = resolveConnectionsNodeId(snap, nodeId);
      const sub = subgraphForNode(snap, resolvedNodeId, hops);
      return [200, { data: { scope: 'companion-extended', snapshot: sub } }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/connections\/edges\/(?<connectionsEdgeId>[^/?]+)(?:\?.*)?$/u,
    authRequired: true,
    handle: async (_request, _requestId, match, context) => {
      if (context.connectionsStore === undefined) {
        throw new HttpRouteError(503, 'CONNECTIONS_NOT_WIRED', 'Connections is not configured.');
      }
      const edgeId = decodeURIComponent(match.connectionsEdgeId ?? '');
      if (context.connectionsStore instanceof SqliteConnectionsStore) {
        const edge = await context.connectionsStore.readEdge(edgeId);
        if (edge === null) {
          throw new HttpRouteError(404, 'EDGE_NOT_FOUND', 'Edge not found.');
        }
        return [200, { data: { edge } }];
      }
      const snap = await context.connectionsStore.readCurrent();
      if (snap === null) {
        throw new HttpRouteError(404, 'EDGE_NOT_FOUND', 'No connections snapshot yet.');
      }
      const edge = snap.edges.find((e) => e.id === edgeId);
      if (edge === undefined) {
        throw new HttpRouteError(404, 'EDGE_NOT_FOUND', 'Edge not found.');
      }
      return [200, { data: { edge } }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/connections\/path(?:\?.*)?$/u,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      if (context.connectionsStore === undefined) {
        throw new HttpRouteError(503, 'CONNECTIONS_NOT_WIRED', 'Connections is not configured.');
      }
      const url = new URL(request.url ?? '/v1/connections/path', 'http://internal');
      const fromNodeId = url.searchParams.get('fromNodeId') ?? '';
      const toNodeId = url.searchParams.get('toNodeId') ?? '';
      const maxHopsRaw = Number.parseInt(url.searchParams.get('maxHops') ?? '4', 10);
      const maxHops = Number.isFinite(maxHopsRaw) && maxHopsRaw > 0 ? Math.min(maxHopsRaw, 8) : 4;
      if (fromNodeId.length === 0 || toNodeId.length === 0) {
        throw new HttpRouteError(400, 'INVALID_REQUEST', 'fromNodeId and toNodeId are required.');
      }
      const snap = await context.connectionsStore.readCurrent();
      if (snap === null) {
        return [200, { data: { found: false } }];
      }
      const { findPath } = await import('../../connections/snapshot.js');
      const result = findPath(snap, fromNodeId, toNodeId, maxHops);
      return [200, { data: result }];
    },
  },
];
