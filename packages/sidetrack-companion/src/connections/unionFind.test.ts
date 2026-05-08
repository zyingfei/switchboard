import { describe, expect, it } from 'vitest';

import { UnionFind } from './unionFind.js';

describe('UnionFind', () => {
  it('adds keys, unions components, and finds stable roots', () => {
    const uf = new UnionFind();
    uf.add('A');
    uf.add('B');
    uf.add('C');

    expect(uf.find('A')).toBe('A');
    expect(uf.union('A', 'B')).toBe('A');
    expect(uf.find('B')).toBe('A');
    expect(uf.members('A')).toEqual(['A', 'B']);
    expect(uf.components()).toEqual([
      { root: 'A', members: ['A', 'B'] },
      { root: 'C', members: ['C'] },
    ]);
  });

  it('uses the earlier inserted root when ranks tie', () => {
    const uf = new UnionFind();
    uf.add('B');
    uf.add('A');

    expect(uf.union('A', 'B')).toBe('B');
    expect(uf.find('A')).toBe('B');
    expect(uf.members('B')).toEqual(['B', 'A']);
  });

  it('returns deterministic components for a fixed insertion sequence', () => {
    const build = (): readonly unknown[] => {
      const uf = new UnionFind();
      for (const key of ['A', 'B', 'C', 'D', 'E']) uf.add(key);
      uf.union('B', 'C');
      uf.union('D', 'E');
      uf.union('A', 'C');
      return uf.components();
    };

    expect(build()).toEqual(build());
  });

  it('path compression preserves component identity across deep find chains', () => {
    const uf = new UnionFind();
    for (const key of ['A', 'B', 'C', 'D', 'E', 'F']) uf.add(key);
    uf.union('A', 'B');
    uf.union('B', 'C');
    uf.union('C', 'D');
    uf.union('D', 'E');
    uf.union('E', 'F');

    const rootBefore = uf.find('F');
    const rootAfter = uf.find('F');

    expect(rootBefore).toBe('A');
    expect(rootAfter).toBe(rootBefore);
    expect(uf.members(rootAfter)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('throws on find for unknown keys', () => {
    const uf = new UnionFind();
    expect(() => uf.find('missing')).toThrow(/key not found/u);
  });
});
