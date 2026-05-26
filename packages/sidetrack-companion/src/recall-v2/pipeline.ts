// Recall v2 — pipeline orchestrator.
//
// Phase 2 deliverable: the single entry point for /v2/recall. Initial
// implementation DELEGATES to v1.5's existing functions to preserve
// behavior; phases 3-6 swap each candidate generator's body to SQLite
// FTS5 + sqlite-vec and add server-side fusion/dedupe/suppression.
//
// Why delegate first: lets the eval harness (Phase 1) land before any
// ranking change. We can baseline v1.5 against the 11 fixtures, then
// every subsequent phase has a regression gate.

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { queryPageContent } from '../page-content/store.js';
import { queryTimelineVisits } from '../page-evidence/timelineRecall.js';
import { buildLexicalIndex, rankHybrid } from '../recall/ranker.js';
import { readIndex } from '../recall/indexFile.js';

// Single source of truth was private to server.ts:818; inlined here so
// recall-v2 doesn't import from the HTTP layer.
const recallIndexPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'recall', 'index.bin');
import {
  expandSemanticByQuery,
  expandSemanticRecallCandidates,
  readSemanticRecallPool,
  readSemanticRecallVectorStore,
} from '../recall/semanticRecallPool.js';
import { embed, MODEL_ID } from '../recall/embedder.js';
import { profileFor, semanticContributionMultiplier } from './model-registry.js';
import { freshnessDecay } from '../recall/ranker.js';
import type { ContentSearchHit } from '../page-content/types.js';
import { analyzeQuery, composeLexicalQuery, type QueryAnalysis } from './query-analysis.js';
import {
  backfillFromPageEvidence,
  backfillFromRecallIndex,
  backfillVectors,
  computeSourceSignatures,
  recallStoreIsEmpty,
  type SourceSignatures,
} from './store/backfill.js';
import { openSqliteRecallStore } from './store/sqlite.js';
import type { RecallStore, StoreFtsHit } from './store/types.js';
import { logShadowDiff, shadowQueryEnabled, shadowVariantsFromEnv } from './shadow.js';
import { rerank } from './rerank.js';
import type { RecallServedPayload } from '../recall/events.js';
import type {
  CandidateGeneratorOutput,
  RecallCandidate,
  RecallEvidence,
  RecallIntent,
  RecallRequest,
  RecallResponse,
  RecallSourceKind,
  RecallStrategy,
  SuppressionPolicy,
} from './types.js';

const DEFAULT_LIMIT = 12;
const DEFAULT_PER_SOURCE_LIMIT = 20;
const DEFAULT_MIN_HIT_AGE_MS = 5 * 60 * 1000;
const RRF_K = 60;
// Phase 5 of the recall+ranker v2 hard-replacement.
//
// The pipeline library default stays 0 (off) so unit tests don't pay
// the cost of loading the cross-encoder model (loading the ONNX
// runtime under Bun can crash; the eval harness opts in explicitly).
// The PRODUCTION /v2/recall endpoint in http/server.ts overrides this
// to DOGFOOD_RERANK_TOP_K so every served impression goes through the
// MiniLM precision layer. Callers can still override per-request.
const DEFAULT_RERANK_TOP_K = 0;

/** Injectable embedder — tests can substitute a deterministic stub. */
export type EmbedFn = (texts: readonly string[]) => Promise<readonly Float32Array[]>;

export interface PipelineDeps {
  readonly vaultRoot: string;
  /** Defaults to the production embedder. */
  readonly embed?: EmbedFn;
  /** Defaults to `Date.now`. Tests inject for time-decay / freshness checks. */
  readonly now?: () => number;
  /** P1 — embedder lifecycle. When the embedder is still warming or
   *  has failed, the pipeline degrades to lexical-only so the user
   *  sees something instead of an empty popover. Defaults to 'ready'
   *  for tests; production wires `context.getEmbedderStatus`. */
  readonly embedderState?: 'disabled' | 'cold' | 'warming' | 'ready' | 'failed';
  /** P2 — pre-opened SQLite recall store. When provided, lexical
   *  candidate generators (page-content, timeline-visit, chat-turn
   *  lexical) query FTS5 instead of MiniSearch. Tests inject a
   *  per-fixture in-memory store. Production opens a per-vault
   *  on-disk store and caches it. When omitted the legacy MiniSearch
   *  path is used (safe fallback during the SQLite rollout). */
  readonly store?: RecallStore;
  /** Phase 0 — impression logging. When provided, every successful
   *  /v2/recall response writes a `recall.served` event for the
   *  group-level ranker trainer. Fire-and-forget; errors are logged
   *  but never block the response. Tests can omit; production wires
   *  through eventLog.appendServerObserved. */
  readonly appendImpression?: (payload: RecallServedPayload) => Promise<void>;
  /** Phase 0 — monotonic per-replica sequence emitter for ordering
   *  recall.served vs recall.action records. Production wires through
   *  the event log's HLC; tests inject a counter. Default: now(). */
  readonly nextSequenceNumber?: () => number;
}

// Per-vault SQLite store cache. Opened lazily on first /v2/recall;
// rebuilt from JSON sources when empty. The companion is single-user
// + single-vault so one entry is enough; map keyed on vaultRoot for
// safety if that changes.
const storeCache = new Map<string, Promise<RecallStore>>();

// Per-vault single-flight guard for `ensureFreshBackfill`. Concurrent
// /v2/recall callers (the SW fires several when content scripts
// re-attach after reload) all await the same in-flight backfill
// promise instead of each running a fresh ~7000-row chat-turn upsert
// loop. Without this guard the loops compound and starve /v1/status
// for tens of seconds. The promise is cleared in finally so a fresh
// signature change always runs a new backfill.
const backfillInFlight = new Map<string, Promise<void>>();

// Per-source signature metadata keys. Split (vs the prior combined
// `source_signature_v1`) so a fresh page-evidence write doesn't
// invalidate chat-turn or vector signatures — those backfills only
// re-run when their own source files moved. See Codex review notes
// 2026-05-25.
const SIG_KEY_PAGE_EVIDENCE = 'sig_v2_page_evidence';
const SIG_KEY_CHAT_TURN = 'sig_v2_chat_turn';
const SIG_KEY_VECTORS = 'sig_v2_vectors';

const getOrOpenStore = async (vaultRoot: string): Promise<RecallStore> => {
  let openPromise = storeCache.get(vaultRoot);
  if (openPromise === undefined) {
    openPromise = (async () => openSqliteRecallStore(vaultRoot))();
    storeCache.set(vaultRoot, openPromise);
  }
  const store = await openPromise;
  await ensureFreshBackfill(vaultRoot, store);
  return store;
};

/** Re-runs backfill phases whose source signature changed. Cheap
 *  (3 dir stats) when nothing's moved. Single-flight per vault so
 *  concurrent /v2/recall callers share one backfill pass instead of
 *  each running 7000+ sync upserts.
 *
 *  Per-source split (2026-05-25): a new page visit only re-runs
 *  page-evidence backfill, not chat-turn or vectors. */
const ensureFreshBackfill = async (
  vaultRoot: string,
  store: RecallStore,
): Promise<void> => {
  const existing = backfillInFlight.get(vaultRoot);
  if (existing !== undefined) return existing;
  const promise = (async () => {
    try {
      await runFreshnessCheck(vaultRoot, store);
    } finally {
      // Always release the slot so the NEXT change can trigger
      // another pass. Even on rejection — Codex guidance: do not
      // poison the cache. The next caller retries cleanly.
      backfillInFlight.delete(vaultRoot);
    }
  })();
  backfillInFlight.set(vaultRoot, promise);
  return promise;
};

const runFreshnessCheck = async (
  vaultRoot: string,
  store: RecallStore,
): Promise<void> => {
  const current: SourceSignatures = await computeSourceSignatures(vaultRoot);
  const storedPageEvidence = store.getRecallMetadata(SIG_KEY_PAGE_EVIDENCE);
  const storedChatTurn = store.getRecallMetadata(SIG_KEY_CHAT_TURN);
  const storedVectors = store.getRecallMetadata(SIG_KEY_VECTORS);
  // Empty-store bootstrap: nothing stored yet → all three phases run.
  const wasEmpty = recallStoreIsEmpty(store);
  const ran: string[] = [];
  const phaseTimings: Record<string, number> = {};
  let pageContentN = 0;
  let timelineVisitN = 0;
  let chatTurnN = 0;
  let vectorsN = 0;
  let deletedN = 0;
  if (wasEmpty || storedPageEvidence !== current.pageEvidence) {
    const r = await backfillFromPageEvidence(vaultRoot, store);
    pageContentN = r.pageContent;
    timelineVisitN = r.timelineVisit;
    deletedN += r.deleted;
    for (const [k, v] of Object.entries(r.timingMs)) phaseTimings[`pageEv.${k}`] = v;
    store.setRecallMetadata(SIG_KEY_PAGE_EVIDENCE, current.pageEvidence);
    ran.push('page-evidence');
  }
  if (wasEmpty || storedChatTurn !== current.chatTurn) {
    const r = await backfillFromRecallIndex(vaultRoot, store);
    chatTurnN = r.chatTurn;
    deletedN += r.deleted;
    for (const [k, v] of Object.entries(r.timingMs)) phaseTimings[`chat.${k}`] = v;
    store.setRecallMetadata(SIG_KEY_CHAT_TURN, current.chatTurn);
    ran.push('chat-turn');
  }
  if (wasEmpty || storedVectors !== current.vectors) {
    const r = await backfillVectors(vaultRoot, store);
    vectorsN = r.vectors;
    deletedN += r.deleted;
    for (const [k, v] of Object.entries(r.timingMs)) phaseTimings[`vec.${k}`] = v;
    store.setRecallMetadata(SIG_KEY_VECTORS, current.vectors);
    ran.push('vectors');
  }
  if (ran.length === 0) return;
  const timingStr = Object.entries(phaseTimings)
    .map(([k, v]) => `${k}=${String(v)}ms`)
    .join(' ');
  // eslint-disable-next-line no-console
  console.warn(
    `[recall-v2] backfill ran=${ran.join(',')} ` +
      `pageContent=${String(pageContentN)} ` +
      `timelineVisit=${String(timelineVisitN)} ` +
      `chatTurn=${String(chatTurnN)} ` +
      `vectors=${String(vectorsN)}` +
      `${deletedN > 0 ? ` deleted=${String(deletedN)}` : ''}` +
      `${store.vectorBackendAvailable ? '' : ' (vec disabled)'}` +
      `${wasEmpty ? ' (initial)' : ''}` +
      ` :: ${timingStr}`,
  );
};

const hashEntity = (input: string): string =>
  createHash('sha256').update(input).digest('hex').slice(0, 24);

/** Build a stable entityId for a hit. URL-bearing hits hash the canonical
 *  URL; chat-only hits hash the threadId; anchorNodeId is the last fallback. */
const entityIdFor = (hit: {
  readonly canonicalUrl?: string;
  readonly threadId?: string;
  readonly id?: string;
}): string => {
  if (hit.canonicalUrl !== undefined && hit.canonicalUrl.length > 0) {
    return `url:${hashEntity(hit.canonicalUrl)}`;
  }
  if (hit.threadId !== undefined && hit.threadId.length > 0) {
    return `thread:${hit.threadId}`;
  }
  return `id:${hit.id ?? 'unknown'}`;
};

const sourceKindFromContentHit = (
  k: ContentSearchHit['sourceKind'],
): RecallSourceKind => {
  if (k === 'page-content') return 'page_content';
  if (k === 'chat-turn') return 'chat_turn';
  if (k === 'timeline-visit') return 'timeline_visit';
  if (k === 'semantic-recall-pool') return 'semantic_query';
  return 'page_content';
};

const evidenceFromContentHit = (
  hit: ContentSearchHit,
  retriever: RecallEvidence['retriever'],
  rank: number,
): RecallEvidence => {
  const sourceKind = sourceKindFromContentHit(hit.sourceKind);
  const ev: RecallEvidence = {
    retriever,
    sourceKind,
    rawScore: hit.score,
    rank,
    ...(hit.sourceEvidence !== undefined
      ? { vectorDistance: 1 - hit.sourceEvidence.similarity }
      : {}),
  };
  return ev;
};

/** Build a candidate from a SQLite FTS5 hit. Parallel to
 *  candidateFromContentHit but with the StoreFtsHit shape. */
const candidateFromStoreHit = (
  hit: StoreFtsHit,
  retriever: RecallEvidence['retriever'],
  rank: number,
): RecallCandidate => {
  const sourceKind: RecallSourceKind =
    hit.sourceKind === 'page_content'
      ? 'page_content'
      : hit.sourceKind === 'timeline_visit'
        ? 'timeline_visit'
        : 'chat_turn';
  const capturedIso = hit.capturedAtMs !== undefined
    ? new Date(hit.capturedAtMs).toISOString()
    : undefined;
  return {
    candidateId: hit.entityId,
    entityId: hit.entityId,
    sourceKind,
    ...(hit.canonicalUrl === undefined ? {} : { canonicalUrl: hit.canonicalUrl }),
    ...(hit.title === undefined ? {} : { title: hit.title }),
    ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
    ...(hit.threadId === undefined ? {} : { threadId: hit.threadId }),
    ...(capturedIso === undefined ? {} : { lastSeenAt: capturedIso }),
    fusedScore: 1 / (RRF_K + rank),
    evidence: [
      {
        retriever,
        sourceKind,
        rawScore: hit.bm25,
        rank,
      },
    ],
  };
};

const candidateFromContentHit = (
  hit: ContentSearchHit,
  retriever: RecallEvidence['retriever'],
  rank: number,
): RecallCandidate => {
  const sourceKind = sourceKindFromContentHit(hit.sourceKind);
  return {
    candidateId: hit.id,
    entityId: entityIdFor(hit),
    sourceKind,
    ...(hit.canonicalUrl === undefined ? {} : { canonicalUrl: hit.canonicalUrl }),
    ...(hit.title === undefined ? {} : { title: hit.title }),
    ...(hit.snippet === undefined ? {} : { snippet: hit.snippet }),
    ...(hit.threadId === undefined ? {} : { threadId: hit.threadId }),
    // Propagate capturedAt so the freshness multiplier in fusion has
    // something to work with. Without this, all candidates are treated
    // as "no timestamp" → freshness = 1 → ties broken alphabetically
    // by URL (root cause of time-decay R@5=0).
    lastSeenAt: hit.capturedAt,
    fusedScore: 1 / (RRF_K + rank),
    evidence: [evidenceFromContentHit(hit, retriever, rank)],
  };
};

const timeoutMs = (start: number, now: () => number): number => now() - start;

/** Page-content candidate generator. Prefers SQLite FTS5 when a store
 *  is available; falls back to the legacy MiniSearch path otherwise.
 *  Both consume the query-analysis composed string so the same
 *  stopword-stripping behavior applies. */
const generatePageContent = async (
  deps: PipelineDeps,
  analysis: QueryAnalysis,
  limit: number,
  store: RecallStore | undefined,
): Promise<CandidateGeneratorOutput> => {
  const start = (deps.now ?? Date.now)();
  const composedQ = composeLexicalQuery(analysis);
  if (store !== undefined) {
    const hits = store.queryFts({ q: composedQ, sourceKind: 'page_content', limit });
    return {
      sourceKind: 'page_content',
      candidates: hits.map((h, i) => candidateFromStoreHit(h, 'fts5', i + 1)),
      elapsedMs: timeoutMs(start, deps.now ?? Date.now),
    };
  }
  const hits = await queryPageContent(deps.vaultRoot, composedQ, { limit });
  return {
    sourceKind: 'page_content',
    candidates: hits.map((h, i) => candidateFromContentHit(h, 'bm25', i + 1)),
    elapsedMs: timeoutMs(start, deps.now ?? Date.now),
  };
};

/** Timeline-visit candidate generator (title+URL only). */
const generateTimelineVisit = async (
  deps: PipelineDeps,
  analysis: QueryAnalysis,
  limit: number,
  store: RecallStore | undefined,
): Promise<CandidateGeneratorOutput> => {
  const start = (deps.now ?? Date.now)();
  const composedQ = composeLexicalQuery(analysis);
  if (store !== undefined) {
    const hits = store.queryFts({ q: composedQ, sourceKind: 'timeline_visit', limit });
    return {
      sourceKind: 'timeline_visit',
      candidates: hits.map((h, i) => candidateFromStoreHit(h, 'fts5', i + 1)),
      elapsedMs: timeoutMs(start, deps.now ?? Date.now),
    };
  }
  const hits = await queryTimelineVisits(deps.vaultRoot, composedQ, { limit });
  return {
    sourceKind: 'timeline_visit',
    candidates: hits.map((h, i) => candidateFromContentHit(h, 'fts5', i + 1)),
    elapsedMs: timeoutMs(start, deps.now ?? Date.now),
  };
};

/** Chat-turn candidate generator.
 *
 *  Prefers SQLite FTS5 via `store.queryFts` — same path the page-
 *  content/timeline-visit generators use. Falls back to the legacy
 *  MiniSearch+rankHybrid path only when no store is injected (older
 *  test fixtures + the safe-fallback runtime path).
 *
 *  WHY: the legacy path called `readIndex()` (deserialize 7000+
 *  items), built a fresh MiniSearch index, and ran `rankHybrid`
 *  over every item — all synchronously, on the main thread, on
 *  EVERY /v2/recall call. Measured ~7.5s per query on the user's
 *  vault, which is the dominant cause of /v1/status starvation
 *  under SW reload (Codex review 2026-05-25 + dogfood repro).
 *  FTS5 keeps the index hot in WAL and matches in ms. */
const generateChatTurn = async (
  deps: PipelineDeps,
  analysis: QueryAnalysis,
  limit: number,
  queryEmbedding: Float32Array | undefined,
  store: RecallStore | undefined,
): Promise<CandidateGeneratorOutput> => {
  const start = (deps.now ?? Date.now)();
  const composedQ = composeLexicalQuery(analysis);
  if (store !== undefined) {
    const hits = store.queryFts({ q: composedQ, sourceKind: 'chat_turn', limit });
    return {
      sourceKind: 'chat_turn',
      candidates: hits.map((h, i) => candidateFromStoreHit(h, 'fts5', i + 1)),
      elapsedMs: timeoutMs(start, deps.now ?? Date.now),
    };
  }
  // Legacy fallback — only hit when caller didn't inject a store.
  // This is the path the eval fixtures use; production always wires
  // the SQLite store via getOrOpenStore.
  const indexPath = recallIndexPath(deps.vaultRoot);
  const index = await readIndex(indexPath);
  if (index === null || index.items.length === 0) {
    return { sourceKind: 'chat_turn', candidates: [], elapsedMs: timeoutMs(start, deps.now ?? Date.now) };
  }
  const lexical = buildLexicalIndex(index.items);
  const queryVec = queryEmbedding ?? new Float32Array(384);
  const ranked = rankHybrid(composedQ, queryVec, index.items, new Date(), {
    limit,
    lexical,
  }).filter((item) => item.lexical !== undefined);
  const candidates: RecallCandidate[] = ranked.map((r, i) => {
    const meta = r.metadata;
    const canonicalUrl = meta?.threadUrl;
    const title = meta?.title;
    return {
      candidateId: r.id,
      entityId: entityIdFor({
        ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
        threadId: r.threadId,
      }),
      sourceKind: 'chat_turn',
      ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
      ...(title === undefined ? {} : { title }),
      threadId: r.threadId,
      lastSeenAt: r.capturedAt,
      fusedScore: 1 / (RRF_K + (i + 1)),
      evidence: [
        {
          retriever: 'dense',
          sourceKind: 'chat_turn',
          rawScore: r.score,
          rank: i + 1,
          ...(r.lexical !== undefined
            ? { matchedFields: ['lexical-rank-' + String(r.lexical.rank)] }
            : {}),
        },
      ],
    };
  });
  return {
    sourceKind: 'chat_turn',
    candidates,
    elapsedMs: timeoutMs(start, deps.now ?? Date.now),
  };
};

// Absolute floor for semantic-query candidates — anything below this
// is treated as orthogonal noise regardless of relative ranking.
const SEMANTIC_ABSOLUTE_MIN_COSINE = 0.15;
// Relative floor: a candidate must clear `RELATIVE_FRACTION * topCosine`
// to enter the fused list. Adapts to fixture quality: when the top
// hit is strong (cosine ≈ 1), weak hits (cosine ≈ 0) are filtered;
// when the top hit is mediocre (cosine ≈ 0.5), the bar relaxes so
// near-equal candidates survive. Root cause of the cve baseline
// (forbidden = 0.6) was orthogonal docs leaking through the fixed
// top-K; relative scoping with both floors fixes that without
// degrading fixtures where the corpus has weaker peak similarity.
const SEMANTIC_RELATIVE_FRACTION = 0.5;

/** Semantic-query candidate generator (query-anchored cosine).
 *  Prefers SQLite docs_vec via store.queryVector when sqlite-vec is
 *  available (catches up to "vector substrate alongside FTS5" in the
 *  same SQLite db). Falls back to the JSON-sidecar
 *  expandSemanticByQuery when not. */
const generateSemanticQuery = async (
  deps: PipelineDeps,
  limit: number,
  queryEmbedding: Float32Array | undefined,
  excludeUrls: ReadonlySet<string>,
  store: RecallStore | undefined,
): Promise<CandidateGeneratorOutput> => {
  const start = (deps.now ?? Date.now)();
  if (queryEmbedding === undefined) {
    return { sourceKind: 'semantic_query', candidates: [], elapsedMs: timeoutMs(start, deps.now ?? Date.now) };
  }
  type CandidateLike = {
    entityId?: string;
    canonicalUrl: string;
    title?: string;
    cosine: number;
  };
  let rawHits: readonly CandidateLike[] = [];
  if (store !== undefined && store.vectorBackendAvailable) {
    const excludeIds = new Set<string>();
    for (const url of excludeUrls) {
      const { createHash } = await import('node:crypto');
      excludeIds.add(`url:${createHash('sha256').update(url).digest('hex').slice(0, 24)}`);
    }
    const vecHits = store.queryVector({
      vec: queryEmbedding,
      limit: Math.max(limit * 2, 20),
      excludeEntityIds: excludeIds,
    });
    if (vecHits.length > 0) {
      rawHits = vecHits
        .filter((h) => h.canonicalUrl !== undefined && h.canonicalUrl.length > 0)
        .map((h) => ({
          entityId: h.entityId,
          canonicalUrl: h.canonicalUrl!,
          ...(h.title === undefined ? {} : { title: h.title }),
          cosine: 1 - h.cosineDistance,
        }));
    }
  }
  if (rawHits.length === 0) {
    const vectors = await readSemanticRecallVectorStore(deps.vaultRoot, MODEL_ID);
    rawHits = expandSemanticByQuery(vectors, queryEmbedding, {
      limit,
      exclude: excludeUrls,
    });
  }
  const topCosine = rawHits.length > 0 ? rawHits[0]!.cosine : 0;
  const dynamicFloor = Math.max(
    SEMANTIC_ABSOLUTE_MIN_COSINE,
    SEMANTIC_RELATIVE_FRACTION * topCosine,
  );
  const filtered = rawHits.filter((h) => h.cosine >= dynamicFloor);
  // Score-modulated RRF (smooth gap-based gate). For the e5-small
  // embedder, queries with `top - p50` gap < 0.03 are flat noise
  // (every candidate at the noise floor); the gate mutes them.
  // Thresholds live in model-registry.ts.
  const filteredCosinesDesc = filtered.map((h) => h.cosine).sort((a, b) => b - a);
  const p50Cosine =
    filteredCosinesDesc.length > 0
      ? filteredCosinesDesc[Math.floor(filteredCosinesDesc.length * 0.5)]!
      : 0;
  const minCosine =
    filteredCosinesDesc.length > 0
      ? filteredCosinesDesc[filteredCosinesDesc.length - 1]!
      : 0;
  const profile = profileFor(MODEL_ID);
  const gateMultiplier = semanticContributionMultiplier(
    profile,
    topCosine,
    p50Cosine,
    minCosine,
    filteredCosinesDesc.length,
  );
  if (gateMultiplier === 0) {
    return {
      sourceKind: 'semantic_query',
      candidates: [],
      elapsedMs: timeoutMs(start, deps.now ?? Date.now),
    };
  }
  const hits = filtered.slice(0, limit);
  const candidates: RecallCandidate[] = hits.map((h, i) => ({
    candidateId: `semantic-query:${h.canonicalUrl}`,
    entityId: h.entityId ?? entityIdFor({ canonicalUrl: h.canonicalUrl }),
    sourceKind: 'semantic_query',
    canonicalUrl: h.canonicalUrl,
    ...(h.title === undefined ? {} : { title: h.title }),
    fusedScore: gateMultiplier / (RRF_K + (i + 1)),
    evidence: [
      {
        retriever: 'dense',
        sourceKind: 'semantic_query',
        rawScore: h.cosine,
        vectorDistance: 1 - h.cosine,
        rank: i + 1,
      },
    ],
  }));
  return { sourceKind: 'semantic_query', candidates, elapsedMs: timeoutMs(start, deps.now ?? Date.now) };
};

/** Graph-neighbor candidate generator (anchor-anchored expansion). */
const generateGraphNeighbor = async (
  deps: PipelineDeps,
  anchorUrls: readonly string[],
  limit: number,
  excludeUrls: ReadonlySet<string>,
): Promise<CandidateGeneratorOutput> => {
  const start = (deps.now ?? Date.now)();
  if (anchorUrls.length === 0) {
    return { sourceKind: 'graph_neighbor', candidates: [], elapsedMs: timeoutMs(start, deps.now ?? Date.now) };
  }
  const pool = await readSemanticRecallPool(deps.vaultRoot);
  if (pool === null) {
    return { sourceKind: 'graph_neighbor', candidates: [], elapsedMs: timeoutMs(start, deps.now ?? Date.now) };
  }
  const rawHits = expandSemanticRecallCandidates(pool, anchorUrls, {
    limit,
    exclude: excludeUrls,
  });
  // Cluster-only neighbours have cosine=0 (they passed the cluster
  // membership test but weren't measured as topically similar). Drop
  // them — they're identity-band noise, not signal. Keeps real
  // graph-neighbor evidence (cosine > 0 from cluster-mates that ARE
  // similar) intact.
  const hits = rawHits.filter((h) => h.cosine >= SEMANTIC_ABSOLUTE_MIN_COSINE);
  const candidates: RecallCandidate[] = hits.map((h, i) => ({
    candidateId: `graph-neighbor:${h.canonicalUrl}`,
    entityId: entityIdFor({ canonicalUrl: h.canonicalUrl }),
    sourceKind: 'graph_neighbor',
    canonicalUrl: h.canonicalUrl,
    fusedScore: 1 / (RRF_K + (i + 1)),
    evidence: [
      {
        retriever: 'dense',
        sourceKind: 'graph_neighbor',
        rawScore: h.cosine,
        vectorDistance: 1 - h.cosine,
        rank: i + 1,
        explain: `via ${h.via}; cluster ${h.clusterId}`,
      },
    ],
  }));
  return { sourceKind: 'graph_neighbor', candidates, elapsedMs: timeoutMs(start, deps.now ?? Date.now) };
};

/** Freshness multiplier for a candidate based on its last-seen-at.
 *  Reuses recall/ranker.ts:freshnessDecay (banded 1/0.85/0.7/0.5/0.3
 *  over 3/21/92/1096 days). Without this, lexically-identical docs
 *  break ties by URL alphabetically — that's the time-decay R@5=0
 *  failure where 2-year-old "old-0" beats 1-day-old "recent-0". */
const freshnessFactor = (cand: RecallCandidate, now: Date): number => {
  const iso = cand.lastSeenAt ?? cand.firstSeenAt;
  if (iso === undefined) return 1;
  return freshnessDecay(iso, now);
};

/** Default RRF fusion across per-source candidate lists. Phase 5 replaces this. */
const fuseRrf = (
  groups: readonly CandidateGeneratorOutput[],
  now: Date,
): RecallCandidate[] => {
  const fused = new Map<string, RecallCandidate>();
  for (const group of groups) {
    for (let i = 0; i < group.candidates.length; i += 1) {
      const cand = group.candidates[i]!;
      const prev = fused.get(cand.entityId);
      // Honor any per-candidate stream multiplier (e.g. the smooth
      // gap-based gate in generateSemanticQuery emits
      // `gateMultiplier / (RRF_K + rank)` into `cand.fusedScore`).
      // Codex review of PR #215: the prior version recomputed pure
      // RRF from list rank here and silently discarded the
      // multiplier — only the hard-drop (multiplier=0 → empty
      // candidates list) ever took effect. Fix: use the candidate's
      // pre-computed contribution as the base, falling back to
      // rank-only RRF when a source doesn't set one (covers all
      // current generators except semantic_query).
      const baseContribution = cand.fusedScore > 0 ? cand.fusedScore : 1 / (RRF_K + (i + 1));
      // Freshness multiplier in [0.3, 1.0] — lets recency break the
      // otherwise-deterministic URL-alphabetical ties in the lexical
      // layer; stacks on top of any stream multiplier from the
      // source generator.
      const contribution = baseContribution * freshnessFactor(cand, now);
      if (prev === undefined) {
        fused.set(cand.entityId, { ...cand, fusedScore: contribution });
      } else {
        // Merge evidence; sum RRF contributions; keep richer fields.
        const mergedEvidence = [...prev.evidence, ...cand.evidence];
        const upgraded: RecallCandidate = {
          ...prev,
          fusedScore: prev.fusedScore + contribution,
          evidence: mergedEvidence,
          ...(prev.snippet === undefined && cand.snippet !== undefined
            ? { snippet: cand.snippet }
            : {}),
          ...(prev.title === undefined && cand.title !== undefined ? { title: cand.title } : {}),
        };
        fused.set(cand.entityId, upgraded);
      }
    }
  }
  const entityDeduped = [...fused.values()].sort((a, b) => b.fusedScore - a.fusedScore);
  return collapseByCanonicalUrl(entityDeduped);
};

/** Second-pass dedupe keyed on `canonical_url` verbatim.
 *
 *  The upstream page-evidence extraction already produces canonical
 *  URLs that preserve structural query params (HN ?id=N, YouTube
 *  ?v=N, etc.). Two candidates with different canonical_url are
 *  different entities — no further transformation. Replaced the
 *  prior `collapseByLocationKey` (2026-05-26 review): the
 *  locationKey transformation stripped query params on paths NOT in
 *  {'/', '/search'}, which silently destroyed HN/YouTube/Reddit
 *  identity-bearing params. */
const collapseByCanonicalUrl = (
  candidates: readonly RecallCandidate[],
): RecallCandidate[] => {
  const byUrl = new Map<string, RecallCandidate>();
  const noKey: RecallCandidate[] = [];
  for (const c of candidates) {
    const key = c.canonicalUrl;
    if (key === undefined || key.length === 0) {
      noKey.push(c);
      continue;
    }
    const prev = byUrl.get(key);
    if (prev === undefined) {
      byUrl.set(key, c);
      continue;
    }
    const winner = c.fusedScore > prev.fusedScore ? c : prev;
    const loser = winner === c ? prev : c;
    byUrl.set(key, {
      ...winner,
      evidence: [...winner.evidence, ...loser.evidence],
      ...(winner.title === undefined && loser.title !== undefined ? { title: loser.title } : {}),
      ...(winner.snippet === undefined && loser.snippet !== undefined
        ? { snippet: loser.snippet }
        : {}),
    });
  }
  return [...byUrl.values(), ...noKey].sort((a, b) => b.fusedScore - a.fusedScore);
};

/** Loose match used by the current-page suppression — strips hash +
 *  trailing slash + `www.` but PRESERVES query params so HN/YouTube
 *  /etc. structural identity stays distinct. For tracker-laden
 *  current URLs the suppression will miss (acceptable trade-off:
 *  false-negative suppression — own page surfaces in results — is
 *  much less harmful than false-positive dedupe collapsing distinct
 *  items). The parameter-cardinality profiler (D5) is the long-term
 *  fix for that residual case. */
const suppressionKey = (url: string | undefined): string | undefined => {
  if (url === undefined || url.length === 0) return undefined;
  try {
    const u = new URL(url);
    u.hash = '';
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/u, '') || '/';
    return `${u.protocol}//${host}${path}${u.search}`;
  } catch {
    return url.toLowerCase();
  }
};

const applySuppression = (
  candidates: readonly RecallCandidate[],
  req: RecallRequest,
  now: number,
): { kept: readonly RecallCandidate[]; dropped: readonly RecallCandidate[] } => {
  const policy = req.suppression ?? {};
  const minAge = policy.minHitAgeMs ?? DEFAULT_MIN_HIT_AGE_MS;
  const currentLoc = suppressionKey(req.session?.currentUrl);
  const currentMode = policy.suppressCurrentPage ?? 'always';
  const activeChats = new Set(policy.suppressActiveChatBacIds ?? []);
  const excluded = new Set([
    ...(policy.excludeEntityIds ?? []),
    ...(req.session?.excludeEntityIds ?? []),
  ]);

  const kept: RecallCandidate[] = [];
  const dropped: RecallCandidate[] = [];
  for (const c of candidates) {
    const reasons: string[] = [];
    if (excluded.has(c.entityId)) reasons.push('explicit-exclude');
    if (currentMode === 'always' && currentLoc !== undefined) {
      const candLoc = suppressionKey(c.canonicalUrl);
      if (candLoc !== undefined && candLoc === currentLoc) reasons.push('current-page');
    }
    if (c.threadId !== undefined && activeChats.has(c.threadId)) {
      reasons.push('active-chat');
    }
    if (minAge > 0 && c.lastSeenAt !== undefined) {
      const ts = Date.parse(c.lastSeenAt);
      if (!Number.isNaN(ts) && now - ts < minAge) reasons.push('too-fresh');
    }
    if (reasons.length === 0) {
      kept.push(c);
    } else {
      dropped.push({ ...c, suppressedReasons: reasons });
    }
  }
  return { kept, dropped };
};

// Phase 4 — graph_neighbor is DEMOTED. The Similar tier is now
// query-anchored (semantic_query); graph-neighbor is an opt-in
// "Related context" facet that callers can request explicitly.
// Default sources don't include it.
const allSources: readonly RecallSourceKind[] = [
  'page_content',
  'timeline_visit',
  'chat_turn',
  'semantic_query',
];

// Scope A/B — per-intent source-profile + suppression defaults. The
// extension picks an intent (dejavu / search / focus) and the server
// resolves it into the right source set + suppression posture
// without the client having to hard-code the profile. Callers can
// still override by passing explicit `sources` / `suppression`.
const SOURCES_BY_INTENT: Readonly<Record<RecallIntent, readonly RecallSourceKind[]>> = {
  // Déjà-vu — user selected text on a page; want everything that
  // relates. Includes graph_neighbor so prior captures of the same
  // topic surface even when direct lexical/semantic miss.
  dejavu: ['page_content', 'timeline_visit', 'chat_turn', 'semantic_query', 'graph_neighbor'],
  // Search — global recall; graph_neighbor stays a future opt-in so
  // we don't surface tangential cluster-mates for an exact query.
  search: ['page_content', 'timeline_visit', 'chat_turn', 'semantic_query'],
  // Focus — Now card; current-page-anchored. The `focus` source
  // looks up the active URL directly; graph_neighbor expands from
  // there for "related" context.
  focus: ['focus', 'timeline_visit', 'graph_neighbor'],
};

const SUPPRESSION_BY_INTENT: Readonly<Record<RecallIntent, SuppressionPolicy>> = {
  // Déjà-vu — drop the current page (we already know we're on it)
  // and active-chat artifacts (a chat the user just opened isn't
  // "déjà-vu"). Default to today's strict suppressCurrentPage.
  dejavu: {
    suppressCurrentPage: 'always',
    suppressAskAiArtifacts: true,
  },
  // Search — global query, no current-page context implied. Keep
  // the current page available so the user can find what they're
  // looking at. Still respects activeChatBacIds if the caller
  // passes them.
  search: {
    suppressCurrentPage: 'never',
    suppressAskAiArtifacts: false,
    // No min-hit-age filter for search — the user typed a query, so
    // returning a chat they just created IS the right answer.
    minHitAgeMs: 0,
  },
  // Focus — keep the current page; the Now card surfaces it as the
  // anchor and shows related items around it.
  focus: {
    suppressCurrentPage: 'never',
    suppressAskAiArtifacts: false,
    minHitAgeMs: 0,
  },
};

const resolveIntent = (req: RecallRequest): RecallIntent => req.intent ?? 'dejavu';

const resolveSources = (req: RecallRequest, intent: RecallIntent): Set<RecallSourceKind> =>
  new Set(req.sources ?? SOURCES_BY_INTENT[intent]);

const resolveSuppression = (req: RecallRequest, intent: RecallIntent): RecallRequest => {
  // When the caller passes an explicit `suppression` object, respect
  // it verbatim. Otherwise merge intent defaults onto the request.
  if (req.suppression !== undefined) return req;
  return { ...req, suppression: SUPPRESSION_BY_INTENT[intent] };
};

/** `focus` candidate generator — direct canonical-URL lookup against
 *  the SQLite docs table. Returns the active page itself (and any
 *  same-URL variants stored under different source_kind rows) as
 *  recall candidates. Pairs with `graph_neighbor` for expansion. */
const generateFocus = async (
  deps: PipelineDeps,
  currentUrl: string | undefined,
  limit: number,
  store: RecallStore | undefined,
): Promise<CandidateGeneratorOutput> => {
  const start = (deps.now ?? Date.now)();
  if (currentUrl === undefined || currentUrl.length === 0 || store === undefined) {
    return { sourceKind: 'focus', candidates: [], elapsedMs: timeoutMs(start, deps.now ?? Date.now) };
  }
  const hits = store.queryByCanonicalUrl({ canonicalUrl: currentUrl, limit });
  const candidates = hits.map((h, i): RecallCandidate => candidateFromStoreHit(h, 'fts5', i + 1));
  // Tag the source kind so the UI can render a "this page" badge.
  // candidateFromStoreHit emits the hit's own sourceKind on the
  // candidate; rewrite here so the Now card knows these came from
  // the focus path, not from a generic timeline-visit query.
  const focusCandidates = candidates.map((c): RecallCandidate => ({ ...c, sourceKind: 'focus' }));
  return {
    sourceKind: 'focus',
    candidates: focusCandidates,
    elapsedMs: timeoutMs(start, deps.now ?? Date.now),
  };
};

/** Run the recall pipeline (Phase 2 v1.5 delegate). */
export const runRecall = async (
  deps: PipelineDeps,
  rawReq: RecallRequest,
): Promise<RecallResponse> => {
  // Scope B — resolve intent + merge per-intent defaults FIRST so
  // every downstream step (sources, suppression, response meta) sees
  // a fully-populated request.
  const intent = resolveIntent(rawReq);
  const req = resolveSuppression(rawReq, intent);
  const sources = resolveSources(req, intent);
  const now = (deps.now ?? Date.now)();
  const limit = req.limit ?? DEFAULT_LIMIT;
  const perSource = req.perSourceLimit ?? DEFAULT_PER_SOURCE_LIMIT;
  const strategy: RecallStrategy = req.strategy ?? {};
  const timings: Record<string, number> = {};

  // chat_turn used to need an embedding for the legacy rankHybrid path
  // (dense + lexical combined). The current generator routes through
  // store.queryFts only — purely lexical — so the embed cost is wasted
  // when chat_turn is the ONLY semantic-flavored source requested.
  // semantic_query (vec0 KNN) is the one path that genuinely needs the
  // query embedding. graph_neighbor expands from anchor URLs already
  // present in upstream candidates, so it also doesn't need its own
  // query embedding here. (Codex review nit, 2026-05-25.)
  const wantsEmbedding = sources.has('semantic_query');
  // P1 — embedder lifecycle. ready/disabled = use embedder; everything
  // else (cold/warming/failed) = degrade to lexical-only with an
  // explicit flag in response.meta.flags so the UI can render a hint.
  const embedderState = deps.embedderState ?? 'ready';
  const embedderUsable = embedderState === 'ready' || embedderState === 'disabled';
  let queryEmbedding: Float32Array | undefined;
  let embedderError: string | undefined;
  let degradedToLexical = false;
  if (wantsEmbedding && embedderUsable) {
    const embedStart = (deps.now ?? Date.now)();
    try {
      const embedder = deps.embed ?? embed;
      const [vec] = await embedder([req.q]);
      queryEmbedding = vec;
    } catch (err) {
      embedderError = err instanceof Error ? err.message : String(err);
      degradedToLexical = true;
      console.warn('[recall-v2] query embedding failed:', err);
    }
    timings['embed'] = (deps.now ?? Date.now)() - embedStart;
  } else if (wantsEmbedding) {
    // Embedder not usable — record explicit degradation so the response
    // doesn't pretend semantic + chat-turn-vector worked.
    degradedToLexical = true;
  }

  // Phase 6 — analyze the query ONCE; downstream lexical generators
  // consume it instead of re-tokenizing. Stripping weak/stopword
  // tokens is the load-bearing change for the cve/network/rare-term
  // drift cases observed in the v1.5 baseline.
  const analysis = analyzeQuery(req.q);

  // P2 — resolve a SQLite store if one isn't injected. Tests inject a
  // per-fixture in-memory store; production lazily opens + caches a
  // per-vault on-disk store.
  let store: RecallStore | undefined = deps.store;
  if (store === undefined) {
    try {
      store = await getOrOpenStore(deps.vaultRoot);
    } catch (err) {
      // SQLite open failed — fall back to MiniSearch path silently.
      console.warn('[recall-v2] SQLite store open failed; falling back:', err);
    }
  }
  const groups: CandidateGeneratorOutput[] = [];
  // Scope B/C — `focus` runs FIRST when present, so its canonicalUrl
  // is in the anchor pool used by semantic_query + graph_neighbor.
  // This lets the Now card request just `focus + graph_neighbor` and
  // get expansion from the current page automatically.
  if (sources.has('focus')) {
    groups.push(await generateFocus(deps, req.session?.currentUrl, perSource, store));
  }
  if (sources.has('page_content')) {
    groups.push(await generatePageContent(deps, analysis, perSource, store));
  }
  if (sources.has('timeline_visit')) {
    groups.push(await generateTimelineVisit(deps, analysis, perSource, store));
  }
  if (sources.has('chat_turn')) {
    groups.push(await generateChatTurn(deps, analysis, perSource, queryEmbedding, store));
  }
  let anchorUrls: string[] = [];
  // Seed graph expansion with `focus` results FIRST when present (the
  // Now card's intent: "what is connected to THIS page"). Falls back
  // to lexical-anchor expansion when focus is empty / not requested.
  const focusAnchors = new Set(
    groups
      .filter((g) => g.sourceKind === 'focus')
      .flatMap((g) => g.candidates)
      .map((c) => c.canonicalUrl)
      .filter((u): u is string => u !== undefined),
  );
  // For focus-only intents (no lexical query), the `session.currentUrl`
  // is the authoritative anchor even if no focus candidates were found
  // in our docs table (page not indexed yet). Use it as a fallback
  // anchor so graph_neighbor still has something to expand from.
  if (focusAnchors.size === 0 && req.session?.currentUrl !== undefined) {
    focusAnchors.add(req.session.currentUrl);
  }
  if (sources.has('semantic_query')) {
    const lexicalAnchors = new Set([
      ...focusAnchors,
      ...groups
        .flatMap((g) => g.candidates)
        .map((c) => c.canonicalUrl)
        .filter((u): u is string => u !== undefined),
    ]);
    anchorUrls = [...lexicalAnchors];
    groups.push(await generateSemanticQuery(deps, perSource, queryEmbedding, lexicalAnchors, store));
  }
  if (sources.has('graph_neighbor')) {
    const excludeUrls = new Set(
      groups
        .flatMap((g) => g.candidates)
        .map((c) => c.canonicalUrl)
        .filter((u): u is string => u !== undefined),
    );
    // For focus-driven expansion, graph_neighbor should expand from
    // focusAnchors (the current page) instead of the lexical-anchor
    // pool. When focus is empty, fall back to anchorUrls (the same
    // set semantic_query used) for backward compatibility.
    const seedAnchors = focusAnchors.size > 0 ? [...focusAnchors] : anchorUrls;
    groups.push(await generateGraphNeighbor(deps, seedAnchors, perSource, excludeUrls));
  }

  for (const g of groups) {
    timings[`source.${g.sourceKind}`] = g.elapsedMs;
  }

  const fuseStart = (deps.now ?? Date.now)();
  const fused = fuseRrf(groups, new Date(now));
  timings['fuse'] = (deps.now ?? Date.now)() - fuseStart;

  const suppressStart = (deps.now ?? Date.now)();
  const { kept, dropped } = applySuppression(fused, req, now);
  timings['suppress'] = (deps.now ?? Date.now)() - suppressStart;

  // P7 — optional cross-encoder rerank. Off by default; on when the
  // caller sets `strategy.rerankTopK > 0`. Reranks the top-N+buffer
  // and re-orders by the cross-encoder relevance score.
  //
  // Phase 0 — capture pre-rerank ranks so meta.rerank.rankMovement can
  // surface "how far did each candidate move." Snapshot is cheap (one
  // pass over kept); used only when rerank fires.
  const preRerankRankByEntity = new Map<string, number>();
  for (let i = 0; i < kept.length; i += 1) {
    const e = kept[i]?.entityId;
    if (e !== undefined) preRerankRankByEntity.set(e, i);
  }
  let resultsAfterRerank = kept;
  let rerankApplied = false;
  let rerankLatencyMs = 0;
  // Pipeline default = 0 (off). Production /v2 endpoint overrides via
  // `strategy.rerankTopK = DOGFOOD_RERANK_TOP_K` so dogfood always
  // exercises the cross-encoder; unit tests stay deterministic.
  const rerankTopK = strategy.rerankTopK ?? DEFAULT_RERANK_TOP_K;
  if (rerankTopK > 0 && kept.length > 0) {
    const rerankStart = (deps.now ?? Date.now)();
    resultsAfterRerank = await rerank(req.q, kept, Math.min(rerankTopK, kept.length));
    rerankLatencyMs = (deps.now ?? Date.now)() - rerankStart;
    timings['rerank'] = rerankLatencyMs;
    rerankApplied = true;
  }
  const results = resultsAfterRerank.slice(0, limit);
  const perSourceCounts: Record<RecallSourceKind, number> = {
    page_content: 0,
    timeline_visit: 0,
    chat_turn: 0,
    semantic_query: 0,
    graph_neighbor: 0,
    current_session: 0,
    focus: 0,
  };
  for (const g of groups) perSourceCounts[g.sourceKind] = g.candidates.length;

  // Phase 0 — assemble + emit the impression record. Fire-and-forget
  // so /v2/recall latency stays unchanged on slow appenders; errors
  // go to console and the response still completes. servedContextId
  // is sha256 of (query + sessionContext + now + RRF count) so two
  // identical-looking requests at different times get distinct ids.
  const servedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const servedContextId = createHash('sha256')
    .update(
      [
        req.q,
        JSON.stringify(req.session ?? {}),
        servedAt,
        String(results.length),
        String((deps.now ?? Date.now)()),
      ].join(' '),
    )
    .digest('hex')
    .slice(0, 24);

  let rankMovement: readonly { readonly entityId: string; readonly delta: number }[] | undefined;
  if (rerankApplied) {
    const moves: { entityId: string; delta: number }[] = [];
    for (let postRank = 0; postRank < resultsAfterRerank.length; postRank += 1) {
      const cand = resultsAfterRerank[postRank];
      if (cand === undefined) continue;
      const preRank = preRerankRankByEntity.get(cand.entityId);
      if (preRank === undefined) continue;
      const delta = preRank - postRank;
      if (delta !== 0) moves.push({ entityId: cand.entityId, delta });
    }
    rankMovement = moves;
  }

  // Snapshot of the served candidates the trainer will read. We
  // intentionally store ONLY what survives suppression (POST-suppression
  // results) so labels can never reference a hidden candidate. Per-lane
  // ranks come from each candidate's evidence trail.
  const servedCandidatesSnapshot = results.map((cand, position) => {
    const perLaneRanks: Record<string, number> = {};
    const perLaneScores: Record<string, number> = {};
    for (const ev of cand.evidence ?? []) {
      if (ev.rank !== undefined) perLaneRanks[ev.sourceKind] = ev.rank;
      if (ev.rawScore !== undefined) perLaneScores[ev.sourceKind] = ev.rawScore;
    }
    return {
      entityId: cand.entityId,
      sourceKind: cand.sourceKind,
      ...(Object.keys(perLaneRanks).length > 0 ? { perLaneRanks } : {}),
      ...(Object.keys(perLaneScores).length > 0 ? { perLaneScores } : {}),
      fusedScore: cand.fusedScore,
      ...(cand.rerankScore !== undefined ? { rerankScore: cand.rerankScore } : {}),
      servedPosition: position,
      ...(cand.canonicalUrl !== undefined ? { canonicalUrl: cand.canonicalUrl } : {}),
    };
  });

  const suppressedEntityIds = dropped
    .map((c) => c.entityId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  if (deps.appendImpression !== undefined) {
    const payload: RecallServedPayload = {
      payloadVersion: 1,
      servedContextId,
      query: req.q,
      intent,
      ...(req.session !== undefined
        ? { sessionContext: req.session as Readonly<Record<string, unknown>> }
        : {}),
      results: servedCandidatesSnapshot,
      perSourceCounts: perSourceCounts as Readonly<Record<string, number>>,
      rerankApplied,
      ...(rerankApplied ? { rerankTopK } : {}),
      ...(suppressedEntityIds.length > 0 ? { suppressedEntityIds } : {}),
      sequenceNumber: (deps.nextSequenceNumber ?? (deps.now ?? Date.now))(),
      servedAt,
    };
    // Fire-and-forget; impression durability must not gate the
    // response. Failures are diagnostic, not user-visible.
    void deps.appendImpression(payload).catch((err) => {
      console.warn('[recall-v2] impression append failed:', err);
    });
  }

  return {
    query: {
      text: req.q,
      ...(queryEmbedding !== undefined ? { embeddingModel: MODEL_ID } : {}),
      ...(embedderError !== undefined ? { normalizedText: `[embedder error: ${embedderError}]` } : {}),
    },
    results,
    meta: {
      intent,
      fusion: {
        strategy: strategy.fusion ?? 'rrf',
        perSourceCounts,
        k: RRF_K,
      },
      timingsMs: timings,
      flags: {
        queryEmbedded: queryEmbedding !== undefined,
        rerankApplied,
        degradedToLexical,
      },
      servedContextId,
      ...(rerankApplied
        ? {
            rerank: {
              enabled: true,
              rerankTopK,
              rerankedCount: Math.min(rerankTopK, kept.length),
              latencyMs: rerankLatencyMs,
              ...(rankMovement !== undefined ? { rankMovement } : {}),
            },
          }
        : {}),
      ...(strategy.debug === true ? { debug: { droppedExplanations: dropped } } : {}),
    },
  };
};

/** Public entry that fires shadow comparison when SIDETRACK_RECALL_SHADOW=1.
 *  Wraps runRecall — same signature, same return value, but kicks off
 *  a parallel pipeline run with the SQLite store explicitly disabled
 *  (forcing the MiniSearch fallback path) and logs the top-K diff to
 *  /tmp/sidetrack-recall-shadow.log. Fire-and-forget; primary path
 *  is unaffected. */
export const runRecallWithShadow = async (
  deps: PipelineDeps,
  req: RecallRequest,
): Promise<RecallResponse> => {
  const primary = await runRecall(deps, req);
  if (shadowQueryEnabled()) {
    const variants = shadowVariantsFromEnv();
    // Each shadow variant runs fire-and-forget so the primary
    // response goes back to the user immediately.
    void (async () => {
      try {
        // Variant 1 — SQLite FTS5 (primary) vs MiniSearch fallback.
        if (variants.comparePrimaryToFallback) {
          const { store: _drop, ...rest } = deps;
          void _drop;
          const fallback = await runRecall(rest, req);
          await logShadowDiff(req, primary, fallback, 'sqlite-vs-minisearch');
        }
        // Variant 2 — rerank on (current) vs off.
        if (variants.compareRerankOnOff) {
          const primaryHasRerank = (req.strategy?.rerankTopK ?? 0) > 0;
          if (primaryHasRerank) {
            const withoutRerank: RecallRequest = {
              ...req,
              strategy: { ...(req.strategy ?? {}), rerankTopK: 0 },
            };
            const noRerank = await runRecall(deps, withoutRerank);
            await logShadowDiff(req, primary, noRerank, 'rerank-on-vs-off');
          } else {
            const withRerank: RecallRequest = {
              ...req,
              strategy: { ...(req.strategy ?? {}), rerankTopK: req.limit ?? 12 },
            };
            const rer = await runRecall(deps, withRerank);
            await logShadowDiff(req, primary, rer, 'rerank-off-vs-on');
          }
        }
        // Variant 3 — sqlite-vec primary vs JSON-sidecar fallback.
        //   Today both paths converge (sqlite-vec blocked by Bun);
        //   when sqlite-vec lands, this will surface the diff.
        if (variants.compareVecOnOff) {
          // No-op until sqlite-vec loads; placeholder for the
          // contract so the flag is documented + testable later.
          await logShadowDiff(req, primary, primary, 'vec-on-vs-off:noop');
        }
      } catch {
        // dev-only telemetry — never fail the primary response
      }
    })();
  }
  return primary;
};
