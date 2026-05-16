import { describe, expect, it } from 'vitest';

import { Kswin } from './kswin.js';

const lcg = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const gaussian = (rand: () => number): number => {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

describe('Kswin', () => {
  it('validates constructor options', () => {
    expect(() => new Kswin({ alpha: 0 })).toThrow(RangeError);
    expect(() => new Kswin({ alpha: 1 })).toThrow(RangeError);
    expect(() => new Kswin({ windowSize: 0 })).toThrow(RangeError);
    expect(() => new Kswin({ windowSize: 10, statSize: 6 })).toThrow(RangeError);
    expect(() => new Kswin({ warningFactor: 1 })).toThrow(RangeError);
  });

  it('emits nothing until the window is full', () => {
    const kswin = new Kswin({ windowSize: 40, statSize: 10 });
    for (let i = 0; i < 39; i += 1) {
      expect(kswin.update(0.5)).toEqual({ drift: false, warning: false });
    }
    expect(kswin.windowWidth).toBe(39);
  });

  it('does NOT flag drift on a stationary stream (no false positives)', () => {
    const kswin = new Kswin({ alpha: 0.005, windowSize: 100, statSize: 30 });
    const rand = lcg(2024);
    let drifts = 0;
    for (let i = 0; i < 3000; i += 1) {
      if (kswin.update(0.5 + 0.05 * gaussian(rand)).drift) drifts += 1;
    }
    // alpha=0.005 → at most a handful of false alarms over 3000 steps.
    expect(drifts).toBeLessThanOrEqual(3);
  });

  it('detects an abrupt distribution change', () => {
    const kswin = new Kswin({ alpha: 0.005, windowSize: 100, statSize: 30 });
    const rand = lcg(11);
    for (let i = 0; i < 400; i += 1) kswin.update(0.1 + 0.02 * gaussian(rand));
    let detectedWithin = -1;
    for (let i = 0; i < 200; i += 1) {
      if (kswin.update(0.9 + 0.02 * gaussian(rand)).drift && detectedWithin === -1) {
        detectedWithin = i;
      }
    }
    expect(detectedWithin).toBeGreaterThanOrEqual(0);
    // Should detect within roughly one statSize of the new regime
    // entering the recent window.
    expect(detectedWithin).toBeLessThan(60);
  });

  it('detects a gradual distribution drift', () => {
    const kswin = new Kswin({ alpha: 0.005, windowSize: 80, statSize: 20 });
    const rand = lcg(303);
    let detected = false;
    for (let i = 0; i < 2000; i += 1) {
      const trend = i * 0.0015;
      if (kswin.update(trend + 0.02 * gaussian(rand)).drift) detected = true;
    }
    expect(detected).toBe(true);
  });

  it('raises a warning before a confirmed drift on a moderate shift', () => {
    const kswin = new Kswin({
      alpha: 0.01,
      windowSize: 80,
      statSize: 20,
      warningFactor: 0.6,
    });
    const rand = lcg(77);
    for (let i = 0; i < 300; i += 1) kswin.update(0.4 + 0.03 * gaussian(rand));
    let sawWarning = false;
    let sawDrift = false;
    for (let i = 0; i < 200; i += 1) {
      const r = kswin.update(0.62 + 0.03 * gaussian(rand));
      if (r.warning && !sawDrift) sawWarning = true;
      if (r.drift) sawDrift = true;
    }
    expect(sawWarning).toBe(true);
  });

  it('ignores non-finite inputs', () => {
    const kswin = new Kswin({ windowSize: 20, statSize: 5 });
    expect(kswin.update(Number.NaN)).toEqual({ drift: false, warning: false });
    expect(kswin.update(Number.POSITIVE_INFINITY)).toEqual({ drift: false, warning: false });
    expect(kswin.windowWidth).toBe(0);
  });

  it('round-trips state deterministically', () => {
    const k = new Kswin({ alpha: 0.005, windowSize: 60, statSize: 15 });
    const rand = lcg(909);
    for (let i = 0; i < 200; i += 1) k.update(0.5 + 0.03 * gaussian(rand));
    const restored = Kswin.fromState(JSON.parse(JSON.stringify(k.toState())));
    expect(restored.windowWidth).toBe(k.windowWidth);

    const ca = lcg(4242);
    const cb = lcg(4242);
    for (let i = 0; i < 200; i += 1) {
      const a = k.update(0.5 + 0.03 * gaussian(ca));
      const b = restored.update(0.5 + 0.03 * gaussian(cb));
      expect(b).toEqual(a);
    }
  });

  it('falls back to a fresh detector on a corrupt blob', () => {
    expect(Kswin.fromState(null).windowWidth).toBe(0);
    expect(Kswin.fromState({ alpha: 0.005 }).windowWidth).toBe(0);
    expect(
      Kswin.fromState({
        alpha: 0.005,
        windowSize: 10,
        statSize: 9,
        warningFactor: 0.8,
        window: [],
      }).windowWidth,
    ).toBe(0);
  });
});
