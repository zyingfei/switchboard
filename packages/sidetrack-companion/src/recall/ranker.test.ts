import { describe, expect, it } from 'vitest';

import { freshnessDecay, rank, type IndexEntry } from './ranker.js';

const entry = (
  id: string,
  threadId: string,
  capturedAt: string,
  embedding: readonly number[],
): IndexEntry => ({
  id,
  threadId,
  capturedAt,
  embedding: Float32Array.from(embedding),
});

describe('recall ranker', () => {
  it('applies calibrated freshness bands', () => {
    const now = new Date('2026-05-03T00:00:00.000Z');

    expect(freshnessDecay('2026-05-01T00:00:00.000Z', now)).toBe(1);
    expect(freshnessDecay('2026-04-20T00:00:00.000Z', now)).toBe(0.85);
    expect(freshnessDecay('2026-03-01T00:00:00.000Z', now)).toBe(0.7);
    expect(freshnessDecay('2025-05-03T00:00:00.000Z', now)).toBe(0.5);
    expect(freshnessDecay('2020-05-03T00:00:00.000Z', now)).toBe(0.3);
  });

  it('sorts by similarity times freshness and filters workstream membership', () => {
    const results = rank(
      Float32Array.from([1, 0]),
      [
        entry('old', 'thread_a', '2020-05-03T00:00:00.000Z', [1, 0]),
        entry('fresh', 'thread_b', '2026-05-03T00:00:00.000Z', [0.8, 0]),
      ],
      new Date('2026-05-03T00:00:00.000Z'),
      { workstreamMembership: (threadId) => threadId === 'thread_b' },
    );

    expect(results.map((item) => item.id)).toEqual(['fresh']);
  });

  it('clamps limits to fifty', () => {
    const items = Array.from({ length: 60 }, (_, index) =>
      entry(String(index), 'thread', '2026-05-03T00:00:00.000Z', [1]),
    );

    expect(rank(Float32Array.from([1]), items, new Date(), { limit: 999 })).toHaveLength(50);
  });
});
