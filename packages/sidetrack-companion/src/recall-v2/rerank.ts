// Recall v2 — optional cross-encoder rerank.
//
// Plan Phase 7. Off by default; opted in per-request via
// `strategy.rerankTopK > 0`. When on, re-scores the top-N candidates
// using a cross-encoder model (transformers.js, lazy-loaded) and
// re-orders them by rerank score. The fused score from RRF stays on
// the candidate (`fusedScore`); rerank score lands as `rerankScore`.
//
// Model: Xenova/ms-marco-MiniLM-L-6-v2 (22MB) — standard cross-encoder
// for passage reranking; small + fast. Loads on first rerank call.
// Subsequent calls reuse the cached pipeline.

import type { RecallCandidate } from './types.js';

const MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';

type RerankPipeline = (
  inputs: ReadonlyArray<{ readonly text: string; readonly text_pair: string }>,
  options?: { readonly topk?: number },
) => Promise<ReadonlyArray<{ readonly label: string; readonly score: number }>>;

let cachedPipeline: Promise<RerankPipeline> | null = null;

const loadPipeline = async (): Promise<RerankPipeline> => {
  if (cachedPipeline !== null) return cachedPipeline;
  cachedPipeline = (async () => {
    // Dynamic import keeps the model loader off the hot startup path.
    const tx = (await import('@huggingface/transformers')) as unknown as {
      pipeline: (
        task: string,
        model: string,
        options?: Record<string, unknown>,
      ) => Promise<RerankPipeline>;
    };
    return await tx.pipeline('text-classification', MODEL_ID);
  })();
  return cachedPipeline;
};

/** Score (query, doc) pairs with the cross-encoder. */
const scorePairs = async (
  query: string,
  docs: readonly string[],
): Promise<readonly number[]> => {
  if (docs.length === 0) return [];
  const pipeline = await loadPipeline();
  const inputs = docs.map((d) => ({ text: query, text_pair: d }));
  const out = await pipeline(inputs);
  return out.map((r) => r.score);
};

/** Rerank the top-N of `candidates` using the query string. Items
 *  without a snippet OR title are scored against an empty string —
 *  the cross-encoder produces a low (but nonzero) relevance for
 *  empty inputs, so they fall toward the bottom of the reranked
 *  head naturally. Candidates beyond `topN` are appended unchanged. */
export const rerank = async (
  query: string,
  candidates: readonly RecallCandidate[],
  topN: number,
): Promise<readonly RecallCandidate[]> => {
  if (topN <= 0 || candidates.length === 0) return candidates;
  const head = candidates.slice(0, topN);
  const tail = candidates.slice(topN);
  // Build the text pairs from snippet | title. Missing both falls
  // through to '' — the CE handles empty text gracefully (low score,
  // sorts to bottom of head).
  const docs = head.map((c) => c.snippet ?? c.title ?? '');
  const scores = await scorePairs(query, docs).catch((err) => {
    console.warn('[recall-v2] rerank failed:', err);
    return undefined;
  });
  if (scores === undefined) return candidates;
  const reordered = head
    .map((c, i) => ({ c, s: scores[i] ?? c.fusedScore }))
    .sort((a, b) => b.s - a.s)
    .map(({ c, s }): RecallCandidate => ({ ...c, rerankScore: s }));
  return [...reordered, ...tail];
};
