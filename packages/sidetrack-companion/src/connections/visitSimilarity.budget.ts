// Stage 5.2 W3 — budget gate for hot-path visit-similarity inserts.
//
// Foundational types only: the actual hot-insert logic (embed → top-K
// neighborhood update with eviction) lives in a follow-up that
// integrates with the materializer's onAccepted dispatch. This module
// just answers "is it safe to embed on the event loop?" Three signals:
//
//   1. Corpus size (small enough that an in-memory pairwise scan is
//      bounded; full pairwise is O(N) at insert time, fine for ~1K
//      visits, dangerous past ~5K).
//   2. Embedder warmth (a cold embedder pays cold-start latency
//      measured in seconds — never safe on the event loop). Callers
//      mark warm + a TTL after each successful embed; lapsed TTL =
//      cold.
//   3. Recent p99 embed latency (a warm embedder under load may still
//      be slow; pushing more work on a struggling embedder cascades).
//
// All three are advisory — `shouldEmbedOnHotPath` is a single boolean.
// Callers that get `false` should mark the visit dirty for the
// reconciliation worker and return immediately.

export interface VisitSimilarityBudget {
  /** Current number of indexed visits. */
  readonly corpusSize: number;
  /** Maximum corpus size for hot-path eligibility. Defaults to 5_000 — beyond that pairwise rescans are expensive. */
  readonly maxCorpusSize?: number;
  /** Epoch-ms after which the embedder is considered cold. `undefined` = cold. */
  readonly embedderWarmUntilMs?: number;
  /** Recent p99 embed latency in ms. `undefined` = unknown. */
  readonly recentEmbedP99Ms?: number;
  /** Maximum recent p99 latency (ms) tolerated on the hot path. Defaults to 50. */
  readonly maxRecentEmbedP99Ms?: number;
  /** Override the current time (for tests). */
  readonly nowMs?: number;
}

export const DEFAULT_W3_MAX_CORPUS_SIZE = 5_000;
export const DEFAULT_W3_MAX_EMBED_P99_MS = 50;

export type W3SkipReason =
  | 'corpus-too-large'
  | 'embedder-cold'
  | 'embedder-slow'
  | 'embedder-warmth-unknown';

export interface W3Decision {
  readonly shouldEmbedOnHotPath: boolean;
  readonly reason?: W3SkipReason;
}

export const decideHotPathEmbed = (budget: VisitSimilarityBudget): W3Decision => {
  const maxCorpus = budget.maxCorpusSize ?? DEFAULT_W3_MAX_CORPUS_SIZE;
  const maxP99 = budget.maxRecentEmbedP99Ms ?? DEFAULT_W3_MAX_EMBED_P99_MS;
  const now = budget.nowMs ?? Date.now();
  if (budget.corpusSize >= maxCorpus) {
    return { shouldEmbedOnHotPath: false, reason: 'corpus-too-large' };
  }
  if (budget.embedderWarmUntilMs === undefined) {
    return { shouldEmbedOnHotPath: false, reason: 'embedder-warmth-unknown' };
  }
  if (now > budget.embedderWarmUntilMs) {
    return { shouldEmbedOnHotPath: false, reason: 'embedder-cold' };
  }
  if (budget.recentEmbedP99Ms !== undefined && budget.recentEmbedP99Ms > maxP99) {
    return { shouldEmbedOnHotPath: false, reason: 'embedder-slow' };
  }
  return { shouldEmbedOnHotPath: true };
};

/**
 * Stateful tracker for embedder warmth + recent latency. A future
 * hot-insert worker reads from this to decide whether to embed on the
 * event loop or defer to the reconciliation worker.
 */
export interface EmbedderWarmthTracker {
  /**
   * Record a successful embed. Updates the rolling p99 window and
   * marks the embedder warm for the next `warmTtlMs`.
   */
  readonly recordEmbed: (latencyMs: number) => void;
  /** Read the current budget snapshot. `nowMs` is read at call time. */
  readonly snapshot: (corpusSize: number) => VisitSimilarityBudget;
}

const DEFAULT_WARM_TTL_MS = 60_000;
const DEFAULT_P99_WINDOW = 64;

export const createEmbedderWarmthTracker = (
  options: {
    readonly warmTtlMs?: number;
    readonly p99Window?: number;
    readonly nowMs?: () => number;
  } = {},
): EmbedderWarmthTracker => {
  const warmTtlMs = options.warmTtlMs ?? DEFAULT_WARM_TTL_MS;
  const windowSize = options.p99Window ?? DEFAULT_P99_WINDOW;
  const now = options.nowMs ?? (() => Date.now());
  const latencies: number[] = [];
  let warmUntilMs: number | undefined;

  const recordEmbed = (latencyMs: number): void => {
    if (latencyMs < 0 || !Number.isFinite(latencyMs)) return;
    latencies.push(latencyMs);
    if (latencies.length > windowSize) latencies.shift();
    warmUntilMs = now() + warmTtlMs;
  };

  const recentP99 = (): number | undefined => {
    if (latencies.length === 0) return undefined;
    const sorted = [...latencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
    return sorted[idx];
  };

  const snapshot = (corpusSize: number): VisitSimilarityBudget => {
    const p99 = recentP99();
    return {
      corpusSize,
      nowMs: now(),
      ...(warmUntilMs === undefined ? {} : { embedderWarmUntilMs: warmUntilMs }),
      ...(p99 === undefined ? {} : { recentEmbedP99Ms: p99 }),
    };
  };

  return { recordEmbed, snapshot };
};
