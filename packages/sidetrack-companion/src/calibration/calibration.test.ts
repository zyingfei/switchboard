import { describe, expect, it } from 'vitest';

import {
  applyPlatt,
  applyTemperature,
  fitPlatt,
  fitSurfaceCalibration,
  fitTemperature,
  reliabilityDiagram,
  sigmoid,
  type PredictionOutcome,
} from './calibration.js';

describe('sigmoid', () => {
  it('is 0.5 at 0 and monotone', () => {
    expect(sigmoid(0)).toBeCloseTo(0.5, 12);
    expect(sigmoid(10)).toBeGreaterThan(0.99);
    expect(sigmoid(-10)).toBeLessThan(0.01);
  });
});

describe('reliabilityDiagram — hand-computable ECE', () => {
  it('computes ECE from two fully-separated bins', () => {
    // Bin 0 (predicted ~0.2): 5 examples, 1 positive → observed 0.2.
    //   perfectly calibrated → |0.2 - 0.2| = 0.
    // Bin 8 (predicted ~0.85): 5 examples, 3 positive → observed 0.6.
    //   gap = |0.6 - 0.85| = 0.25.
    // ECE = (5/10)*0 + (5/10)*0.25 = 0.125.
    const outcomes: PredictionOutcome[] = [
      { predicted: 0.2, label: 1 },
      { predicted: 0.2, label: 0 },
      { predicted: 0.2, label: 0 },
      { predicted: 0.2, label: 0 },
      { predicted: 0.2, label: 0 },
      { predicted: 0.85, label: 1 },
      { predicted: 0.85, label: 1 },
      { predicted: 0.85, label: 1 },
      { predicted: 0.85, label: 0 },
      { predicted: 0.85, label: 0 },
    ];
    const diagram = reliabilityDiagram(outcomes, 10);
    expect(diagram.totalWeight).toBe(10);
    // Bin index for 0.2 is floor(0.2/0.1) = 2; for 0.85 is 8.
    const bin2 = diagram.bins[2];
    const bin8 = diagram.bins[8];
    expect(bin2?.count).toBe(5);
    expect(bin2?.meanPredicted).toBeCloseTo(0.2, 12);
    expect(bin2?.observedRate).toBeCloseTo(0.2, 12);
    expect(bin8?.count).toBe(5);
    expect(bin8?.meanPredicted).toBeCloseTo(0.85, 12);
    expect(bin8?.observedRate).toBeCloseTo(0.6, 12);
    expect(diagram.ece).toBeCloseTo(0.125, 12);
    // MCE is the single worst bin = 0.25.
    expect(diagram.mce).toBeCloseTo(0.25, 12);
  });

  it('reports ECE 0 for a perfectly-calibrated single bin', () => {
    // 10 examples all predicted 0.5, exactly 5 positive → observed 0.5.
    const outcomes: PredictionOutcome[] = [];
    for (let i = 0; i < 10; i += 1) {
      outcomes.push({ predicted: 0.5, label: i < 5 ? 1 : 0 });
    }
    const diagram = reliabilityDiagram(outcomes, 10);
    expect(diagram.ece).toBeCloseTo(0, 12);
    expect(diagram.mce).toBeCloseTo(0, 12);
  });

  it('applies inverse-propensity weights when computing rates', () => {
    // One negative with weight 3 and one positive with weight 1 in the
    // same bin → observed rate = 1/(1+3) = 0.25, not 0.5.
    const outcomes: PredictionOutcome[] = [
      { predicted: 0.5, label: 1, weight: 1 },
      { predicted: 0.5, label: 0, weight: 3 },
    ];
    const diagram = reliabilityDiagram(outcomes, 10);
    const bin5 = diagram.bins[5];
    expect(bin5?.count).toBe(4);
    expect(bin5?.observedRate).toBeCloseTo(0.25, 12);
    // ece = |0.25 - 0.5| = 0.25 (single occupied bin).
    expect(diagram.ece).toBeCloseTo(0.25, 12);
  });

  it('places predicted=1.0 in the final bin', () => {
    const diagram = reliabilityDiagram([{ predicted: 1, label: 1 }], 10);
    expect(diagram.bins[9]?.count).toBe(1);
  });

  it('returns all-zero for empty input', () => {
    const diagram = reliabilityDiagram([], 10);
    expect(diagram.ece).toBe(0);
    expect(diagram.mce).toBe(0);
    expect(diagram.totalWeight).toBe(0);
  });

  it('computes the Brier score', () => {
    // Two examples: predicted 0.9 label 1 (err 0.01), predicted 0.2
    // label 0 (err 0.04). Brier = mean = 0.025.
    const diagram = reliabilityDiagram(
      [
        { predicted: 0.9, label: 1 },
        { predicted: 0.2, label: 0 },
      ],
      10,
    );
    expect(diagram.brier).toBeCloseTo(0.025, 12);
  });
});

describe('fitPlatt', () => {
  it('returns the identity calibrator for empty input', () => {
    const cal = fitPlatt([]);
    expect(cal.a).toBe(1);
    expect(cal.b).toBe(0);
  });

  it('recovers a calibrator that separates positives from negatives', () => {
    // Positives at high scores, negatives at low scores → the fit should
    // map high scores toward 1 and low scores toward 0.
    const samples = [
      { score: 3, label: 1 as const },
      { score: 2.5, label: 1 as const },
      { score: 2, label: 1 as const },
      { score: -2, label: 0 as const },
      { score: -2.5, label: 0 as const },
      { score: -3, label: 0 as const },
    ];
    const cal = fitPlatt(samples, { maxIters: 2000, learningRate: 0.3, l2: 1e-4 });
    expect(applyPlatt(cal, 3)).toBeGreaterThan(0.7);
    expect(applyPlatt(cal, -3)).toBeLessThan(0.3);
    // Slope should stay positive (higher score → higher prob).
    expect(cal.a).toBeGreaterThan(0);
  });

  it('output is always within (0,1)', () => {
    const cal = fitPlatt([{ score: 100, label: 1 as const }], { l2: 1e-4 });
    const p = applyPlatt(cal, 1e6);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });
});

describe('fitTemperature', () => {
  it('returns T=1 for empty input', () => {
    expect(fitTemperature([]).temperature).toBe(1);
  });

  it('learns to SOFTEN over-confident logits (T > 1)', () => {
    // Large-magnitude logits but only 50% accuracy → the model is
    // over-confident; the best temperature softens toward 0.5, so T > 1.
    const samples = [
      { score: 5, label: 1 as const },
      { score: 5, label: 0 as const },
      { score: -5, label: 1 as const },
      { score: -5, label: 0 as const },
    ];
    const cal = fitTemperature(samples);
    expect(cal.temperature).toBeGreaterThan(1);
    // Softened prediction should be much closer to 0.5 than the raw.
    expect(applyTemperature(cal, 5)).toBeLessThan(sigmoid(5));
  });

  it('does not produce a NaN temperature for a degenerate gridSize', () => {
    // gridSize < 2 would divide by zero in the step; the fit clamps it.
    const samples = [
      { score: 2, label: 1 as const },
      { score: -2, label: 0 as const },
    ];
    const cal = fitTemperature(samples, { gridSize: 1 });
    expect(Number.isFinite(cal.temperature)).toBe(true);
    expect(cal.temperature).toBeGreaterThan(0);
  });

  it('is deterministic across repeated fits', () => {
    const samples = [
      { score: 2, label: 1 as const },
      { score: -2, label: 0 as const },
      { score: 1, label: 1 as const },
      { score: -1, label: 0 as const },
    ];
    expect(fitTemperature(samples).temperature).toBe(fitTemperature(samples).temperature);
  });
});

describe('fitSurfaceCalibration', () => {
  it('reports counts and all three reliability diagrams', () => {
    const samples = [
      { score: 3, label: 1 as const },
      { score: 2, label: 1 as const },
      { score: -2, label: 0 as const },
      { score: -3, label: 0 as const },
    ];
    const fit = fitSurfaceCalibration(samples, 10);
    expect(fit.sampleCount).toBe(4);
    expect(fit.positiveCount).toBe(2);
    expect(fit.platt.kind).toBe('platt');
    expect(fit.temperature.kind).toBe('temperature');
    expect(fit.rawReliability.totalWeight).toBe(4);
    expect(fit.plattReliability.totalWeight).toBe(4);
    expect(fit.temperatureReliability.totalWeight).toBe(4);
  });

  it('produces an empty-but-valid fit for no samples', () => {
    const fit = fitSurfaceCalibration([], 10);
    expect(fit.sampleCount).toBe(0);
    expect(fit.positiveCount).toBe(0);
    expect(fit.platt.a).toBe(1);
    expect(fit.temperature.temperature).toBe(1);
    expect(fit.rawReliability.ece).toBe(0);
  });
});
