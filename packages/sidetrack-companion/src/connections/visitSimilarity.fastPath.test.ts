// Stage 5.2 W3 — buildVisitSimilarityIncremental cosine fast path.
// NOT byte-equal with buildVisitSimilarity (different algorithm); the
// modelRevision string is suffixed `:incremental` so cached revisions
// stay distinct.

import { describe, expect, it } from 'vitest';

import { buildVisitSimilarityIncremental } from './visitSimilarity.js';
import { IncrementalVisitSimilarityIndex } from './visitSimilarity.incremental.js';
import type { VisitSimilarityEntry } from './visitSimilarity.js';

const unit = (values: readonly number[]): Float32Array => {
  const n = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return Float32Array.from(values.map((v) => v / n));
};

const entry = (id: string, focusedWindowMs = 60_000): VisitSimilarityEntry => ({
  id,
  url: `https://example.com/${id}`,
  canonicalUrl: `https://example.com/${id}`,
  title: `Page ${id}`,
  visitCount: 1,
  firstSeenAt: '2026-05-12T10:00:00.000Z',
  lastSeenAt: '2026-05-12T10:30:00.000Z',
  dimensions: { engagement: { focusedWindowMs } } as unknown as VisitSimilarityEntry['dimensions'],
});

describe('Stage 5.2 W3 — buildVisitSimilarityIncremental', () => {
  it('produces edges between visits whose embeddings cluster above threshold', () => {
    const idx = new IncrementalVisitSimilarityIndex({ threshold: 0.85, topK: 5 });
    const entries = [entry('a'), entry('b'), entry('c')];
    const embeddings = new Map<string, Float32Array>([
      ['https://example.com/a', unit([1, 0])],
      ['https://example.com/b', unit([1, 0.01])], // ~1.0 cosine with a
      ['https://example.com/c', unit([0, 1])], // orthogonal to a/b
    ]);
    const revision = buildVisitSimilarityIncremental({
      index: idx,
      entries,
      embeddingsByVisitKey: embeddings,
      options: { threshold: 0.85, topK: 5, engagementGateMs: 0 },
    });
    expect(revision.modelRevision).toContain(':incremental');
    // Edges should include a–b (high cosine) but not a–c / b–c (low cosine).
    const pairs = revision.edges.map((e) => [e.fromVisitKey, e.toVisitKey].sort().join(' '));
    expect(pairs).toContain('https://example.com/a https://example.com/b');
    expect(pairs).not.toContain('https://example.com/a https://example.com/c');
    expect(pairs).not.toContain('https://example.com/b https://example.com/c');
  });

  it('re-running with the same index + entries is idempotent', () => {
    const idx = new IncrementalVisitSimilarityIndex({ threshold: 0.85, topK: 5 });
    const entries = [entry('a'), entry('b')];
    const embeddings = new Map<string, Float32Array>([
      ['https://example.com/a', unit([1, 0])],
      ['https://example.com/b', unit([1, 0.01])],
    ]);
    const r1 = buildVisitSimilarityIncremental({
      index: idx,
      entries,
      embeddingsByVisitKey: embeddings,
      options: { threshold: 0.85, topK: 5, engagementGateMs: 0 },
    });
    const r2 = buildVisitSimilarityIncremental({
      index: idx,
      entries,
      embeddingsByVisitKey: embeddings,
      options: { threshold: 0.85, topK: 5, engagementGateMs: 0 },
    });
    expect(r2.edges).toEqual(r1.edges);
    expect(idx.size()).toBe(2);
  });

  it('missing embedding for an entry leaves it out of the index', () => {
    const idx = new IncrementalVisitSimilarityIndex({ threshold: 0.85, topK: 5 });
    const entries = [entry('a'), entry('b')];
    const embeddings = new Map<string, Float32Array>([
      ['https://example.com/a', unit([1, 0])],
      // b missing — should be skipped
    ]);
    const revision = buildVisitSimilarityIncremental({
      index: idx,
      entries,
      embeddingsByVisitKey: embeddings,
      options: { threshold: 0.85, topK: 5, engagementGateMs: 0 },
    });
    expect(idx.size()).toBe(1);
    expect(revision.edges).toEqual([]);
  });
});
