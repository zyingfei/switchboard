import { describe, expect, it } from 'bun:test';

import {
  CONCEPT_DISTRIBUTION_MIN_DISTINCT_KEYWORDS,
  DEFAULT_CONCEPT_COSINE_THRESHOLD,
  assignConceptForKeyword,
  conceptJaccard,
  foldConceptMember,
  isConceptDistributionDegenerate,
  isDegenerateEmbedding,
  isIdenticalVectorBatch,
  type ConceptCentroid,
} from './keywordConcepts.js';
import { normalize } from '../suggestions/centroid.js';

// A tiny deterministic "embedding" — orthonormal-ish basis vectors plus a
// controllable blend, enough to exercise cosine-threshold behavior without
// depending on the real embedder.
const vec = (...values: readonly number[]): Float32Array => Float32Array.from(values);

describe('assignConceptForKeyword', () => {
  it('joins the closest existing concept when above threshold', () => {
    const centroids: readonly ConceptCentroid[] = [
      { conceptId: 'concept-1', centroid: vec(1, 0, 0), memberCount: 3 },
      { conceptId: 'concept-2', centroid: vec(0, 1, 0), memberCount: 2 },
    ];
    const result = assignConceptForKeyword(vec(0.99, 0.14, 0), centroids, 0.9);
    expect(result.matchedConceptId).toBe('concept-1');
    expect(result.bestSimilarity).toBeGreaterThan(0.9);
  });

  it('mints nothing (returns null) when no centroid clears the threshold', () => {
    const centroids: readonly ConceptCentroid[] = [
      { conceptId: 'concept-1', centroid: vec(1, 0, 0), memberCount: 3 },
    ];
    const result = assignConceptForKeyword(vec(0, 1, 0), centroids, DEFAULT_CONCEPT_COSINE_THRESHOLD);
    expect(result.matchedConceptId).toBeNull();
    expect(result.bestSimilarity).toBeCloseTo(0, 5);
  });

  it('returns null with similarity 0 when there are no existing centroids at all', () => {
    const result = assignConceptForKeyword(vec(1, 0, 0), [], DEFAULT_CONCEPT_COSINE_THRESHOLD);
    expect(result.matchedConceptId).toBeNull();
    expect(result.bestSimilarity).toBe(0);
  });

  it('is deterministic — repeated calls over an unchanged centroid set agree', () => {
    const centroids: readonly ConceptCentroid[] = [
      { conceptId: 'concept-1', centroid: vec(0.7, 0.7, 0), memberCount: 1 },
      { conceptId: 'concept-2', centroid: vec(0.71, 0.7, 0.05), memberCount: 1 },
    ];
    const query = vec(0.72, 0.69, 0.02);
    const first = assignConceptForKeyword(query, centroids, 0.5);
    const second = assignConceptForKeyword(query, centroids, 0.5);
    expect(first).toEqual(second);
  });
});

describe('foldConceptMember — incremental centroid update', () => {
  it('seeds a brand-new concept from its first member (unit-normalized)', () => {
    const seeded = foldConceptMember('concept-1', null, vec(3, 4, 0));
    expect(seeded.memberCount).toBe(1);
    const magnitude = Math.hypot(...Array.from(seeded.centroid));
    expect(magnitude).toBeCloseTo(1, 4);
  });

  it('folding the SAME vector twice leaves the centroid direction unchanged', () => {
    const seeded = foldConceptMember('concept-1', null, vec(1, 0, 0));
    const folded = foldConceptMember('concept-1', seeded, vec(1, 0, 0));
    expect(folded.memberCount).toBe(2);
    expect(Array.from(folded.centroid).map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 0, 0]);
  });

  it('a running fold converges toward the batch mean of all members (order-insensitive-ish)', () => {
    const a = vec(1, 0, 0);
    const b = vec(0, 1, 0);
    const seeded = foldConceptMember('concept-1', null, a);
    const folded = foldConceptMember('concept-1', seeded, b);
    // Mean of (1,0,0) and (0,1,0) is (0.5,0.5,0), normalized to ~(0.707,0.707,0).
    expect(folded.centroid[0]).toBeCloseTo(0.7071, 3);
    expect(folded.centroid[1]).toBeCloseTo(0.7071, 3);
  });
});

describe('isDegenerateEmbedding', () => {
  it('flags an all-zero vector', () => {
    expect(isDegenerateEmbedding(new Float32Array(384))).toBe(true);
  });

  it('flags a vector containing NaN or Infinity', () => {
    const withNaN = vec(0.1, Number.NaN, 0.2);
    const withInf = vec(0.1, Number.POSITIVE_INFINITY, 0.2);
    expect(isDegenerateEmbedding(withNaN)).toBe(true);
    expect(isDegenerateEmbedding(withInf)).toBe(true);
  });

  it('flags an empty vector', () => {
    expect(isDegenerateEmbedding(new Float32Array(0))).toBe(true);
  });

  it('does not flag a normal non-zero, finite vector', () => {
    expect(isDegenerateEmbedding(vec(0.6, 0.8, 0))).toBe(false);
  });
});

describe('isIdenticalVectorBatch', () => {
  it('flags a batch where every vector is the SAME (embedder constant-output signature)', () => {
    const constant = vec(0.5, 0.5, 0.5, 0.5);
    expect(isIdenticalVectorBatch([constant, vec(0.5, 0.5, 0.5, 0.5), vec(0.5, 0.5, 0.5, 0.5)])).toBe(
      true,
    );
  });

  it('does not flag a batch of genuinely distinct vectors', () => {
    expect(isIdenticalVectorBatch([vec(1, 0, 0), vec(0, 1, 0), vec(0, 0, 1)])).toBe(false);
  });

  it('never flags a batch of fewer than 2 usable vectors', () => {
    expect(isIdenticalVectorBatch([])).toBe(false);
    expect(isIdenticalVectorBatch([vec(1, 0, 0)])).toBe(false);
    // One degenerate + one usable = only 1 usable vector to compare.
    expect(isIdenticalVectorBatch([new Float32Array(3), vec(1, 0, 0)])).toBe(false);
  });
});

describe('isConceptDistributionDegenerate', () => {
  it('is false for a small vocabulary resolving to one concept (plausible on its own)', () => {
    expect(isConceptDistributionDegenerate(5, 1)).toBe(false);
  });

  it('is true once the vocabulary is past the floor and still one concept', () => {
    expect(
      isConceptDistributionDegenerate(CONCEPT_DISTRIBUTION_MIN_DISTINCT_KEYWORDS + 1, 1),
    ).toBe(true);
  });

  it('is false once the vocabulary shows more than one concept', () => {
    expect(isConceptDistributionDegenerate(500, 40)).toBe(false);
  });
});

describe('runaway-collapse regression (2026-08-17 incident)', () => {
  // Synthetic embedding family shaped like the MEASURED real-embedder
  // baseline (see keywordConcepts.ts's THRESHOLD comment): every keyword's
  // vector is dominated by a SHARED component (alpha) plus a small
  // per-keyword distinguishing component (beta=1), tuned so two DIFFERENT
  // keywords' vectors land at cosine ~0.85 — squarely inside the real
  // measured noise floor for unrelated single-word e5 embeddings
  // (0.78-0.87). This reproduces the ALGORITHM-LEVEL failure (greedy
  // online-leader clustering + running-mean centroid self-reinforcement)
  // deterministically and fast, without depending on the real ONNX model —
  // the exact shape of embedding distribution that collapsed the live
  // vault to concepts=1.
  const DIM = 24;
  const ALPHA = 2.3805; // alpha^2/(alpha^2+1) ~= 0.85
  const BETA = 1;
  const syntheticKeywordVector = (index: number): Float32Array => {
    const v = new Float32Array(DIM);
    v[0] = ALPHA; // shared component every keyword carries
    v[1 + (index % (DIM - 1))] = BETA; // per-keyword distinguishing component
    // Real embed() (both the production e5 pipeline and the deterministic
    // test embedder) always returns L2-normalized vectors — the running-
    // mean centroid fold assumes this too (it folds an already-normalized
    // `existing.centroid` together with `newEmbedding`), so an un-
    // normalized synthetic vector here would exercise a scale mismatch
    // that never happens in production.
    return normalize(v);
  };

  const collapseAtThreshold = (count: number, threshold: number): number => {
    const centroids: ConceptCentroid[] = [];
    let nextId = 1;
    for (let i = 0; i < count; i += 1) {
      const embedding = syntheticKeywordVector(i);
      const decision = assignConceptForKeyword(embedding, centroids, threshold);
      if (decision.matchedConceptId !== null) {
        const idx = centroids.findIndex((c) => c.conceptId === decision.matchedConceptId);
        centroids[idx] = foldConceptMember(decision.matchedConceptId, centroids[idx]!, embedding);
      } else {
        centroids.push(foldConceptMember(`concept-${String(nextId)}`, null, embedding));
        nextId += 1;
      }
    }
    return centroids.length;
  };

  it('the OLD 0.82 threshold catastrophically collapses a diverse vocabulary into ~1 concept', () => {
    // Locks in the FAILURE this incident measured — if this ever starts
    // passing with a HIGH concept count, the synthetic fixture stopped
    // modeling the real noise floor and needs to be re-tuned against fresh
    // pairwise-cosine evidence, not silently trusted.
    expect(collapseAtThreshold(20, 0.82)).toBeLessThanOrEqual(2);
  });

  it('the calibrated DEFAULT_CONCEPT_COSINE_THRESHOLD does NOT collapse the same vocabulary', () => {
    const concepts = collapseAtThreshold(20, DEFAULT_CONCEPT_COSINE_THRESHOLD);
    expect(concepts).toBeGreaterThan(10);
  });

  it('DEFAULT_CONCEPT_COSINE_THRESHOLD is pinned to the calibrated value (regression guard against reverting to the old default)', () => {
    expect(DEFAULT_CONCEPT_COSINE_THRESHOLD).toBe(0.92);
  });
});

describe('conceptJaccard', () => {
  it('is 1.0 for identical concept-id sets', () => {
    expect(conceptJaccard(['c1', 'c2'], ['c2', 'c1'])).toBe(1);
  });

  it('is 0 for disjoint sets', () => {
    expect(conceptJaccard(['c1'], ['c2'])).toBe(0);
  });

  it('is 0 for two empty sets (no shared evidence, not "fully similar")', () => {
    expect(conceptJaccard([], [])).toBe(0);
  });

  it('computes intersection over union for partial overlap', () => {
    expect(conceptJaccard(['c1', 'c2', 'c3'], ['c2', 'c3', 'c4'])).toBeCloseTo(2 / 4, 5);
  });
});
