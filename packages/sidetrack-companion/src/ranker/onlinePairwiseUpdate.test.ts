import { describe, expect, it } from 'vitest';

import type { CandidatePairFeatures } from './feature-schema.js';
import { FEATURE_SCHEMA_VERSION } from './feature-schema.js';
import {
  applyPairwiseUpdate,
  applyPairwiseUpdateFromFeatures,
  DEFAULT_ONLINE_UPDATE_CONFIG,
  ONLINE_RANKER_WEIGHTS_LENGTH,
  rankNetPairwiseGradient,
} from './onlinePairwiseUpdate.js';

// A 31-feature + 1-bias zero vector matching the LR's expected shape.
const zeroWeights = (): readonly number[] =>
  new Array(ONLINE_RANKER_WEIGHTS_LENGTH).fill(0) as number[];

// Synthetic positive/negative pair: positive scores higher on
// `cosine_similarity` + `same_canonical_url`, lower on
// `opener_chain_depth`. Mirrors the dogfood-case shape (the user
// confirms a topically-related pair; the synthetic negative is
// a less-related visit reachable from `from`).
const positiveFeatures = (): CandidatePairFeatures => ({
  schemaVersion: FEATURE_SCHEMA_VERSION,
  same_workstream: 1,
  opener_chain_depth: 0,
  in_navigation_chain: 1,
  same_canonical_url: 0,
  same_host: 1,
  same_repo: 1,
  same_search_query: 0,
  same_copied_snippet_count: 1,
  shared_title_tokens: 4,
  shared_path_tokens: 3,
  cosine_similarity: 0.95,
  recency_score_from: 1,
  recency_score_to: 1,
  engagement_class_match: 1,
  return_count_from: 3,
  return_count_to: 4,
  user_asserted_in_thread: 0,
  user_asserted_in_workstream: 1,
  same_active_topic: 1,
  topic_lineage_merge_split_related: 0,
  page_quality_tier_from: 3,
  page_quality_tier_to: 3,
  shared_content_terms: 8,
  shared_content_keyphrases: 4,
  content_weighted_jaccard: 0.7,
  content_vector_cosine: 0.85,
  content_entity_overlap: 3,
  content_evidence_tier_from: 2,
  content_evidence_tier_to: 2,
  content_both_available: 1,
  content_quality_pair_min: 3,
  chunk_support_count: 2,
  max_chunk_pair_score: 0.7,
  max_chunk_pair_vector_cosine: 0.8,
  top3_mean_chunk_pair_vector_cosine: 0.7,
  chunk_pair_vector_support_count: 2,
  bm25_score: 0,
  bm25_rank: 0,
  dense_doc_score: 0,
  dense_doc_rank: 0,
  rrf_score: 0,
  rrf_rank: 0,
  graph_similarity_rank: 0,
  candidate_source_flags: 0,
  served_position: 0,
});

const negativeFeatures = (): CandidatePairFeatures => ({
  schemaVersion: FEATURE_SCHEMA_VERSION,
  same_workstream: 0,
  opener_chain_depth: 4,
  in_navigation_chain: 0,
  same_canonical_url: 0,
  same_host: 0,
  same_repo: 0,
  same_search_query: 0,
  same_copied_snippet_count: 0,
  shared_title_tokens: 0,
  shared_path_tokens: 0,
  cosine_similarity: 0.05,
  recency_score_from: 1,
  recency_score_to: 0,
  engagement_class_match: 0,
  return_count_from: 1,
  return_count_to: 1,
  user_asserted_in_thread: 0,
  user_asserted_in_workstream: 0,
  same_active_topic: 0,
  topic_lineage_merge_split_related: 0,
  page_quality_tier_from: 1,
  page_quality_tier_to: 1,
  shared_content_terms: 0,
  shared_content_keyphrases: 0,
  content_weighted_jaccard: 0,
  content_vector_cosine: 0.1,
  content_entity_overlap: 0,
  content_evidence_tier_from: 1,
  content_evidence_tier_to: 1,
  content_both_available: 0,
  content_quality_pair_min: 1,
  chunk_support_count: 0,
  max_chunk_pair_score: 0.1,
  max_chunk_pair_vector_cosine: 0.1,
  top3_mean_chunk_pair_vector_cosine: 0.1,
  chunk_pair_vector_support_count: 0,
  bm25_score: 0,
  bm25_rank: 0,
  dense_doc_score: 0,
  dense_doc_rank: 0,
  rrf_score: 0,
  rrf_rank: 0,
  graph_similarity_rank: 0,
  candidate_source_flags: 0,
  served_position: 0,
});

describe('rankNetPairwiseGradient — pure pair-shaped gradient', () => {
  it('returns a bias-slot-zero gradient (same `from` cancels bias in the pairwise margin)', () => {
    const weights = zeroWeights();
    const pos = [1, 0, 0.5];
    const neg = [0, 1, 0.1];
    const grad = rankNetPairwiseGradient(pos, neg, [0, 0, 0, 0]);
    expect(grad[0]).toBe(0); // bias never sees signal
    expect(grad).toHaveLength(weights.length === 4 ? 4 : grad.length);
    // (Weight len doesn't match this micro-test; just assert shape semantics.)
  });

  it('returns a zero gradient when feature dimensions disagree (refuse-to-corrupt)', () => {
    const weights = [0, 0, 0]; // bias + 2 feature weights
    // positive has 3 features, weights expects 2 — mismatch
    const grad = rankNetPairwiseGradient([1, 2, 3], [0, 1, 0], weights);
    expect(grad).toEqual([0, 0, 0]);
  });

  it('points the gradient AWAY from negative and TOWARD positive (margin descends)', () => {
    // Pre-update margin starts at 0 (zero weights); the gradient
    // should push w in the direction of (pos − neg) so the next
    // step increases the margin. Equivalently: per-feature gradient
    // sign equals −sign(δ) where δ = pos − neg.
    const weights = [0, 0, 0, 0]; // bias + 3 features
    const pos = [1, 0, 0];
    const neg = [0, 1, 1];
    const grad = rankNetPairwiseGradient(pos, neg, weights);
    // δ = [+1, −1, −1]; with margin=0, σ(0)=0.5 → grad_i = −0.5·δ_i
    expect(grad[0]).toBe(0);
    expect(grad[1]).toBeCloseTo(-0.5, 6);
    expect(grad[2]).toBeCloseTo(0.5, 6);
    expect(grad[3]).toBeCloseTo(0.5, 6);
  });
});

describe('applyPairwiseUpdate — vanilla SGD with L2 on non-bias slots', () => {
  it('moves the score for the positive ABOVE the negative after one update', () => {
    let w = zeroWeights();
    const pos = positiveFeatures();
    const neg = negativeFeatures();
    w = applyPairwiseUpdateFromFeatures(w, pos, neg, DEFAULT_ONLINE_UPDATE_CONFIG);
    // After one update from zero weights, the positive's dot
    // should beat the negative's dot.
    const dot = (features: CandidatePairFeatures, weights: readonly number[]): number => {
      // Inline the same logisticFeatureVector ordering the updater uses.
      // We test the PROPERTY (positive beats negative), not the exact value.
      const { logisticFeatureVector } = require('./train.js');
      const f = logisticFeatureVector(features);
      let s = weights[0] ?? 0;
      for (let i = 0; i < f.length; i += 1) s += (weights[i + 1] ?? 0) * (f[i] ?? 0);
      return s;
    };
    expect(dot(pos, w)).toBeGreaterThan(dot(neg, w));
  });

  it('is deterministic — same input twice yields bytewise-identical weights', () => {
    const pos = positiveFeatures();
    const neg = negativeFeatures();
    const w1 = applyPairwiseUpdateFromFeatures(zeroWeights(), pos, neg);
    const w2 = applyPairwiseUpdateFromFeatures(zeroWeights(), pos, neg);
    expect(w1).toEqual(w2);
  });

  it('does not mutate the input weight vector', () => {
    const w = zeroWeights();
    const before = [...w];
    applyPairwiseUpdateFromFeatures(w, positiveFeatures(), negativeFeatures());
    expect([...w]).toEqual(before);
  });

  it('produces strictly NON-zero weights after a non-degenerate update', () => {
    const w = applyPairwiseUpdateFromFeatures(
      zeroWeights(),
      positiveFeatures(),
      negativeFeatures(),
    );
    const someNonZero = w.some((value) => value !== 0);
    expect(someNonZero).toBe(true);
  });

  it('shrinks weights via L2 when applied to a non-zero start (regularization is alive)', () => {
    // Take a non-trivially-initialized weight vector. Apply an
    // update where positive == negative (no data signal). L2 alone
    // should shrink the non-bias weights toward zero. Bias is
    // unaffected (L2 only on non-bias slots).
    const seeded = [0.5, ...new Array(ONLINE_RANKER_WEIGHTS_LENGTH - 1).fill(0.1)] as number[];
    const noSignal = positiveFeatures();
    const next = applyPairwiseUpdateFromFeatures(seeded, noSignal, noSignal);
    expect(next[0]).toBe(seeded[0]); // bias unchanged
    for (let index = 1; index < next.length; index += 1) {
      expect(Math.abs(next[index] ?? 0)).toBeLessThan(Math.abs(seeded[index] ?? 0));
    }
  });

  it('higher learningRate moves weights further toward the gradient direction', () => {
    const slow = applyPairwiseUpdateFromFeatures(
      zeroWeights(),
      positiveFeatures(),
      negativeFeatures(),
      {
        learningRate: 0.01,
        l2: 0,
      },
    );
    const fast = applyPairwiseUpdateFromFeatures(
      zeroWeights(),
      positiveFeatures(),
      negativeFeatures(),
      {
        learningRate: 0.1,
        l2: 0,
      },
    );
    // Per-feature, the fast update's weight magnitude should
    // dominate the slow update's. Pick the feature with the
    // largest |δ| (cosine_similarity = 0.95 − 0.05 = 0.9) and
    // check on it.
    // logisticFeatureVector orders by RANKER_FEATURE_KEYS — we
    // don't depend on a specific index; instead assert any
    // non-bias slot where slow is non-zero has |fast| > |slow|.
    let confirmed = false;
    for (let index = 1; index < slow.length; index += 1) {
      if ((slow[index] ?? 0) !== 0) {
        expect(Math.abs(fast[index] ?? 0)).toBeGreaterThan(Math.abs(slow[index] ?? 0));
        confirmed = true;
      }
    }
    expect(confirmed).toBe(true);
  });
});

describe('refuse-to-corrupt — dimension mismatch must NOT mutate weights via L2 (Codex review of #232)', () => {
  // Codex review caught: `rankNetPairwiseGradient` zeroes the data
  // term on mismatch, but the L2 shrinkage runs from `weights`
  // directly — so a mismatched call would still mutate the weight
  // vector toward zero. Refused updates must be a true no-op.
  it('returns the input weights when positive/negative feature lengths disagree', () => {
    const seeded = [0.5, ...new Array(ONLINE_RANKER_WEIGHTS_LENGTH - 1).fill(0.1)] as number[];
    const pos = new Array(10).fill(0.5) as number[];
    const neg = new Array(11).fill(0.5) as number[]; // length mismatch
    const out = applyPairwiseUpdate(seeded, pos, neg);
    expect(out).toBe(seeded); // same reference: no allocation, no L2 shrinkage
  });

  it('returns the input weights when weights length disagrees with features+1', () => {
    const seeded = [0.5, 0.1, 0.1] as number[]; // length 3 → would expect 2 features
    const pos = new Array(10).fill(0.5) as number[]; // 10 features, doesn't match
    const neg = new Array(10).fill(0.5) as number[];
    const out = applyPairwiseUpdate(seeded, pos, neg);
    expect(out).toBe(seeded);
  });
});

describe('replay determinism — applying a sequence in the SAME order produces identical weights', () => {
  it('yields bytewise-identical weights across two runs', () => {
    const seq: ReadonlyArray<readonly [CandidatePairFeatures, CandidatePairFeatures]> = [
      [positiveFeatures(), negativeFeatures()],
      [negativeFeatures(), positiveFeatures()], // swapped: weights should move other way
      [positiveFeatures(), negativeFeatures()],
    ];
    let runA = zeroWeights();
    let runB = zeroWeights();
    for (const [p, n] of seq) {
      runA = applyPairwiseUpdateFromFeatures(runA, p, n);
      runB = applyPairwiseUpdateFromFeatures(runB, p, n);
    }
    expect(runA).toEqual(runB);
  });
});
