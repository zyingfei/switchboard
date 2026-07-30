// Recall routes: index, query, the /v2 recall endpoint, and action/rebuild/gc
// (three non-contiguous segments in dispatch order — recallRoutesA/B/C).
//
// Extracted verbatim from server.ts in stage S2 of the cost-of-change
// refactor; order within this array is dispatch order and is pinned by
// routeTable.characterization.test.ts.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { createRequestId } from '../../domain/ids.js';
import { loadGistLookupWithSignature, lookupGist } from '../../enrichment/contentEnrichment.js';
import { effectiveThreadTitle, loadEnrichmentLookupWithSignature } from '../../enrichment/titleEnrichment.js';
import type { DomainTombstoneSet } from '../../privacy/domainTombstone.js';
import { runRecallWithShadow as runRecallV2 } from '../../recall-v2/pipeline.js';
import { RECALL_ACTION, RECALL_SERVED, isRecallActionPayload, type RecallServedPayload } from '../../recall/events.js';
import { gcEntries as gcEntriesRaw, readIndex, upsertEntries as upsertEntriesRaw } from '../../recall/indexFile.js';
import { buildLexicalIndex, rank, rankHybrid, type HybridLexicalIndex, type IndexEntry } from '../../recall/ranker.js';
import { createProblem } from '../problem.js';
import { recallGcSchema, recallIndexSchema, recallQuerySchema, recallV2RequestSchema } from '../schemas.js';

import { HttpRouteError, RANKER_BOOTSTRAP_FEEDBACK_EVENT_TYPES, domainTombstoneSetFor, readBody, readEventsFromStoreOrLog, recallIndexPath, requireIdempotencyKey, requireVaultRoot, runIdempotent } from '../routeSupport.js';
import type { RouteDefinition } from '../routeSupport.js';

// /v1/status availability contract (statusContract.test.ts): the
// embedder module must NOT be in this file's static import graph —
// even its import cost is unbounded (transformers/ONNX init), and
// /status has to answer during cold start. Recall call sites load it
// lazily through this memoized dynamic import instead.
type EmbedderModule = typeof import('../../recall/embedder.js');

let embedderModulePromise: Promise<EmbedderModule> | null = null;

export const loadEmbedderModule = (): Promise<EmbedderModule> =>
  (embedderModulePromise ??= import('../../recall/embedder.js'));

// Drop recall-v2 candidates whose domain has been tombstoned. Candidates
// carry an optional canonicalUrl + title; a candidate with no URL can't
// be domain-matched here (chat-turn hits) — those are handled by vector
// deletion at write time. Returns a new response with the filtered list.
const filterRecallResponseByTombstones = (
  response: unknown,
  tombstones: DomainTombstoneSet,
): unknown => {
  if (typeof response !== 'object' || response === null) return response;
  const results = (response as { results?: unknown }).results;
  if (!Array.isArray(results)) return response;
  const kept = (results as { canonicalUrl?: unknown; title?: unknown }[]).filter((candidate) => {
    const url = typeof candidate.canonicalUrl === 'string' ? candidate.canonicalUrl : undefined;
    if (url === undefined) return true;
    const title = typeof candidate.title === 'string' ? candidate.title : undefined;
    return !tombstones.matchesPage({ url, ...(title === undefined ? {} : { title }) });
  });
  if (kept.length === results.length) return response;
  return { ...(response as object), results: kept };
};

// Lexical-index cache for /v1/recall/query. Building the MiniSearch
// index over every chunk on each request is wasteful — it only
// changes when the on-disk index file changes. Keyed by index path
// + mtime; a write through upsertEntries / rebuildFromEventLog
// updates the file mtime and invalidates the cache on the next
// query.
interface LexicalCacheEntry {
  readonly mtimeMs: number;
  readonly entryCount: number;
  readonly index: HybridLexicalIndex;
}

const lexicalIndexCache = new Map<string, LexicalCacheEntry>();

const readWorkstreamThreadIds = async (
  vaultRoot: string,
  workstreamId: string,
): Promise<ReadonlySet<string>> => {
  const root = join(vaultRoot, '_BAC', 'threads');
  const names = await readdir(root).catch(() => []);
  const ids = new Set<string>();
  for (const name of names.filter((candidate) => candidate.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(await readFile(join(root, name), 'utf8')) as {
        readonly bac_id?: unknown;
        readonly primaryWorkstreamId?: unknown;
      };
      if (parsed.primaryWorkstreamId === workstreamId && typeof parsed.bac_id === 'string') {
        ids.add(parsed.bac_id);
      }
    } catch {
      // Ignore malformed thread records; recall filtering is best-effort.
    }
  }
  return ids;
};

export const recallRoutesA: readonly RouteDefinition[] = [
  {
    method: 'POST',
    pattern: /^\/v1\/recall\/index$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      // FX2 — single batched write. Was: embed all → loop N times,
      // each iteration `await recallLifecycle.appendEntry(entry)`.
      // `appendEntry` → `upsertEntries(path, [entry])` → reads the
      // full ~MB index, parses 7000+ items, adds one, writes back.
      // 100 items = 100 full-file rewrites under the enqueueWrite
      // mutex → 35 s POST /v1/recall/index → /v2/recall etc. cascade
      // to 26 s+. Now: one upsertEntries call with the full array
      // does one read+write regardless of batch size.
      const vaultRoot = requireVaultRoot(context);
      const input = recallIndexSchema.parse(await readBody(request));
      const { embed, MODEL_ID } = await loadEmbedderModule();
      const vectors = await embed(input.items.map((item) => item.text));
      const entries: { id: string; threadId: string; capturedAt: string; embedding: Float32Array }[] = [];
      const indexedThreadIds: string[] = [];
      for (let index = 0; index < input.items.length; index += 1) {
        const item = input.items[index];
        const embedding = vectors[index];
        if (item === undefined || embedding === undefined) continue;
        entries.push({
          id: item.id,
          threadId: item.threadId,
          capturedAt: item.capturedAt,
          embedding,
        });
        indexedThreadIds.push(item.threadId);
      }
      if (entries.length > 0) {
        if (context.recallLifecycle !== undefined) {
          await context.recallLifecycle.appendEntries(entries);
        } else {
          // Legacy / test path with no lifecycle wrapper. Use the
          // batched upsert too — same scale win.
          await upsertEntriesRaw(recallIndexPath(vaultRoot), entries, MODEL_ID);
        }
      }
      context.recallActivity?.recordIncrementalIndex({
        count: entries.length,
        threadIds: indexedThreadIds,
      });
      return [202, { data: { indexed: entries.length } }];
    },
  },
  {
    method: 'GET',
    pattern: /^\/v1\/recall\/query$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const rawQ = url.searchParams.get('q');
      if (rawQ === null) {
        return [
          400,
          createProblem({
            title: 'q query parameter is required',
            status: 400,
            code: 'MISSING_PARAMETER',
            correlationId: createRequestId(),
            detail: 'GET /v1/recall/query requires a q query parameter.',
          }),
        ];
      }
      const query = recallQuerySchema.parse({
        q: rawQ,
        limit: url.searchParams.get('limit') ?? undefined,
        workstreamId: url.searchParams.get('workstreamId') ?? undefined,
      });
      const indexFilePath = recallIndexPath(vaultRoot);
      const index = await readIndex(indexFilePath);
      if (index === null) {
        return [200, { data: [] }];
      }
      // Short-circuit when the index is empty. The lifecycle's first
      // background rebuild creates an empty index file on a fresh
      // vault, so `index !== null` doesn't imply there's anything to
      // search. Without this branch we'd burn an embedder load (and
      // surface a misleading 503 RECALL_MODEL_MISSING in offline +
      // empty-cache mode) for a query that has nothing to rank.
      if (index.items.length === 0) {
        return [200, { data: [] }];
      }
      // Vector availability gate. The embedder runs in a child
      // process; cold/warming/failed states return lexical-only
      // results immediately. Callers that want to wait for the
      // vector path can pass ?waitMs=N (capped at 5000) and we'll
      // poll for ready up to that budget. Default is non-blocking
      // — /v1/recall/query must not stall the side panel on a
      // cold embedder.
      const embedderStatus = context.getEmbedderStatus?.() ?? { state: 'disabled' as const };
      const rawWait = Number.parseInt(url.searchParams.get('waitMs') ?? '0', 10);
      const waitBudgetMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(rawWait, 5_000) : 0;
      const isVectorUsable = (s: string): boolean => s === 'ready' || s === 'disabled';
      let vectorStateAtQuery = embedderStatus.state;
      if (
        !isVectorUsable(vectorStateAtQuery) &&
        waitBudgetMs > 0 &&
        vectorStateAtQuery !== 'failed'
      ) {
        const deadline = Date.now() + waitBudgetMs;
        while (Date.now() < deadline) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
          });
          const next = context.getEmbedderStatus?.() ?? { state: 'disabled' as const };
          vectorStateAtQuery = next.state;
          if (isVectorUsable(vectorStateAtQuery)) break;
        }
      }
      // Embedding the query needs the local model. In offline mode
      // with an empty cache (or any other "we can't load the model"
      // failure path), the embedder throws RecallModelMissingError —
      // surface that as a typed 503 so the side panel can show a
      // distinct "model missing" affordance instead of a generic
      // "recall failed". Capture continues to work in that state
      // because POST /v1/events doesn't depend on the embedder.
      let queryEmbedding: Float32Array | undefined;
      let vectorMode: 'used' | 'skipped-warming' | 'skipped-failed' = 'used';
      if (!isVectorUsable(vectorStateAtQuery)) {
        vectorMode = vectorStateAtQuery === 'failed' ? 'skipped-failed' : 'skipped-warming';
      } else {
        const { embed, MODEL_ID, RecallModelMissingError } = await loadEmbedderModule();
        try {
          [queryEmbedding] = await embed([query.q]);
        } catch (error) {
          if (error instanceof RecallModelMissingError) {
            return [
              503,
              createProblem({
                title: 'Recall embedding model is not available',
                status: 503,
                code: 'RECALL_MODEL_MISSING',
                correlationId: createRequestId(),
                detail: error.offline
                  ? `Companion is in offline-models mode and the cache at ${error.cacheDir} does not contain ${MODEL_ID}. Run \`sidetrack-companion models ensure\` (with network access) or disable --offline-models / SIDETRACK_OFFLINE_MODELS.`
                  : `Could not load ${MODEL_ID} from ${error.cacheDir}. Run \`sidetrack-companion models ensure\` to (re)download the model.`,
              }),
            ];
          }
          throw error;
        }
      }
      const threadIds =
        query.workstreamId === undefined
          ? undefined
          : await readWorkstreamThreadIds(vaultRoot, query.workstreamId);
      // Title enrichment (thread kind): overlay each recall chunk's
      // metadata.title where the thread's raw title is junk (empty /
      // URL-shaped). This is the recall TITLE LANE — the overlaid title feeds
      // the FTS lexical index (title is 2x-boosted) AND every ranked result's
      // metadata.title. ingestIncremental cannot update existing chunk titles
      // (it dedups by thread-role-textHash), so overlaying at this read seam
      // is what actually surfaces the enriched title in recall. Cheap: a warm
      // lookup is a stat; the item map only allocates when enrichment exists.
      const { lookup: recallEnrichment, signature: recallEnrichSig } =
        await loadEnrichmentLookupWithSignature(vaultRoot, context.eventLog);
      // Content-gist overlay: fold ENTITY_CONTENT_ENRICHED into a gist lookup so
      // a synthesized gist becomes MATCHABLE in the lexical index. Same
      // read-seam discipline as the title overlay above — ingestIncremental
      // dedups chunks by (thread,role,textHash) and cannot inject a gist chunk,
      // so we splice the gist into ONE chunk's FTS `text` per entity at query
      // time. Keyed by the same event-log signature (recallGistSig) so a landed
      // gist busts the cached FTS index.
      const { lookup: recallGist, signature: recallGistSig } = await loadGistLookupWithSignature(
        vaultRoot,
        context.eventLog,
      );
      // Track which thread/url entities have already had their gist spliced so
      // the gist text lands on exactly ONE chunk per entity (not duplicated
      // across every chunk, which would over-weight it in BM25).
      const gistApplied = recallGist === null ? null : new Set<string>();
      const indexItems: readonly IndexEntry[] =
        recallEnrichment === null && recallGist === null
          ? index.items
          : index.items.map((item): IndexEntry => {
              // Only chunks that carry metadata (V3 entries) can be overlaid;
              // V2 holdovers with no metadata pass through untouched.
              if (item.metadata === undefined) return item;
              let metadata = item.metadata;
              // Title overlay (thread kind): synthesized title where the raw
              // title is junk.
              if (recallEnrichment !== null) {
                const overlaid = effectiveThreadTitle(recallEnrichment, item.threadId, metadata.title);
                if (overlaid !== metadata.title && overlaid !== undefined) {
                  metadata = { ...metadata, title: overlaid };
                }
              }
              // Gist overlay (thread kind): append the gist to this chunk's FTS
              // `text` — but only for the FIRST chunk of each thread, so the
              // gist tokens are searchable without being counted once per turn.
              if (recallGist !== null && gistApplied !== null && !gistApplied.has(item.threadId)) {
                const gist = lookupGist(recallGist, 'thread', item.threadId);
                if (gist !== undefined && gist.length > 0) {
                  gistApplied.add(item.threadId);
                  metadata = { ...metadata, text: `${metadata.text} ${gist}`.trim() };
                }
              }
              return metadata === item.metadata ? item : { ...item, metadata };
            });
      // Resolve the lexical index from cache. If the on-disk file
      // mtime + entry count haven't changed, reuse the prior
      // MiniSearch instance — building it from scratch on every
      // query is wasteful for large indexes. Falls back to vector-
      // only ranking when the index has zero entries that carry
      // chunk metadata (V2 holdovers post-rebuild). The enrichment
      // signature is folded into the cache key so a landed title
      // enrichment (which does NOT change the index file mtime) busts
      // the cached FTS index and rebuilds it with the overlaid title.
      const indexStat = await stat(indexFilePath).catch(() => undefined);
      const indexMtime = indexStat?.mtimeMs ?? 0;
      const lexicalCacheKey = `${indexFilePath}\u0000${recallEnrichSig}\u0000${recallGistSig}`;
      const cached = lexicalIndexCache.get(lexicalCacheKey);
      const lexical: HybridLexicalIndex =
        cached?.mtimeMs === indexMtime && cached.entryCount === indexItems.length
          ? cached.index
          : buildLexicalIndex(indexItems);
      if (cached?.mtimeMs !== indexMtime || cached.entryCount !== indexItems.length) {
        lexicalIndexCache.set(lexicalCacheKey, {
          mtimeMs: indexMtime,
          entryCount: indexItems.length,
          index: lexical,
        });
      }
      // Hybrid lexical + vector retrieval via RRF. Falls back
      // gracefully when the index has no chunk-metadata entries
      // (V2 holdovers): the lexical search side returns no hits,
      // RRF degenerates to vector ranking, which is what the
      // pre-V3 behavior already produced.
      const hybridRanked = rankHybrid(
        query.q,
        queryEmbedding ?? new Float32Array(384),
        indexItems,
        new Date(),
        {
          limit: query.limit,
          lexical,
          ...(threadIds === undefined
            ? {}
            : { workstreamMembership: (threadId: string) => threadIds.has(threadId) }),
        },
      );
      // If hybrid returned nothing AND the index has entries, the
      // user still expects vector-only behavior (e.g., a query that
      // matches nothing lexically but is semantically close). Plain
      // `rank` is the back-compat path for that case.
      const ranked =
        hybridRanked.length > 0
          ? hybridRanked
          : rank(queryEmbedding ?? new Float32Array(384), indexItems, new Date(), {
              limit: query.limit,
              ...(threadIds === undefined
                ? {}
                : { workstreamMembership: (threadId: string) => threadIds.has(threadId) }),
            });
      // Enrich each result with the thread title + canonical URL so
      // the side panel can render meaningful labels and the SW proxy
      // can dedup across stale duplicate bac_ids that point at the
      // same chat URL. The cost is O(limit) tiny JSON reads —
      // acceptable because the limit is clamped at 50.
      // Snippet remains absent for now (would need an index format
      // bump to store per-turn text without re-reading event logs).
      const meta = new Map<string, { title: string; threadUrl: string }>();
      const enriched = await Promise.all(
        ranked.map(async (item) => {
          let info = meta.get(item.threadId);
          if (info === undefined) {
            try {
              const threadFile = await readFile(
                join(vaultRoot, '_BAC', 'threads', `${item.threadId}.json`),
                'utf8',
              );
              const parsed = JSON.parse(threadFile) as {
                readonly title?: unknown;
                readonly threadUrl?: unknown;
              };
              info = {
                title: typeof parsed.title === 'string' ? parsed.title : '',
                threadUrl: typeof parsed.threadUrl === 'string' ? parsed.threadUrl : '',
              };
            } catch {
              info = { title: '', threadUrl: '' };
            }
            meta.set(item.threadId, info);
          }
          // Title enrichment (thread kind): overlay the served label where
          // the thread's raw title (from thread.json) is junk. Same junk rule
          // as the FTS overlay above so the label the panel shows matches
          // what recall matched on.
          const effectiveLabel = effectiveThreadTitle(
            recallEnrichment,
            item.threadId,
            info.title.length > 0 ? info.title : undefined,
          );
          const additions: Record<string, string> = {};
          if (effectiveLabel !== undefined && effectiveLabel.length > 0) {
            additions['title'] = effectiveLabel;
          }
          if (info.threadUrl.length > 0) additions['threadUrl'] = info.threadUrl;
          return Object.keys(additions).length > 0 ? { ...item, ...additions } : item;
        }),
      );
      context.recallActivity?.recordQuery({
        queryLength: query.q.length,
        resultCount: enriched.length,
      });
      return [
        200,
        {
          data: enriched,
          meta: {
            vectorMode,
            vectorState: vectorStateAtQuery,
            ...(waitBudgetMs > 0 ? { waitedMs: waitBudgetMs } : {}),
          },
        },
      ];
    },
  },
];

export const recallRoutesB: readonly RouteDefinition[] = [
  {
    // Recall v2 — single unified retrieval endpoint. POST so the
    // extension can pass a typed request body (sources / suppression
    // policy / strategy) without URL-encoding gymnastics. Initially
    // delegates to v1.5 functions via recall-v2/pipeline.ts; later
    // phases swap the SQLite backend + query analysis + cross-encoder
    // rerank without touching the contract.
    method: 'POST',
    pattern: /^\/v2\/recall$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      const body = (await readBody(request)) as unknown;
      const parsed = recallV2RequestSchema.safeParse(body);
      if (!parsed.success) {
        // Surface the first Zod issue path so callers can see WHICH
        // field is wrong without dumping the full ZodError. Keeps the
        // error shape consistent with the rest of the v1 API.
        const first = parsed.error.issues[0];
        const path = first?.path.join('.') ?? 'body';
        const message = first?.message ?? 'invalid request body';
        throw new HttpRouteError(
          400,
          first === undefined ? 'INVALID_REQUEST' : 'INVALID_FIELD',
          `${path}: ${message}`,
          'POST /v2/recall body failed schema validation.',
        );
      }
      const req = parsed.data as import('../../recall-v2/types.js').RecallRequest;
      // P1 — pass embedder lifecycle state so the pipeline can
      // degrade gracefully when the model is still warming up. Same
      // status the /v1/status endpoint exposes.
      const embedderState = context.getEmbedderStatus?.()?.state;
      // Phase 0 — wire impression logging. When the event log is
      // configured, every /v2/recall response writes a
      // `recall.served` event the trainer (Phase 3) can read. Append
      // is fire-and-forget inside the pipeline.
      const eventLog = context.eventLog;
      const appendImpression = eventLog === undefined
        ? undefined
        : async (payload: RecallServedPayload): Promise<void> => {
            await eventLog.appendServerObserved({
              clientEventId: `recall.served:${payload.servedContextId}:${String(payload.sequenceNumber)}`,
              aggregateId: payload.servedContextId,
              type: RECALL_SERVED,
              payload: payload as unknown as Record<string, unknown>,
            });
          };
      // Phase 5 — cross-encoder rerank ON by default in the dogfood
      // serving path. The pipeline library's default is 0 (off) for
      // test determinism; production /v2 endpoint applies
      // DOGFOOD_RERANK_TOP_K unless the caller overrides explicitly.
      // 20 candidates × ~5ms/pair on MiniLM-L-6-v2 ≈ ~100ms added per
      // request. Tune via the eval harness; calibration follow-up.
      const DOGFOOD_RERANK_TOP_K = 20;
      const reqWithDefaultRerank: import('../../recall-v2/types.js').RecallRequest = {
        ...req,
        strategy: {
          ...(req.strategy ?? {}),
          rerankTopK: req.strategy?.rerankTopK ?? DOGFOOD_RERANK_TOP_K,
        },
      };
      // P3 — learned-rerank context loader. Reads the CURRENT connections
      // snapshot + the feedback-only event window (the SAME merged the
      // impression trainer used: RANKER_BOOTSTRAP_FEEDBACK_EVENT_TYPES,
      // indexed) so serve features match train features exactly. Invoked
      // only on the background TTL refresh AND only after the serve gate
      // passes (active impression-trained ship-gate-passed model) — never
      // inline on the request path. Omitted (→ feature off) without a
      // connections store / event log.
      const connectionsStore = context.connectionsStore;
      const learnedRerankContext =
        connectionsStore === undefined || eventLog === undefined
          ? undefined
          : async (): Promise<
              import('../../recall-v2/learnedRerank.js').LearnedRerankContext | null
            > => {
              const snapshot = await connectionsStore.readCurrent();
              if (snapshot === null) return null;
              const feedbackTypes = RANKER_BOOTSTRAP_FEEDBACK_EVENT_TYPES as readonly string[];
              const merged = await readEventsFromStoreOrLog(
                context,
                eventLog,
                (event) => feedbackTypes.includes(event.type),
                RANKER_BOOTSTRAP_FEEDBACK_EVENT_TYPES,
              );
              return { snapshot, merged };
            };
      const response = await runRecallV2(
        {
          vaultRoot,
          ...(embedderState === undefined ? {} : { embedderState }),
          ...(appendImpression === undefined ? {} : { appendImpression }),
          ...(learnedRerankContext === undefined ? {} : { learnedRerankContext }),
        },
        reqWithDefaultRerank,
      );
      // Domain-tombstone privacy gate — drop candidates on a purged
      // domain from what's SERVED (the vector entries themselves are
      // deleted at tombstone-write time; this catches any residual /
      // non-vector candidate). Read-boundary filter only; scoring is
      // untouched — we just remove hidden rows from the served list.
      const tombstones = await domainTombstoneSetFor(context);
      const gated = tombstones.isEmpty
        ? response
        : filterRecallResponseByTombstones(response, tombstones);
      // Wrap in { data } to match the rest of the v1 API convention so
      // the bridge clients (recallV2 in pageContentClient.ts) can
      // unwrap consistently with the other endpoints.
      return [200, { data: gated }];
    },
  },
];

export const recallRoutesC: readonly RouteDefinition[] = [
  {
    // Phase 0 — POST /v1/recall/action. The extension echoes a user
    // action (click / open-new-tab / explicit feedback) on a served
    // candidate back to the companion. The companion appends a
    // `recall.action` event tied to the parent `recall.served` by
    // servedContextId. The group-level ranker trainer (Phase 3)
    // joins the two to build training groups.
    //
    // Body shape: RecallActionPayload (see recall/events.ts).
    // Idempotency: the X-Idempotency-Key header is the clientEventId,
    // so duplicate POSTs collapse to one event.
    method: 'POST',
    pattern: /^\/v1\/recall\/action$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const eventLog = context.eventLog;
      if (eventLog === undefined) {
        throw new HttpRouteError(
          503,
          'EVENT_LOG_UNAVAILABLE',
          'event log not configured for this companion',
        );
      }
      const idempotencyKey = requireIdempotencyKey(request);
      return await runIdempotent(context, 'recallAction', idempotencyKey, async () => {
        const body = await readBody(request);
        if (!isRecallActionPayload(body)) {
          throw new HttpRouteError(
            400,
            'INVALID_REQUEST',
            'body did not match RecallActionPayload',
            'POST /v1/recall/action body failed payload validation.',
          );
        }
        const accepted = await eventLog.appendClientObserved({
          clientEventId: idempotencyKey,
          aggregateId: body.servedContextId,
          type: RECALL_ACTION,
          payload: body as unknown as Record<string, unknown>,
          // {} = "browser observed nothing"; the parent recall.served
          // already lives on the same aggregate, and the deps the
          // system stamps from frontier will pick it up automatically.
          baseVector: {},
        });
        return [
          201,
          {
            data: {
              accepted: true,
              clientEventId: accepted.clientEventId,
              servedContextId: body.servedContextId,
              actionKind: body.actionKind,
            },
          },
        ];
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/recall\/rebuild$/,
    authRequired: true,
    handle: async (_request, _requestId, _match, context) => {
      const vaultRoot = requireVaultRoot(context);
      // Prefer the lifecycle path so the manual button + auto-rebuild
      // share the same scheduler (one rebuild at a time, status flips
      // to "rebuilding" in /v1/system/health, errors are captured).
      // Fall back to the direct rebuilder for legacy callers that
      // didn't inject a lifecycle.
      //
      // Critical: do NOT await the rebuild here. The first rebuild
      // downloads the embedder model (~30MB) and embeds every turn
      // — that can take minutes. Holding the request open until it
      // finishes causes Chrome's fetch to time out with "Failed to
      // fetch" and the user thinks the rebuild errored when it's
      // actually still chugging along. Returning 202 + the current
      // status lets the side-panel pill + Health card poll
      // /v1/system/health to track progress.
      if (context.recallLifecycle !== undefined) {
        context.recallLifecycle.scheduleRebuild('manual');
        const report = await context.recallLifecycle.report();
        return [
          202,
          {
            data: {
              accepted: true,
              status: report.status,
              entryCount: report.entryCount,
              eventTurnCount: report.eventTurnCount,
              lastRebuildAt: report.lastRebuildAt,
              lastError: report.lastError,
            },
          },
        ];
      }
      return [
        202,
        // Lazy: recall/rebuild.ts is on the /v1/status forbidden-import
          // list (statusContract.test.ts) — load it when the rebuild route
          // actually fires.
          {
            data: await (
              await import('../../recall/rebuild.js')
            ).rebuildFromEventLog(vaultRoot, join(vaultRoot, '_BAC', 'events')),
          },
      ];
    },
  },
  {
    method: 'POST',
    pattern: /^\/v1\/recall\/gc$/,
    authRequired: true,
    handle: async (request, _requestId, _match, context) => {
      const input = recallGcSchema.parse(await readBody(request));
      const validIds = new Set(input.validIds);
      const data =
        context.recallLifecycle !== undefined
          ? await context.recallLifecycle.gcEntries(validIds)
          : await gcEntriesRaw(recallIndexPath(requireVaultRoot(context)), validIds);
      return [200, { data }];
    },
  },
];
