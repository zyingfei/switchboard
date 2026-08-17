// Sentence-level late-interaction scoring — "the attention of sentence
// matters" (docs/plans/2026-08-16-category-flexibility-hyde.md §12, USER
// DESIGN DIRECTIVE 2026-08-17). Shared, pure, no I/O — every call site
// (tabsession/prototypeLane.ts's vector side, workstreams/
// splitSuggestionEngine.ts's pairwise distance + cohesion/external-best,
// tabsession/newLabelHint.ts's no-confident-pick refinement) reuses the
// SAME primitive rather than each re-deriving its own pooling rule.
//
// THE FORMULA (a ColBERT-style "max-sim" late interaction, applied at the
// sentence granularity this codebase already produces via
// sentenceSplit.ts): for each SOURCE sentence, its score is the MAX cosine
// similarity against ANY target sentence vector ("does this one claim have a
// strong match somewhere in the target"). The page-level score is the MEAN
// of the TOP-k of those per-sentence maxes, not the mean over every source
// sentence.
//
// WHY TOP-K MEAN, NOT MEAN-OVER-ALL. Averaging every per-sentence max would
// reproduce both failure modes this phase exists to fix, just one level
// down: (a) the pineapple-cake case — a single noise/off-topic sentence
// contributes a low max-sim that drags the average down even though the
// OTHER sentences match strongly; (b) the tie case — several generic
// sentences each contribute a middling max-sim against everything, so
// averaging in every one of them keeps the score in the same "everything
// ties around one plausible-looking number" band mean-pooling produced.
// Taking the mean of only the TOP-k per-sentence maxes says "how many of
// this page's sentences are STRONGLY matched, ignoring the rest" — a noise
// sentence's low max-sim simply falls outside the top-k and never
// contributes; a page whose only strong signal is one distinctive sentence
// among several generic ones still surfaces that one sentence's high score
// instead of being diluted by the generic ones sitting alongside it.
//
// WHY MAX (not mean) ON THE INNER PER-SENTENCE STEP. The inner step asks
// "is there SOME sentence on the other side this one plausibly matches" —
// a single strong match is exactly what indicates topical relatedness; the
// other side's unrelated sentences (a `pageWorkstreamScore` target set
// realistically has several) must not dilute a genuinely strong hit,
// mirroring why prototypeLane.ts's whole-vector KNN already takes the BEST
// hit per workstream rather than averaging every prototype's similarity.

import { cosine } from '../suggestions/centroid.js';

export const LATE_INTERACTION_TOP_K_ENV = 'SIDETRACK_LATE_INTERACTION_TOP_K';
export const DEFAULT_LATE_INTERACTION_TOP_K = 2;

/** Parse SIDETRACK_LATE_INTERACTION_TOP_K — a >=1 integer. Absent/garbage/<1
 *  falls back to the default, same silent-fallback idiom as every other env
 *  knob in this feature area. */
export const resolveLateInteractionTopK = (): number => {
  const raw = process.env[LATE_INTERACTION_TOP_K_ENV];
  if (raw === undefined || raw === '') return DEFAULT_LATE_INTERACTION_TOP_K;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LATE_INTERACTION_TOP_K;
  return parsed;
};

const hasNonZeroVector = (vector: Float32Array): boolean => {
  if (vector.length === 0) return false;
  for (const value of vector) {
    if (value !== 0) return true;
  }
  return false;
};

/** cosine() (suggestions/centroid.ts) is a plain dot product, valid here
 *  under the SAME assumption every other cosine call in this feature area
 *  documents (prototypeMedoids.ts's centroidDistance, prototypeLane.ts's
 *  cosineSimilarityFromL2): every embedding this module receives is already
 *  L2-normalized (recall/embedder.ts's e5 output). Clamped for float-error
 *  safety and to guard a stray zero vector (padding, an embed failure that
 *  produced an all-zero placeholder) from ever reporting a nonsensical
 *  positive similarity. */
const safeCosine = (left: Float32Array, right: Float32Array): number => {
  if (!hasNonZeroVector(left) || !hasNonZeroVector(right)) return 0;
  const sim = cosine(left, right);
  return sim < -1 ? -1 : sim > 1 ? 1 : sim;
};

/**
 * Top-k mean over max-per-source-sentence cosine similarity against ANY
 * target sentence vector. `source`/`target` are typically a page's own
 * sentence vectors and a candidate workstream's prototype (medoid +
 * generated) sentence vectors, but the function is symmetric in SHAPE (not
 * necessarily in VALUE — see symmetricSentenceScore below for an
 * order-independent variant). Returns 0 when either side has no vectors —
 * the caller's job to fall back to a pooled/whole-vector score in that case
 * (this module never decides fallback policy, only computes the score when
 * asked).
 */
export const pageWorkstreamScore = (
  source: readonly Float32Array[],
  target: readonly Float32Array[],
  k: number = resolveLateInteractionTopK(),
): number => {
  if (source.length === 0 || target.length === 0) return 0;
  const perSourceMax = source.map((sourceVec) => {
    let best = 0;
    for (const targetVec of target) {
      const sim = safeCosine(sourceVec, targetVec);
      if (sim > best) best = sim;
    }
    return best;
  });
  perSourceMax.sort((left, right) => right - left);
  const topKCount = Math.max(1, Math.min(k, perSourceMax.length));
  const topK = perSourceMax.slice(0, topKCount);
  const mean = topK.reduce((sum, value) => sum + value, 0) / topK.length;
  return mean < 0 ? 0 : mean > 1 ? 1 : mean;
};

/**
 * Order-independent pairwise score for two sentence sets — the average of
 * both directions' `pageWorkstreamScore`. Used wherever the two sides are
 * PEERS (two pages being compared for clustering distance/cohesion) rather
 * than a query-vs-pool relationship (a page against a workstream's
 * prototype pool), so the resulting edge weight does not depend on which
 * side happened to be passed first.
 */
export const symmetricSentenceScore = (
  left: readonly Float32Array[],
  right: readonly Float32Array[],
  k: number = resolveLateInteractionTopK(),
): number => {
  if (left.length === 0 || right.length === 0) return 0;
  return (pageWorkstreamScore(left, right, k) + pageWorkstreamScore(right, left, k)) / 2;
};

/** Structural shape every "has an optional set of sentence vectors, always
 *  has a pooled fallback vector" caller (SuggestionEvidenceItem today) can
 *  satisfy without importing that module's own type. */
export interface VectorScorable {
  readonly embedding: Float32Array;
  readonly sentenceEmbeddings?: readonly Float32Array[];
}

/**
 * The single fallback rule this whole phase relies on for "keep the
 * single-vector path as fallback when sentence vectors are absent for
 * either side" (design directive item 2): sentence-level `symmetricSentenceScore`
 * when BOTH sides carry sentence vectors, else plain pooled cosine on the
 * two `embedding` fields, else 0 (neither usable — same zero floor
 * splitSuggestionEngine.ts's original cosineSimilarity already used).
 */
export const bestAvailableVectorScore = (
  left: VectorScorable,
  right: VectorScorable,
  k: number = resolveLateInteractionTopK(),
): number => {
  const leftSentences = left.sentenceEmbeddings;
  const rightSentences = right.sentenceEmbeddings;
  if (
    leftSentences !== undefined &&
    leftSentences.length > 0 &&
    rightSentences !== undefined &&
    rightSentences.length > 0
  ) {
    return symmetricSentenceScore(leftSentences, rightSentences, k);
  }
  return safeCosine(left.embedding, right.embedding);
};
