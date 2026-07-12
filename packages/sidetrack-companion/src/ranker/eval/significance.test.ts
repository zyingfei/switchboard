import { describe, expect, it } from 'vitest';

import { mulberry32, pairedBootstrap, SIGNIFICANCE_GATE_SEAM } from './significance.js';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('pairedBootstrap', () => {
  it('pairs only on shared group ids and computes the observed mean delta exactly', () => {
    // A = {g1: 1.0, g2: 0.5, g3: 0.0}, B = {g1: 0.5, g2: 0.5, g3: 0.5, g4: 9}.
    // Paired on g1..g3 (g4 dropped — not in A). Deltas = [0.5, 0.0, -0.5].
    // Observed mean = (0.5 + 0 - 0.5) / 3 = 0.
    const armA = new Map([
      ['g1', 1.0],
      ['g2', 0.5],
      ['g3', 0.0],
    ]);
    const armB = new Map([
      ['g1', 0.5],
      ['g2', 0.5],
      ['g3', 0.5],
      ['g4', 9],
    ]);
    const result = pairedBootstrap({ armA, armB, iterations: 2000, seed: 1 });
    expect(result.pairedCount).toBe(3);
    expect(result.observedMeanDelta).toBeCloseTo(0, 12);
    // Symmetric-around-zero deltas → CI straddles 0 → indistinguishable.
    expect(result.ciLow).toBeLessThan(0);
    expect(result.ciHigh).toBeGreaterThan(0);
    expect(result.verdict).toBe('indistinguishable');
  });

  it('returns a_better when A dominates B on every paired impression', () => {
    // Every delta strictly positive → every bootstrap resample mean > 0 →
    // ciLow > 0 → a_better, p == 0.
    const armA = new Map([
      ['g1', 0.9],
      ['g2', 0.8],
      ['g3', 0.95],
      ['g4', 0.7],
    ]);
    const armB = new Map([
      ['g1', 0.1],
      ['g2', 0.2],
      ['g3', 0.15],
      ['g4', 0.3],
    ]);
    const result = pairedBootstrap({ armA, armB, iterations: 2000, seed: 7 });
    expect(result.observedMeanDelta).toBeCloseTo((0.8 + 0.6 + 0.8 + 0.4) / 4, 12);
    expect(result.ciLow).toBeGreaterThan(0);
    expect(result.verdict).toBe('a_better');
    expect(result.pValue).toBe(0);
  });

  it('returns b_better when B dominates A on every paired impression', () => {
    const armA = new Map([
      ['g1', 0.1],
      ['g2', 0.2],
      ['g3', 0.0],
    ]);
    const armB = new Map([
      ['g1', 0.9],
      ['g2', 0.8],
      ['g3', 1.0],
    ]);
    const result = pairedBootstrap({ armA, armB, iterations: 2000, seed: 3 });
    expect(result.observedMeanDelta).toBeLessThan(0);
    expect(result.ciHigh).toBeLessThan(0);
    expect(result.verdict).toBe('b_better');
    expect(result.pValue).toBe(0);
  });

  it('is byte-reproducible for a fixed seed', () => {
    const armA = new Map([
      ['g1', 0.6],
      ['g2', 0.4],
      ['g3', 0.55],
    ]);
    const armB = new Map([
      ['g1', 0.5],
      ['g2', 0.5],
      ['g3', 0.4],
    ]);
    const first = pairedBootstrap({ armA, armB, iterations: 1000, seed: 99 });
    const second = pairedBootstrap({ armA, armB, iterations: 1000, seed: 99 });
    expect(first).toEqual(second);
  });

  it('returns an indistinguishable no-op verdict when the arms share no impressions', () => {
    const result = pairedBootstrap({
      armA: new Map([['g1', 1]]),
      armB: new Map([['g2', 1]]),
    });
    expect(result.pairedCount).toBe(0);
    expect(result.verdict).toBe('indistinguishable');
    expect(result.pValue).toBe(1);
  });
});

describe('SIGNIFICANCE_GATE_SEAM', () => {
  it('is documented as NOT wired into promotion (report-only wave)', () => {
    expect(SIGNIFICANCE_GATE_SEAM.wired).toBe(false);
    expect(SIGNIFICANCE_GATE_SEAM.requiredVerdictForPromotion).toBe('a_better');
  });
});
