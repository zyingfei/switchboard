// Stage 5.2 W3 — IncrementalVisitSimilarityIndex tests.

import { describe, expect, it } from 'vitest';

import type { VisitSimilarityBudget } from './visitSimilarity.budget.js';
import { IncrementalVisitSimilarityIndex } from './visitSimilarity.incremental.js';

const unit = (values: readonly number[]): Float32Array => {
  const n = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return Float32Array.from(values.map((v) => v / n));
};

const warmBudget: VisitSimilarityBudget = {
  corpusSize: 0,
  embedderWarmUntilMs: Number.MAX_SAFE_INTEGER,
  recentEmbedP99Ms: 10,
  nowMs: 0,
};

describe('Stage 5.2 W3 — IncrementalVisitSimilarityIndex', () => {
  it('first insert produces no edges (no existing neighbors)', () => {
    const idx = new IncrementalVisitSimilarityIndex({ threshold: 0.85, topK: 5 });
    const result = idx.insert({
      visitKey: 'a',
      embedding: unit([1, 0]),
      budget: warmBudget,
    });
    expect(result.inserted).toBe(true);
    expect(result.newEdges).toEqual([]);
    expect(idx.size()).toBe(1);
  });

  it('second insert produces an edge when cosine >= threshold', () => {
    const idx = new IncrementalVisitSimilarityIndex({ threshold: 0.85, topK: 5 });
    idx.insert({ visitKey: 'a', embedding: unit([1, 0]), budget: warmBudget });
    const result = idx.insert({
      visitKey: 'b',
      embedding: unit([1, 0.01]),
      budget: warmBudget,
    });
    expect(result.inserted).toBe(true);
    expect(result.newEdges).toHaveLength(1);
    expect(result.newEdges[0]!.fromVisitKey).toBe('a');
    expect(result.newEdges[0]!.toVisitKey).toBe('b');
    expect(result.newEdges[0]!.cosine).toBeGreaterThan(0.9);
  });

  it('low-cosine inserts produce no new edges', () => {
    const idx = new IncrementalVisitSimilarityIndex({ threshold: 0.85, topK: 5 });
    idx.insert({ visitKey: 'a', embedding: unit([1, 0]), budget: warmBudget });
    const result = idx.insert({
      visitKey: 'b',
      embedding: unit([0, 1]),
      budget: warmBudget,
    });
    expect(result.newEdges).toEqual([]);
  });

  it('respects budget gate — returns inserted=false with skipReason when cold', () => {
    const idx = new IncrementalVisitSimilarityIndex({ threshold: 0.85, topK: 5 });
    const result = idx.insert({
      visitKey: 'a',
      embedding: unit([1, 0]),
      budget: { corpusSize: 0 }, // no embedderWarmUntilMs → cold
    });
    expect(result.inserted).toBe(false);
    expect(result.skipReason).toBe('embedder-warmth-unknown');
    expect(idx.size()).toBe(0);
  });

  it('top-K cap evicts the weakest existing neighbor when V is stronger', () => {
    const idx = new IncrementalVisitSimilarityIndex({ threshold: 0.85, topK: 2 });
    // Three neighbors of 'anchor', V is the 4th and stronger than the
    // existing weakest. V should evict.
    idx.insert({ visitKey: 'anchor', embedding: unit([1, 0]), budget: warmBudget });
    idx.insert({ visitKey: 'weak', embedding: unit([1, 0.4]), budget: warmBudget });
    idx.insert({ visitKey: 'medium', embedding: unit([1, 0.3]), budget: warmBudget });
    const result = idx.insert({
      visitKey: 'strong',
      embedding: unit([1, 0.01]),
      budget: warmBudget,
    });
    expect(result.inserted).toBe(true);
    // The anchor's top-2 should now be {strong, medium}; weak got evicted.
    const edges = idx.edges();
    const anchorPartners = edges
      .filter((e) => e.fromVisitKey === 'anchor' || e.toVisitKey === 'anchor')
      .map((e) => (e.fromVisitKey === 'anchor' ? e.toVisitKey : e.fromVisitKey));
    expect(anchorPartners).toContain('strong');
    expect(anchorPartners).toContain('medium');
    expect(anchorPartners).not.toContain('weak');
  });

  it('edges() returns deduped + sorted edge list', () => {
    const idx = new IncrementalVisitSimilarityIndex({ threshold: 0.85, topK: 5 });
    idx.insert({ visitKey: 'b', embedding: unit([1, 0]), budget: warmBudget });
    idx.insert({ visitKey: 'a', embedding: unit([1, 0.01]), budget: warmBudget });
    idx.insert({ visitKey: 'c', embedding: unit([1, 0.02]), budget: warmBudget });
    const edges = idx.edges();
    // Should be 3 unique pairs sorted (a,b), (a,c), (b,c).
    expect(edges.map((e) => [e.fromVisitKey, e.toVisitKey])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
  });

  it('re-inserting an existing visitKey is a no-op', () => {
    const idx = new IncrementalVisitSimilarityIndex({ threshold: 0.85, topK: 5 });
    idx.insert({ visitKey: 'a', embedding: unit([1, 0]), budget: warmBudget });
    const result = idx.insert({
      visitKey: 'a',
      embedding: unit([0, 1]), // would change embedding but idempotent guard wins
      budget: warmBudget,
    });
    expect(result.inserted).toBe(true);
    expect(result.newEdges).toEqual([]);
    expect(idx.size()).toBe(1);
  });
});
