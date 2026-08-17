import { describe, expect, it } from 'bun:test';

import { meanNormalized } from '../suggestions/centroid.js';
import {
  bestAvailableVectorScore,
  DEFAULT_LATE_INTERACTION_TOP_K,
  pageWorkstreamScore,
  resolveLateInteractionTopK,
  symmetricSentenceScore,
} from './sentenceInteraction.js';

// ---- fixture helpers -------------------------------------------------------
//
// Small hand-built orthonormal-ish axes so cosine similarity is exact and
// legible in assertions, rather than relying on a real embedder. Each axis
// is a unit vector; "near" vectors are a weighted blend of two axes
// (normalized), giving a predictable, non-1.0/non-0.0 cosine.

const DIM = 8;
const axis = (index: number): Float32Array => {
  const v = new Float32Array(DIM);
  v[index] = 1;
  return v;
};
const blend = (indexA: number, weightA: number, indexB: number, weightB: number): Float32Array => {
  const v = new Float32Array(DIM);
  v[indexA] = weightA;
  v[indexB] = weightB;
  let norm = 0;
  for (const value of v) norm += value * value;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < DIM; i += 1) v[i] = (v[i] ?? 0) * inv;
  return v;
};

// Two clearly related "ML topic" axes (0, 1) and one unrelated "food" axis
// (2) — the pineapple-cake scenario's shape: an ML workstream whose real
// content sentences sit near axis 0/1, plus ONE noise sentence (from a food
// page) that got embedded near axis 2.
const ML_TOPIC_A = axis(0);
const ML_TOPIC_B = blend(0, 0.9, 1, 0.1); // close to ML_TOPIC_A
const FOOD_NOISE = axis(2); // orthogonal to the ML axes — genuinely unrelated
const ML_QUERY = blend(0, 0.85, 1, 0.15); // a query sentence close to the ML cluster

describe('pageWorkstreamScore — top-k mean over max-per-sentence (the pineapple-cake fixture)', () => {
  it('a noise sentence does not poison the score when max/top-k is used (vs. naive mean-pooling)', () => {
    // Target pool: two real ML sentences + one noise (food) sentence — the
    // pineapple-cake shape: prototypeMedoids.ts's header describes exactly
    // this (a food page's terminology landing in an ML workstream's pool).
    const target = [ML_TOPIC_A, ML_TOPIC_B, FOOD_NOISE];
    const source = [ML_QUERY];

    const lateInteractionScore = pageWorkstreamScore(source, target, 2);
    // The naive mean-pooled centroid of the (polluted) target pool, compared
    // against the same query — this is what single-vector pooling would have
    // produced, and it is measurably WORSE (lower) than late interaction's
    // max-based score, because the food axis drags the pooled centroid away
    // from the ML query.
    const pooledCentroid = meanNormalized(target)!;
    let pooledCosine = 0;
    for (let i = 0; i < DIM; i += 1) pooledCosine += (ML_QUERY[i] ?? 0) * (pooledCentroid[i] ?? 0);

    // Late interaction takes the MAX over the target pool per source
    // sentence — the noise sentence simply loses to the two strong ML
    // matches and never enters the score.
    expect(lateInteractionScore).toBeGreaterThan(pooledCosine);
    // And it should be close to the query's genuine similarity to the ML
    // cluster, not dragged toward the food axis at all.
    expect(lateInteractionScore).toBeGreaterThan(0.9);
  });

  it('multiple source sentences: a noisy SOURCE sentence is excluded by top-k, not averaged in', () => {
    // Source page has one strong ML sentence and one noise (food) sentence —
    // the source-side mirror of the fixture above (a page with a stray
    // off-topic aside). k=1 keeps only the single best-matching source
    // sentence's score, so the noise sentence's low max-sim never drags the
    // page-level score down.
    const source = [ML_QUERY, FOOD_NOISE];
    const target = [ML_TOPIC_A, ML_TOPIC_B];
    const topKOne = pageWorkstreamScore(source, target, 1);
    // Naive mean over ALL source sentences' max-sim (what pooling every
    // sentence equally would give) is measurably lower, since the food
    // sentence's max-sim against the ML target pool is near 0.
    const perSourceMax = source.map((s) => {
      let best = 0;
      for (const t of target) {
        let dot = 0;
        for (let i = 0; i < DIM; i += 1) dot += (s[i] ?? 0) * (t[i] ?? 0);
        if (dot > best) best = dot;
      }
      return best;
    });
    const naiveMeanOverAll = perSourceMax.reduce((a, b) => a + b, 0) / perSourceMax.length;
    expect(topKOne).toBeGreaterThan(naiveMeanOverAll);
  });

  it('generic-sentence tie fixture: pooled scoring ties two workstreams, sentence-level discriminates', () => {
    // Two workstreams (X, Y). Each has one GENERIC sentence near a shared
    // "boilerplate" axis (3) that is close to almost any query — the
    // day-one 0.82-everywhere failure mode. Workstream X ALSO has one
    // genuinely distinctive sentence close to the query; workstream Y does
    // not (its second sentence is unrelated, axis 5).
    const BOILERPLATE = axis(3);
    const NEAR_BOILERPLATE_QUERY = blend(3, 0.95, 0, 0.05); // query is mostly boilerplate-shaped, mostly
    const DISTINCTIVE_MATCH = blend(0, 0.99, 3, 0.01); // near-identical topic axis to the query below
    const QUERY = blend(0, 0.9, 3, 0.1); // genuinely close to axis 0, a little boilerplate flavor
    const UNRELATED = axis(6);

    const workstreamX = [BOILERPLATE, DISTINCTIVE_MATCH];
    const workstreamY = [BOILERPLATE, UNRELATED];

    // Pooled (mean-then-cosine) comparison: both workstreams' pooled
    // centroids are dominated by the shared BOILERPLATE axis, so they tie
    // (or nearly tie) against the query.
    const pooledX = meanNormalized(workstreamX)!;
    const pooledY = meanNormalized(workstreamY)!;
    let cosPooledX = 0;
    let cosPooledY = 0;
    for (let i = 0; i < DIM; i += 1) {
      cosPooledX += (QUERY[i] ?? 0) * (pooledX[i] ?? 0);
      cosPooledY += (QUERY[i] ?? 0) * (pooledY[i] ?? 0);
    }
    const pooledGap = Math.abs(cosPooledX - cosPooledY);

    // Sentence-level (late interaction, k=1 — the query is a single
    // sentence here): X's distinctive sentence wins clearly over Y's
    // unrelated one, discriminating where pooling could not.
    const sentenceX = pageWorkstreamScore([QUERY], workstreamX, 1);
    const sentenceY = pageWorkstreamScore([QUERY], workstreamY, 1);
    const sentenceGap = sentenceX - sentenceY;

    void NEAR_BOILERPLATE_QUERY; // fixture axis kept for readability, unused directly
    expect(sentenceGap).toBeGreaterThan(pooledGap);
    expect(sentenceX).toBeGreaterThan(sentenceY);
  });

  it('returns 0 when either side has no vectors', () => {
    expect(pageWorkstreamScore([], [ML_TOPIC_A])).toBe(0);
    expect(pageWorkstreamScore([ML_TOPIC_A], [])).toBe(0);
  });

  it('is bounded [0, 1] even with negative-cosine inputs', () => {
    const negative = new Float32Array(DIM);
    negative[0] = -1;
    const score = pageWorkstreamScore([negative], [ML_TOPIC_A]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('default top-k is DEFAULT_LATE_INTERACTION_TOP_K (2) when unspecified', () => {
    expect(resolveLateInteractionTopK()).toBe(DEFAULT_LATE_INTERACTION_TOP_K);
  });
});

describe('symmetricSentenceScore — order-independent pairwise score', () => {
  it('agrees regardless of argument order', () => {
    const a = [ML_TOPIC_A, FOOD_NOISE];
    const b = [ML_TOPIC_B, ML_QUERY];
    const forward = symmetricSentenceScore(a, b);
    const backward = symmetricSentenceScore(b, a);
    expect(forward).toBeCloseTo(backward, 10);
  });

  it('returns 0 when either side is empty', () => {
    expect(symmetricSentenceScore([], [ML_TOPIC_A])).toBe(0);
  });
});

describe('bestAvailableVectorScore — sentence-level preferred, pooled cosine fallback', () => {
  it('uses sentence-level scoring when both sides carry sentence vectors', () => {
    const left = { embedding: FOOD_NOISE, sentenceEmbeddings: [ML_TOPIC_A, ML_TOPIC_B] };
    const right = { embedding: FOOD_NOISE, sentenceEmbeddings: [ML_QUERY] };
    // Pooled embeddings are both FOOD_NOISE (would score 1.0 if pooled were
    // used) but sentence vectors are ML-topic — proves sentence-level wins.
    const score = bestAvailableVectorScore(left, right);
    expect(score).toBeGreaterThan(0.9);
  });

  it('falls back to pooled cosine when EITHER side lacks sentence vectors', () => {
    const left = { embedding: ML_TOPIC_A, sentenceEmbeddings: [ML_TOPIC_A] };
    const right = { embedding: ML_TOPIC_B }; // no sentence vectors at all
    const score = bestAvailableVectorScore(left, right);
    let expected = 0;
    for (let i = 0; i < DIM; i += 1) expected += (ML_TOPIC_A[i] ?? 0) * (ML_TOPIC_B[i] ?? 0);
    expect(score).toBeCloseTo(expected, 10);
  });

  it('falls back to pooled cosine when a side has an EMPTY sentence-vector array', () => {
    const left = { embedding: ML_TOPIC_A, sentenceEmbeddings: [] };
    const right = { embedding: ML_TOPIC_A, sentenceEmbeddings: [ML_QUERY] };
    const score = bestAvailableVectorScore(left, right);
    expect(score).toBeCloseTo(1, 10); // pooled cosine of identical vectors
  });

  it('returns 0 when neither pooled nor sentence vectors are usable (zero vectors)', () => {
    const zero = new Float32Array(DIM);
    const left = { embedding: zero };
    const right = { embedding: zero };
    expect(bestAvailableVectorScore(left, right)).toBe(0);
  });
});
