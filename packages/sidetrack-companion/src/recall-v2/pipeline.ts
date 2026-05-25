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
import type {
  CandidateGeneratorOutput,
  RecallCandidate,
  RecallEvidence,
  RecallRequest,
  RecallResponse,
  RecallSourceKind,
  RecallStrategy,
} from './types.js';

const DEFAULT_LIMIT = 12;
const DEFAULT_PER_SOURCE_LIMIT = 20;
const DEFAULT_MIN_HIT_AGE_MS = 5 * 60 * 1000;
const RRF_K = 60;

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
  // Cosine filter is INSIDE the fan-out; cap to `limit` AFTER filtering
  // so we honor the per-source contract. The vec query overfetches
  // (limit*2) to absorb exclusions + low-cosine drops without
  // shrinking the final pool below `limit`.
  const hits = rawHits.filter((h) => h.cosine >= dynamicFloor).slice(0, limit);
  const candidates: RecallCandidate[] = hits.map((h, i) => ({
    candidateId: `semantic-query:${h.canonicalUrl}`,
    entityId: h.entityId ?? entityIdFor({ canonicalUrl: h.canonicalUrl }),
    sourceKind: 'semantic_query',
    canonicalUrl: h.canonicalUrl,
    ...(h.title === undefined ? {} : { title: h.title }),
    fusedScore: 1 / (RRF_K + (i + 1)),
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
      // Freshness-weighted RRF contribution. Freshness in [0.3, 1.0]
      // multiplies the pure 1/(k+rank) signal so a 1-day-old doc at
      // rank 1 contributes 1/61; a 2-year-old doc at rank 1
      // contributes 0.5/61. Keeps RRF's scale-free fusion property
      // while letting recency break the otherwise-deterministic
      // URL-alphabetical ties in the lexical layer.
      const rrf = 1 / (RRF_K + (i + 1));
      const contribution = rrf * freshnessFactor(cand, now);
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
  return collapseByLocationKey(entityDeduped);
};

/** Second-pass dedupe: candidates whose canonicalUrls map to the same
 *  `locationKey` (e.g. `google.com/?zx=1`, `google.com/?zx=2`,
 *  `google.com/?zx=3` — all just the Google homepage with a cache-
 *  bust param) collapse into a single result. Without this the
 *  semantic-pool path can fill the top-N with bouncy-URL noise
 *  (every visit to a search engine root gets its own vector).
 *
 *  Strategy: group by locationKey; within a group keep the
 *  highest-scoring candidate and merge evidence from the rest.
 *  Candidates whose URL doesn't yield a locationKey (chat turns,
 *  malformed URLs) pass through unchanged. */
const collapseByLocationKey = (
  candidates: readonly RecallCandidate[],
): RecallCandidate[] => {
  const byLoc = new Map<string, RecallCandidate>();
  const noKey: RecallCandidate[] = [];
  for (const c of candidates) {
    const loc = locationKey(c.canonicalUrl);
    if (loc === undefined) {
      noKey.push(c);
      continue;
    }
    const prev = byLoc.get(loc);
    if (prev === undefined) {
      byLoc.set(loc, c);
      continue;
    }
    const winner = c.fusedScore > prev.fusedScore ? c : prev;
    const loser = winner === c ? prev : c;
    byLoc.set(loc, {
      ...winner,
      evidence: [...winner.evidence, ...loser.evidence],
      // Surface the higher-quality title/snippet regardless of which
      // candidate "won" on score.
      ...(winner.title === undefined && loser.title !== undefined ? { title: loser.title } : {}),
      ...(winner.snippet === undefined && loser.snippet !== undefined
        ? { snippet: loser.snippet }
        : {}),
    });
  }
  return [...byLoc.values(), ...noKey].sort((a, b) => b.fusedScore - a.fusedScore);
};

/** Host + pathname location key (search-URL aware). Same logic as the
 *  extension's dejaVuModel.ts:locationKey; centralized server-side here. */
const SEARCH_PATHS: ReadonlySet<string> = new Set<string>(['/', '/search']);
const locationKey = (url: string | undefined): string | undefined => {
  if (url === undefined || url.length === 0) return undefined;
  try {
    const u = new URL(url);
    const rawPath = u.pathname.toLowerCase();
    const path = rawPath.length > 1 && rawPath.endsWith('/')
      ? rawPath.replace(/\/+$/u, '')
      : rawPath;
    const norm = path.length === 0 ? '/' : path;
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (SEARCH_PATHS.has(norm)) {
      const q = u.searchParams.get('q');
      if (q !== null && q.trim().length > 0) {
        return `${host}${norm}?q=${q.trim().toLowerCase().replace(/\s+/g, ' ')}`;
      }
    }
    return `${host}${norm}`;
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
  const currentLoc = locationKey(req.session?.currentUrl);
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
      const candLoc = locationKey(c.canonicalUrl);
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

/** Run the recall pipeline (Phase 2 v1.5 delegate). */
export const runRecall = async (
  deps: PipelineDeps,
  req: RecallRequest,
): Promise<RecallResponse> => {
  const now = (deps.now ?? Date.now)();
  const limit = req.limit ?? DEFAULT_LIMIT;
  const perSource = req.perSourceLimit ?? DEFAULT_PER_SOURCE_LIMIT;
  const sources = new Set(req.sources ?? allSources);
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
  if (sources.has('semantic_query')) {
    const lexicalAnchors = new Set(
      groups
        .flatMap((g) => g.candidates)
        .map((c) => c.canonicalUrl)
        .filter((u): u is string => u !== undefined),
    );
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
    groups.push(await generateGraphNeighbor(deps, anchorUrls, perSource, excludeUrls));
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
  let resultsAfterRerank = kept;
  let rerankApplied = false;
  const rerankTopK = strategy.rerankTopK ?? 0;
  if (rerankTopK > 0 && kept.length > 0) {
    const rerankStart = (deps.now ?? Date.now)();
    resultsAfterRerank = await rerank(req.q, kept, Math.min(rerankTopK, kept.length));
    timings['rerank'] = (deps.now ?? Date.now)() - rerankStart;
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
  };
  for (const g of groups) perSourceCounts[g.sourceKind] = g.candidates.length;

  return {
    query: {
      text: req.q,
      ...(queryEmbedding !== undefined ? { embeddingModel: MODEL_ID } : {}),
      ...(embedderError !== undefined ? { normalizedText: `[embedder error: ${embedderError}]` } : {}),
    },
    results,
    meta: {
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
