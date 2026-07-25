import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetRankerShadowDiffForTests,
  kendallTau,
  peekRankerShadowDiff,
  rankerShadowDiffEnabled,
  recordRankerShadowDiff,
  topKOverlap,
} from './rankerShadowDiff.js';

describe('rankerShadowDiffEnabled (kill switch)', () => {
  const prior = process.env['SIDETRACK_RANKER_SHADOW_DIFF'];
  afterEach(() => {
    if (prior === undefined) delete process.env['SIDETRACK_RANKER_SHADOW_DIFF'];
    else process.env['SIDETRACK_RANKER_SHADOW_DIFF'] = prior;
  });

  it('defaults ON (read-only measurement is cheap + wanted broadly)', () => {
    delete process.env['SIDETRACK_RANKER_SHADOW_DIFF'];
    expect(rankerShadowDiffEnabled()).toBe(true);
  });

  it('is disabled by "0" or "off"', () => {
    process.env['SIDETRACK_RANKER_SHADOW_DIFF'] = '0';
    expect(rankerShadowDiffEnabled()).toBe(false);
    process.env['SIDETRACK_RANKER_SHADOW_DIFF'] = 'off';
    expect(rankerShadowDiffEnabled()).toBe(false);
  });
});

describe('topKOverlap', () => {
  it('is 1.0 for identical top-k membership', () => {
    expect(topKOverlap(['a', 'b', 'c'], ['a', 'b', 'c'], 3)).toBe(1);
    // Same set, different order — membership overlap ignores order.
    expect(topKOverlap(['a', 'b', 'c'], ['c', 'a', 'b'], 3)).toBe(1);
  });

  it('is 0 for a fully disjoint top-k', () => {
    expect(topKOverlap(['a', 'b'], ['x', 'y'], 2)).toBe(0);
  });

  it('measures partial membership overlap in the visible band', () => {
    // served top-2 = {a,b}; v6 top-2 = {a,x}; shared = {a} → 1/2.
    expect(topKOverlap(['a', 'b', 'c'], ['a', 'x', 'b'], 2)).toBe(0.5);
  });

  it('treats a short-but-identical result as 1.0 (denominator caps at length)', () => {
    expect(topKOverlap(['a', 'b'], ['a', 'b'], 10)).toBe(1);
  });

  it('is 1.0 for two empty orders (nothing to disagree about)', () => {
    expect(topKOverlap([], [], 5)).toBe(1);
  });
});

describe('kendallTau', () => {
  it('is 1.0 for identical order', () => {
    expect(kendallTau(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'])).toBe(1);
  });

  it('is -1.0 for a fully reversed order', () => {
    expect(kendallTau(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(-1);
  });

  it('is 1.0 when fewer than two entities are shared', () => {
    expect(kendallTau(['a'], ['a'])).toBe(1);
    expect(kendallTau(['a', 'b'], ['x', 'y'])).toBe(1);
  });

  it('measures a single-swap discordance', () => {
    // served a,b,c,d → v6 a,c,b,d. One discordant pair (b,c) out of 6.
    // tau = (5 - 1) / 6 = 0.6666…
    expect(kendallTau(['a', 'b', 'c', 'd'], ['a', 'c', 'b', 'd'])).toBeCloseTo(4 / 6, 6);
  });

  it('ignores entities not present in both orders', () => {
    // Only a,b are shared and in the same order → tau over the shared set = 1.
    expect(kendallTau(['a', 'z', 'b'], ['a', 'b', 'q'])).toBe(1);
  });
});

describe('recordRankerShadowDiff + peekRankerShadowDiff (rolling window)', () => {
  const priorEnabled = process.env['SIDETRACK_RANKER_SHADOW_DIFF'];
  const priorWindow = process.env['SIDETRACK_RANKER_SHADOW_DIFF_WINDOW'];
  const priorTopK = process.env['SIDETRACK_RANKER_SHADOW_DIFF_TOP_K'];

  beforeEach(() => {
    __resetRankerShadowDiffForTests();
    delete process.env['SIDETRACK_RANKER_SHADOW_DIFF'];
    delete process.env['SIDETRACK_RANKER_SHADOW_DIFF_WINDOW'];
    delete process.env['SIDETRACK_RANKER_SHADOW_DIFF_TOP_K'];
  });
  afterEach(() => {
    __resetRankerShadowDiffForTests();
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('SIDETRACK_RANKER_SHADOW_DIFF', priorEnabled);
    restore('SIDETRACK_RANKER_SHADOW_DIFF_WINDOW', priorWindow);
    restore('SIDETRACK_RANKER_SHADOW_DIFF_TOP_K', priorTopK);
  });

  it('returns null before any sample is recorded', () => {
    expect(peekRankerShadowDiff('vault')).toBeNull();
  });

  it('records mean divergence + request count + lastComputedAt', () => {
    // Sample 1: identical order → overlap 1, tau 1.
    recordRankerShadowDiff('vault', ['a', 'b', 'c'], ['a', 'b', 'c'], 1_000);
    // Sample 2: fully reversed → overlap over top-3 stays 1 (same set), tau -1.
    recordRankerShadowDiff('vault', ['a', 'b', 'c'], ['c', 'b', 'a'], 2_000);
    const snap = peekRankerShadowDiff('vault');
    expect(snap).not.toBeNull();
    expect(snap?.requests).toBe(2);
    expect(snap?.meanTopKOverlap).toBe(1); // both samples share the same set
    expect(snap?.meanKendallTau).toBe(0); // (1 + -1) / 2
    expect(snap?.lastComputedAt).toBe(new Date(2_000).toISOString());
  });

  it('keys windows per vault (multi-vault isolation)', () => {
    recordRankerShadowDiff('vault-a', ['a', 'b'], ['b', 'a'], 1_000);
    expect(peekRankerShadowDiff('vault-a')?.requests).toBe(1);
    expect(peekRankerShadowDiff('vault-b')).toBeNull();
  });

  it('bounds the rolling window (oldest samples drop)', () => {
    process.env['SIDETRACK_RANKER_SHADOW_DIFF_WINDOW'] = '3';
    for (let i = 0; i < 10; i += 1) {
      recordRankerShadowDiff('vault', ['a', 'b'], ['a', 'b'], i);
    }
    expect(peekRankerShadowDiff('vault')?.requests).toBe(3);
  });

  it('is a no-op when the kill switch is off', () => {
    process.env['SIDETRACK_RANKER_SHADOW_DIFF'] = '0';
    recordRankerShadowDiff('vault', ['a', 'b'], ['b', 'a'], 1_000);
    expect(peekRankerShadowDiff('vault')).toBeNull();
  });
});
