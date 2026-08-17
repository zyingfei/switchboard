import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_CONCEPT_COSINE_THRESHOLD,
  assignConceptForKeyword,
  conceptJaccard,
  foldConceptMember,
  type ConceptCentroid,
} from './keywordConcepts.js';

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
