import { describe, expect, it } from 'vitest';

import { RRF_K, fuseByRank } from './rrf.js';

interface Item {
  id: string;
}
const keyOf = (item: Item): string => item.id;

const list = (name: string, ids: readonly string[]): { name: string; items: Item[] } => ({
  name,
  items: ids.map((id) => ({ id })),
});

describe('fuseByRank (RRF)', () => {
  it('a single ranker passes through unchanged', () => {
    const fused = fuseByRank([list('A', ['a', 'b', 'c'])], keyOf);
    expect(fused.map((f) => f.item.id)).toEqual(['a', 'b', 'c']);
    expect(fused[0]?.ranks.fusionScore).toBeCloseTo(1 / (RRF_K + 1));
  });

  it('same item in BOTH rankers sums its contributions', () => {
    const fused = fuseByRank(
      [list('A', ['x', 'y']), list('B', ['x', 'z'])],
      keyOf,
    );
    // x is at rank 1 in both → score 2/(k+1)
    const xScore = 2 / (RRF_K + 1);
    expect(fused[0]?.item.id).toBe('x');
    expect(fused[0]?.ranks.fusionScore).toBeCloseTo(xScore);
    expect(fused[0]?.ranks.perRanker.get('A')).toBe(1);
    expect(fused[0]?.ranks.perRanker.get('B')).toBe(1);
  });

  it('orders by fusion score regardless of source-list raw scores', () => {
    // List A has scale 0..1000, list B has scale 0..1; RRF is
    // rank-based so the scale is irrelevant.
    const fused = fuseByRank(
      [list('A', ['a', 'b', 'c']), list('B', ['x', 'a', 'y'])],
      keyOf,
    );
    const order = fused.map((f) => f.item.id);
    // `a` shows up in BOTH (rank 1 in A, rank 2 in B). It must beat
    // `x` which only appears in B at rank 1: a's score is
    // 1/(k+1) + 1/(k+2) ≈ 0.03284 vs x's 1/(k+1) ≈ 0.01639.
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('x'));
  });

  it('rank 1 in one list beats rank 5 in another', () => {
    const fused = fuseByRank(
      [list('A', ['p1', 'p2', 'p3', 'p4', 'p5']), list('B', ['q1'])],
      keyOf,
    );
    expect(fused[0]?.item.id).toBe('p1'); // tied scores; insertion order breaks
    // Actually p1 (rank 1 in A) and q1 (rank 1 in B) have identical
    // scores; insertion-order tiebreak puts p1 first.
    expect(fused.findIndex((f) => f.item.id === 'q1')).toBeLessThan(
      fused.findIndex((f) => f.item.id === 'p5'),
    );
  });

  it('records rank evidence per ranker the item appeared in', () => {
    const fused = fuseByRank(
      [list('lex', ['a', 'b', 'c']), list('vec', ['b', 'a', 'd'])],
      keyOf,
    );
    const a = fused.find((f) => f.item.id === 'a');
    expect(a?.ranks.perRanker.get('lex')).toBe(1);
    expect(a?.ranks.perRanker.get('vec')).toBe(2);
    expect(a?.ranks.k).toBe(RRF_K);
    // `d` only in vec, rank 3
    const d = fused.find((f) => f.item.id === 'd');
    expect(d?.ranks.perRanker.get('lex')).toBeUndefined();
    expect(d?.ranks.perRanker.get('vec')).toBe(3);
  });

  it('handles an empty ranker without crashing', () => {
    const fused = fuseByRank(
      [list('A', []), list('B', ['x', 'y'])],
      keyOf,
    );
    expect(fused.map((f) => f.item.id)).toEqual(['x', 'y']);
  });

  it('returns [] when every ranker is empty', () => {
    expect(fuseByRank<Item>([list('A', []), list('B', [])], keyOf)).toEqual([]);
  });

  it('respects a custom k', () => {
    const fused = fuseByRank([list('A', ['x'])], keyOf, { k: 5 });
    expect(fused[0]?.ranks.k).toBe(5);
    expect(fused[0]?.ranks.fusionScore).toBeCloseTo(1 / 6);
  });
});
