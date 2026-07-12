import { describe, expect, it } from 'vitest';

import type { Dot } from '../causal.js';
import { computeGapSeals, enumerateGapCandidates } from './connectionsMaterializer.js';

const key = (d: Dot): string => `${d.replicaId}#${String(d.seq)}`;

describe('enumerateGapCandidates', () => {
  it('emits only hole seqs STRICTLY BELOW the watermark', () => {
    // [1,100] then [103,200]: holes at 101,102. Watermark 200 (store streamed
    // past both) -> both eligible.
    const intervals = {
      A: [
        [1, 100],
        [103, 200],
      ] as ReadonlyArray<readonly [number, number]>,
    };
    expect(enumerateGapCandidates(intervals, { A: 200 }, 256).map(key)).toEqual(['A#101', 'A#102']);
  });

  it('excludes holes at/above the watermark (not-yet-arrived, never skipped)', () => {
    const intervals = {
      A: [
        [1, 100],
        [103, 200],
      ] as ReadonlyArray<readonly [number, number]>,
    };
    // Watermark only 101 -> 101 is below wm (eligible), 102 is NOT (>= wm).
    expect(enumerateGapCandidates(intervals, { A: 101 }, 256).map(key)).toEqual([]);
    expect(enumerateGapCandidates(intervals, { A: 102 }, 256).map(key)).toEqual(['A#101']);
  });

  it('enumerates a leading hole when the first interval does not start at 1', () => {
    const intervals = { A: [[5, 9]] as ReadonlyArray<readonly [number, number]> };
    expect(enumerateGapCandidates(intervals, { A: 9 }, 256).map(key)).toEqual([
      'A#1',
      'A#2',
      'A#3',
      'A#4',
    ]);
  });

  it('returns nothing for a healthy (gapless) interval set', () => {
    const intervals = { A: [[1, 200]] as ReadonlyArray<readonly [number, number]> };
    expect(enumerateGapCandidates(intervals, { A: 200 }, 256)).toEqual([]);
  });

  it('respects the candidate cap', () => {
    const intervals = {
      A: [
        [1, 1],
        [100, 200],
      ] as ReadonlyArray<readonly [number, number]>,
    };
    // Holes 2..99 below watermark 200; cap to 3.
    expect(enumerateGapCandidates(intervals, { A: 200 }, 3).map(key)).toEqual(['A#2', 'A#3', 'A#4']);
  });
});

describe('computeGapSeals', () => {
  const gap: Dot = { replicaId: 'A', seq: 101 };
  const alwaysAbsent = (): boolean => true;

  it('seals a gap that reaches the aging threshold and drops it from the map', () => {
    // prior count is minAging-1; one more proven-absent drain seals it.
    const { seals, nextAging } = computeGapSeals([gap], { 'A#101': 7 }, alwaysAbsent, 8);
    expect(seals.map(key)).toEqual(['A#101']);
    expect(nextAging).toEqual({}); // sealed -> not carried forward
  });

  it('increments (does not seal) a gap below the aging threshold', () => {
    const { seals, nextAging } = computeGapSeals([gap], { 'A#101': 2 }, alwaysAbsent, 8);
    expect(seals).toEqual([]);
    expect(nextAging).toEqual({ 'A#101': 3 });
  });

  it('starts the counter at 1 for a newly observed gap', () => {
    const { seals, nextAging } = computeGapSeals([gap], {}, alwaysAbsent, 8);
    expect(seals).toEqual([]);
    expect(nextAging).toEqual({ 'A#101': 1 });
  });

  it('RESETS the counter (no seal) when the seq reappears — out-of-order safety', () => {
    // Even one drain where proveAbsent is false drops the counter entirely,
    // so a late out-of-order dot can never be sealed.
    const reappeared = (): boolean => false;
    const { seals, nextAging } = computeGapSeals([gap], { 'A#101': 7 }, reappeared, 8);
    expect(seals).toEqual([]);
    expect(nextAging).toEqual({}); // reset to 0 (omitted)
  });

  it('does not seal until minAging CONSECUTIVE proven-absent drains', () => {
    let aging: Record<string, number> = {};
    // 2 absent drains, then a reappearance on drain 3, then absent again.
    aging = computeGapSeals([gap], aging, alwaysAbsent, 3).nextAging; // {A#101:1}
    aging = computeGapSeals([gap], aging, alwaysAbsent, 3).nextAging; // {A#101:2}
    aging = computeGapSeals([gap], aging, () => false, 3).nextAging; // reset -> {}
    expect(aging).toEqual({});
    aging = computeGapSeals([gap], aging, alwaysAbsent, 3).nextAging; // {A#101:1}
    aging = computeGapSeals([gap], aging, alwaysAbsent, 3).nextAging; // {A#101:2}
    const final = computeGapSeals([gap], aging, alwaysAbsent, 3); // count 3 -> seal
    expect(final.seals.map(key)).toEqual(['A#101']);
  });
});
