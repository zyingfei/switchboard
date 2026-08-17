import { describe, expect, it } from 'bun:test';

import {
  identifyOutliers,
  MIN_POOL_FOR_OUTLIER_DETECTION,
  selectMedoids,
  type EmbeddedMember,
} from './prototypeMedoids.js';

// A small synthetic embedding space. Two tight ML clusters (kv-cache /
// speculative-decoding, both "inference perf") plus one planted outlier
// (the day-one "pineapple cake" evidence) that is nearly orthogonal to the
// ML cluster's centroid. All vectors pre-normalized (unit length), matching
// the real e5 embedder's contract this module assumes.
const unit = (values: readonly number[]): Float32Array => {
  const raw = Float32Array.from(values);
  let sum = 0;
  for (const v of raw) sum += v * v;
  const len = Math.sqrt(sum);
  return len === 0 ? raw : Float32Array.from(raw, (v) => v / len);
};

const ML_CLUSTER: readonly EmbeddedMember[] = [
  { id: 'kv-cache-1', embedding: unit([1, 0.05, 0, 0]) },
  { id: 'kv-cache-2', embedding: unit([1, 0.08, 0.02, 0]) },
  { id: 'spec-decode-1', embedding: unit([0.9, 0.4, 0, 0]) },
  { id: 'spec-decode-2', embedding: unit([0.85, 0.45, 0.05, 0]) },
  { id: 'paged-attn-1', embedding: unit([0.95, 0.2, 0.1, 0]) },
];

const PINEAPPLE_CAKE: EmbeddedMember = { id: 'pineapple-cake', embedding: unit([0, 0, 0, 1]) };

describe('identifyOutliers — the pineapple-cake guard', () => {
  it('excludes a planted far-outlier from a tight cluster', () => {
    const pool = [...ML_CLUSTER, PINEAPPLE_CAKE];
    const outliers = identifyOutliers(pool);
    expect(outliers.has('pineapple-cake')).toBe(true);
    // The tight ML members must not be swept up as collateral damage.
    for (const member of ML_CLUSTER) {
      expect(outliers.has(member.id)).toBe(false);
    }
  });

  it('is deterministic — repeated calls over an unchanged pool agree exactly', () => {
    const pool = [...ML_CLUSTER, PINEAPPLE_CAKE];
    const first = identifyOutliers(pool);
    const second = identifyOutliers(pool);
    expect([...first].sort()).toEqual([...second].sort());
  });

  it('below MIN_POOL_FOR_OUTLIER_DETECTION, excludes nothing — a percentile over too few points is not robust', () => {
    const tiny = [...ML_CLUSTER, PINEAPPLE_CAKE].slice(0, MIN_POOL_FOR_OUTLIER_DETECTION - 1);
    expect(identifyOutliers(tiny).size).toBe(0);
  });

  it('a uniform pool (everything equidistant from centroid) excludes nothing', () => {
    const uniform: readonly EmbeddedMember[] = [
      { id: 'a', embedding: unit([1, 0, 0, 0]) },
      { id: 'b', embedding: unit([0, 1, 0, 0]) },
      { id: 'c', embedding: unit([0, 0, 1, 0]) },
      { id: 'd', embedding: unit([0, 0, 0, 1]) },
      { id: 'e', embedding: unit([1, 1, 1, 1]) },
    ];
    // Every member is exactly the P90-percentile distance (or below it) by
    // construction of the sorted-index selection — nothing exceeds it.
    expect(identifyOutliers(uniform).size).toBe(0);
  });
});

describe('selectMedoids — deterministic representative + diverse selection', () => {
  it('never selects the planted outlier once it has been excluded', () => {
    const pool = [...ML_CLUSTER, PINEAPPLE_CAKE];
    const outliers = identifyOutliers(pool);
    const medoids = selectMedoids(pool, 3, outliers);
    expect(medoids).not.toContain('pineapple-cake');
    expect(medoids.length).toBe(3);
  });

  it('the first medoid is the member closest to the pool centroid', () => {
    // paged-attn-1 sits closest to the cluster's mean direction (verified
    // against the actual meanNormalized centroid, not hand-guessed) — the
    // single most "typical" real page in the pool.
    const medoids = selectMedoids(ML_CLUSTER, 1);
    expect(medoids).toEqual(['paged-attn-1']);
  });

  it('diversifies beyond the first pick — does not return K near-duplicates of the centroid', () => {
    const medoids = selectMedoids(ML_CLUSTER, 3);
    expect(medoids.length).toBe(3);
    expect(new Set(medoids).size).toBe(3); // no duplicate ids
    // A diversified pick must include something from the more different
    // sub-cluster (spec-decode-*), not just three near-identical kv-cache
    // variants.
    expect(medoids.some((id) => id.startsWith('spec-decode'))).toBe(true);
  });

  it('is fully deterministic — repeated calls over an unchanged pool return the identical ordered list', () => {
    const first = selectMedoids(ML_CLUSTER, 3);
    const second = selectMedoids(ML_CLUSTER, 3);
    expect(second).toEqual(first);
  });

  it('never pads with duplicates when k exceeds the eligible pool size', () => {
    const medoids = selectMedoids(ML_CLUSTER.slice(0, 2), 5);
    expect(medoids.length).toBe(2);
    expect(new Set(medoids).size).toBe(2);
  });

  it('returns [] for an empty pool or k<=0', () => {
    expect(selectMedoids([], 3)).toEqual([]);
    expect(selectMedoids(ML_CLUSTER, 0)).toEqual([]);
  });

  it('excluding every candidate returns []', () => {
    const allExcluded = new Set(ML_CLUSTER.map((m) => m.id));
    expect(selectMedoids(ML_CLUSTER, 3, allExcluded)).toEqual([]);
  });
});
