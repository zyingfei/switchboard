import { describe, expect, it } from 'vitest';

import { Adwin } from './adwin.js';

// Deterministic LCG so "synthetic stationary stream" is reproducible
// across runs and machines (no Math.random in tests).
const lcg = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const gaussian = (rand: () => number): number => {
  // Box–Muller; rand in (0, 1).
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

describe('Adwin', () => {
  it('rejects an out-of-range delta', () => {
    expect(() => new Adwin({ delta: 0 })).toThrow(RangeError);
    expect(() => new Adwin({ delta: 1 })).toThrow(RangeError);
    expect(() => new Adwin({ delta: Number.NaN })).toThrow(RangeError);
  });

  it('does NOT flag drift on a stationary stream (no false positives)', () => {
    const adwin = new Adwin();
    const rand = lcg(42);
    let drifts = 0;
    for (let i = 0; i < 2000; i += 1) {
      // Stationary: mean 0.5, small noise.
      const value = 0.5 + 0.02 * gaussian(rand);
      if (adwin.update(value).drift) drifts += 1;
    }
    expect(drifts).toBe(0);
    // Window keeps growing on a stationary stream.
    expect(adwin.windowWidth).toBeGreaterThan(500);
    expect(adwin.mean).toBeGreaterThan(0.4);
    expect(adwin.mean).toBeLessThan(0.6);
  });

  it('detects an abrupt mean shift and collapses the window', () => {
    const adwin = new Adwin();
    const rand = lcg(7);
    for (let i = 0; i < 600; i += 1) {
      adwin.update(0.2 + 0.01 * gaussian(rand));
    }
    const widthBeforeShift = adwin.windowWidth;
    expect(widthBeforeShift).toBeGreaterThan(200);
    let detectedWithin = -1;
    let widthAtDetection = -1;
    for (let i = 0; i < 600; i += 1) {
      // Large abrupt jump from 0.2 to 0.8.
      const result = adwin.update(0.8 + 0.01 * gaussian(rand));
      if (result.drift && detectedWithin === -1) {
        detectedWithin = i;
        widthAtDetection = adwin.windowWidth;
      }
    }
    expect(detectedWithin).toBeGreaterThanOrEqual(0);
    // Reacts fast to a big shift.
    expect(detectedWithin).toBeLessThan(120);
    // Window shrank at detection: ADWIN2's exponential-histogram drop
    // removes the oldest (large) bucket of stale low-mean history, so
    // the window is meaningfully smaller than before the shift even
    // though a single drop need not evict *all* stale data at once.
    expect(widthAtDetection).toBeLessThan(widthBeforeShift);
    // The retained window's mean has moved decisively toward the new
    // regime (0.8) and well away from the old one (0.2).
    expect(adwin.mean).toBeGreaterThan(0.6);
  });

  it('detects a gradual drift', () => {
    const adwin = new Adwin();
    const rand = lcg(99);
    let detected = false;
    for (let i = 0; i < 1500; i += 1) {
      // Slow ramp from 0 to ~1.5 across the stream.
      const trend = i * 0.001;
      if (adwin.update(trend + 0.01 * gaussian(rand)).drift) detected = true;
    }
    expect(detected).toBe(true);
  });

  it('ignores non-finite inputs without changing the window', () => {
    const adwin = new Adwin();
    adwin.update(1);
    adwin.update(1);
    const widthBefore = adwin.windowWidth;
    const meanBefore = adwin.mean;
    expect(adwin.update(Number.NaN)).toEqual({ drift: false, warning: false });
    expect(adwin.update(Number.POSITIVE_INFINITY)).toEqual({ drift: false, warning: false });
    expect(adwin.windowWidth).toBe(widthBefore);
    expect(adwin.mean).toBe(meanBefore);
  });

  it('round-trips state and resumes detection identically', () => {
    const a = new Adwin();
    const rand = lcg(123);
    for (let i = 0; i < 400; i += 1) a.update(0.3 + 0.01 * gaussian(rand));

    const restored = Adwin.fromState(JSON.parse(JSON.stringify(a.toState())));
    expect(restored.windowWidth).toBe(a.windowWidth);
    expect(restored.mean).toBeCloseTo(a.mean, 10);

    // Drive both with the SAME continuation; results must match.
    const contA = lcg(555);
    const contB = lcg(555);
    for (let i = 0; i < 300; i += 1) {
      const stepA = a.update(0.9 + 0.01 * gaussian(contA));
      const stepB = restored.update(0.9 + 0.01 * gaussian(contB));
      expect(stepB.drift).toBe(stepA.drift);
    }
    expect(restored.mean).toBeCloseTo(a.mean, 10);
  });

  it('falls back to a fresh detector on a corrupt persisted blob', () => {
    expect(Adwin.fromState(null).windowWidth).toBe(0);
    expect(Adwin.fromState({ delta: 5 }).windowWidth).toBe(0);
    expect(Adwin.fromState({ delta: 0.01, rows: 'nope' }).windowWidth).toBe(0);
    const fresh = Adwin.fromState({
      delta: 0.01,
      rows: [{ buckets: [{ sum: 'x', variance: 1 }] }],
      width: 1,
      total: 1,
      variance: 0,
    });
    expect(fresh.windowWidth).toBe(0);
  });
});
