import { describe, expect, it } from 'vitest';

import { teamDraftInterleave, type RankedList } from './teamDraft.js';

const incumbent: RankedList = { producer: 'incumbent', items: ['i1', 'i2', 'i3', 'i4'] };
const candidate: RankedList = { producer: 'candidate', items: ['c1', 'c2', 'c3', 'c4'] };

describe('teamDraftInterleave — determinism', () => {
  it('produces the identical strip for the same (lists, seed)', () => {
    const a = teamDraftInterleave(incumbent, candidate, 12345);
    const b = teamDraftInterleave(incumbent, candidate, 12345);
    expect(a.items).toEqual(b.items);
    expect(a.firstPick).toBe(b.firstPick);
  });

  it('can produce a different strip for a different seed', () => {
    // Search for two seeds whose first pick differs — proves the seed
    // actually steers the fairness coin (not that every pair differs).
    const first = teamDraftInterleave(incumbent, candidate, 1).firstPick;
    let sawDifferent = false;
    for (let seed = 2; seed < 50; seed += 1) {
      if (teamDraftInterleave(incumbent, candidate, seed).firstPick !== first) {
        sawDifferent = true;
        break;
      }
    }
    expect(sawDifferent).toBe(true);
  });
});

describe('teamDraftInterleave — fairness', () => {
  it('alternates picks so team sizes never differ by more than one', () => {
    const result = teamDraftInterleave(incumbent, candidate, 7);
    let iCount = 0;
    let cCount = 0;
    for (const item of result.items) {
      if (item.producer === 'incumbent') iCount += 1;
      else cCount += 1;
      // After every pick the running counts stay within 1 of each other —
      // the defining fairness property of team-draft.
      expect(Math.abs(iCount - cCount)).toBeLessThanOrEqual(1);
    }
  });

  it('drafts equal shares from two equal-length disjoint lists', () => {
    const result = teamDraftInterleave(incumbent, candidate, 7);
    const iCount = result.items.filter((x) => x.producer === 'incumbent').length;
    const cCount = result.items.filter((x) => x.producer === 'candidate').length;
    expect(iCount).toBe(4);
    expect(cCount).toBe(4);
    expect(result.items.length).toBe(8);
  });

  it('gives the first pick to the team that won the coin', () => {
    const result = teamDraftInterleave(incumbent, candidate, 7);
    expect(result.items[0]?.producer).toBe(result.firstPick);
  });

  it('the winner of the first pick contributes its top item first', () => {
    const result = teamDraftInterleave(incumbent, candidate, 7);
    const expectedTop = result.firstPick === 'incumbent' ? 'i1' : 'c1';
    expect(result.items[0]?.itemId).toBe(expectedTop);
  });
});

describe('teamDraftInterleave — dedup + attribution', () => {
  it('shows a shared item only once, credited to the team that drafted it first', () => {
    const withShared: RankedList = { producer: 'incumbent', items: ['x', 'i2'] };
    const alsoShared: RankedList = { producer: 'candidate', items: ['x', 'c2'] };
    const result = teamDraftInterleave(withShared, alsoShared, 3);
    const xItems = result.items.filter((it) => it.itemId === 'x');
    expect(xItems.length).toBe(1); // shown once, not twice.
    // Every item carries a producer and a monotonic position.
    result.items.forEach((it, idx) => {
      expect(it.position).toBe(idx);
      expect(['incumbent', 'candidate']).toContain(it.producer);
    });
  });

  it('drains a longer list entirely once the other is exhausted', () => {
    const short: RankedList = { producer: 'incumbent', items: ['i1'] };
    const long: RankedList = { producer: 'candidate', items: ['c1', 'c2', 'c3'] };
    const result = teamDraftInterleave(short, long, 9);
    expect(result.items.length).toBe(4); // 1 + 3, no drops.
    const ids = result.items.map((x) => x.itemId).sort();
    expect(ids).toEqual(['c1', 'c2', 'c3', 'i1']);
  });

  it('honors maxLength', () => {
    const result = teamDraftInterleave(incumbent, candidate, 7, 3);
    expect(result.items.length).toBe(3);
  });

  it('returns an empty strip for two empty lists', () => {
    const result = teamDraftInterleave(
      { producer: 'incumbent', items: [] },
      { producer: 'candidate', items: [] },
      1,
    );
    expect(result.items.length).toBe(0);
  });
});
