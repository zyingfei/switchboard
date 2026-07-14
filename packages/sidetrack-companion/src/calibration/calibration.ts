// Per-surface probability calibration (north-star §5 S1, pattern P9).
//
// Decisions require CALIBRATED probabilities, per surface. At N=1 (tens of
// labels/week) isotonic staircases flip decisions on tiny bins, so we use
// parametric calibrators only: single-parameter TEMPERATURE scaling and
// two-parameter PLATT scaling. Both are shrinkage-friendly and monotone,
// so a handful of labels can't manufacture a non-monotone reliability
// curve. The reliability diagram (binned predicted-vs-observed rates +
// ECE) is the standing health artifact.
//
// PURE MODULE — no I/O, no clock, no globals. Fits and scores over plain
// arrays. FREEZE-SAFE: nothing here changes a serving decision; the
// collector reads it for the reliability artifact only.

/** A single (raw model score / logit, binary observed outcome) example. */
export interface CalibrationSample {
  /** The uncalibrated model output — a logit OR a raw score. For Platt we
   *  treat it as a feature `x` in `sigmoid(a*x + b)`; for temperature we
   *  treat it as a logit `z` in `sigmoid(z / T)`. */
  readonly score: number;
  /** Observed binary label: 1 = positive (clicked/engaged), 0 = negative. */
  readonly label: 0 | 1;
  /** Optional inverse-propensity weight (P12). Off-policy examples are
   *  weighted by 1/propensity so the calibrator is not biased by the
   *  logged position prior. Defaults to 1 (deterministic serving). */
  readonly weight?: number;
}

const clamp01 = (p: number): number => (p < EPS ? EPS : p > 1 - EPS ? 1 - EPS : p);
const EPS = 1e-6;

export const sigmoid = (x: number): number => {
  // Numerically stable logistic.
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
};

// ---------------------------------------------------------------------------
// Platt scaling: p = sigmoid(a * score + b), fit by weighted logistic
// regression (Newton / gradient descent on the two params). Robust default
// for arbitrary raw scores whose scale/offset is unknown.
// ---------------------------------------------------------------------------

export interface PlattCalibrator {
  readonly kind: 'platt';
  readonly a: number;
  readonly b: number;
}

export interface FitOptions {
  /** Max gradient-descent iterations. */
  readonly maxIters?: number;
  /** Learning rate. */
  readonly learningRate?: number;
  /** L2 shrinkage toward the identity/neutral calibrator — essential at
   *  N=1 so a few examples can't push `a` to an extreme slope. */
  readonly l2?: number;
  /** Convergence tolerance on the mean-abs gradient. */
  readonly tolerance?: number;
}

const DEFAULT_FIT: Required<FitOptions> = {
  maxIters: 500,
  learningRate: 0.1,
  l2: 1e-3,
  tolerance: 1e-6,
};

/**
 * Fit a Platt calibrator by weighted, L2-regularized logistic regression.
 * Shrinkage pulls `a` toward 1 and `b` toward 0 (the identity calibrator
 * on a logit-scale score), which is the honest N=1 prior: "assume the raw
 * score is already roughly calibrated until the labels say otherwise."
 * Returns the identity calibrator when there are no samples.
 */
export const fitPlatt = (
  samples: readonly CalibrationSample[],
  options: FitOptions = {},
): PlattCalibrator => {
  const opts = { ...DEFAULT_FIT, ...options };
  let a = 1;
  let b = 0;
  if (samples.length === 0) return { kind: 'platt', a, b };
  let totalWeight = 0;
  for (const s of samples) totalWeight += s.weight ?? 1;
  if (totalWeight <= 0) return { kind: 'platt', a, b };
  for (let iter = 0; iter < opts.maxIters; iter += 1) {
    let gradA = 0;
    let gradB = 0;
    for (const s of samples) {
      const w = s.weight ?? 1;
      const p = sigmoid(a * s.score + b);
      const err = p - s.label;
      gradA += w * err * s.score;
      gradB += w * err;
    }
    // Mean gradient + shrinkage toward (a=1, b=0).
    gradA = gradA / totalWeight + opts.l2 * (a - 1);
    gradB = gradB / totalWeight + opts.l2 * b;
    a -= opts.learningRate * gradA;
    b -= opts.learningRate * gradB;
    if (Math.abs(gradA) + Math.abs(gradB) < opts.tolerance) break;
  }
  return { kind: 'platt', a, b };
};

export const applyPlatt = (calibrator: PlattCalibrator, score: number): number =>
  clamp01(sigmoid(calibrator.a * score + calibrator.b));

// ---------------------------------------------------------------------------
// Temperature scaling: p = sigmoid(logit / T). Single parameter — the
// minimal-capacity calibrator, preferred when the raw score is already a
// logit and we only need to soften/sharpen it. Fit by 1-D search on the
// weighted log-loss over a bounded temperature grid (no gradient pathology
// at tiny N; monotone in T so a coarse-then-fine search is exact enough).
// ---------------------------------------------------------------------------

export interface TemperatureCalibrator {
  readonly kind: 'temperature';
  readonly temperature: number;
}

const weightedLogLoss = (samples: readonly CalibrationSample[], temperature: number): number => {
  let loss = 0;
  let totalWeight = 0;
  for (const s of samples) {
    const w = s.weight ?? 1;
    const p = clamp01(sigmoid(s.score / temperature));
    loss += w * -(s.label * Math.log(p) + (1 - s.label) * Math.log(1 - p));
    totalWeight += w;
  }
  return totalWeight > 0 ? loss / totalWeight : Number.POSITIVE_INFINITY;
};

export interface TemperatureFitOptions {
  /** Inclusive temperature search bounds. T>1 softens, T<1 sharpens. */
  readonly minTemperature?: number;
  readonly maxTemperature?: number;
  /** Number of grid points per refinement pass. */
  readonly gridSize?: number;
  /** Refinement passes (coarse → fine around the best point). */
  readonly refinements?: number;
}

const DEFAULT_TEMPERATURE_FIT: Required<TemperatureFitOptions> = {
  minTemperature: 0.25,
  maxTemperature: 5,
  gridSize: 40,
  refinements: 3,
};

/**
 * Fit a temperature calibrator by refined 1-D grid search on weighted
 * log-loss. Returns T=1 (identity) for empty input or when no grid point
 * beats it. The search is deterministic (no RNG) so the artifact is
 * reproducible across drains.
 */
export const fitTemperature = (
  samples: readonly CalibrationSample[],
  options: TemperatureFitOptions = {},
): TemperatureCalibrator => {
  const opts = { ...DEFAULT_TEMPERATURE_FIT, ...options };
  if (samples.length === 0) return { kind: 'temperature', temperature: 1 };
  // A grid needs ≥2 points or `step` divides by zero (→ Infinity → NaN
  // temperatures that silently defeat the search via NaN comparisons).
  // Clamp to a sane minimum rather than trusting the caller.
  const gridSize = Math.max(2, Math.floor(opts.gridSize));
  let lo = opts.minTemperature;
  let hi = opts.maxTemperature;
  let bestT = 1;
  let bestLoss = weightedLogLoss(samples, 1);
  for (let pass = 0; pass < opts.refinements; pass += 1) {
    const step = (hi - lo) / (gridSize - 1);
    for (let i = 0; i < gridSize; i += 1) {
      const t = lo + step * i;
      if (t <= 0) continue;
      const loss = weightedLogLoss(samples, t);
      if (loss < bestLoss) {
        bestLoss = loss;
        bestT = t;
      }
    }
    // Zoom in around the current best for the next pass.
    lo = Math.max(opts.minTemperature, bestT - step);
    hi = Math.min(opts.maxTemperature, bestT + step);
  }
  return { kind: 'temperature', temperature: bestT };
};

export const applyTemperature = (
  calibrator: TemperatureCalibrator,
  score: number,
): number => clamp01(sigmoid(score / calibrator.temperature));

export type Calibrator = PlattCalibrator | TemperatureCalibrator;

export const applyCalibrator = (calibrator: Calibrator, score: number): number =>
  calibrator.kind === 'platt'
    ? applyPlatt(calibrator, score)
    : applyTemperature(calibrator, score);

// ---------------------------------------------------------------------------
// Reliability diagram + ECE. Bin the CALIBRATED predictions into equal-
// width [0,1] bins; per bin report the (weighted) mean predicted prob, the
// (weighted) observed positive rate, and the (weighted) example count.
// ECE = Σ_bin (bin_weight / total_weight) * |observed − predicted|.
// ---------------------------------------------------------------------------

export interface ReliabilityBin {
  /** Inclusive lower / exclusive upper edge of the bin (last bin includes 1). */
  readonly lowerEdge: number;
  readonly upperEdge: number;
  /** Weighted example count that fell in this bin. */
  readonly count: number;
  /** Weighted mean predicted probability in this bin (NaN-safe: 0 if empty). */
  readonly meanPredicted: number;
  /** Weighted observed positive rate in this bin (0 if empty). */
  readonly observedRate: number;
}

export interface ReliabilityDiagram {
  readonly bins: readonly ReliabilityBin[];
  /** Expected Calibration Error over the bins. */
  readonly ece: number;
  /** Maximum Calibration Error — the single worst-calibrated bin. */
  readonly mce: number;
  /** Total weighted sample count behind the diagram. */
  readonly totalWeight: number;
  /** Weighted Brier score (mean squared error of the calibrated prob). */
  readonly brier: number;
}

export interface PredictionOutcome {
  /** Calibrated predicted probability in [0,1]. */
  readonly predicted: number;
  readonly label: 0 | 1;
  readonly weight?: number;
}

/**
 * Build a reliability diagram from calibrated (predicted, label) pairs.
 * `numBins` equal-width bins over [0,1]; predicted=1 lands in the last bin.
 * Empty input → all-zero bins, ece=0, mce=0.
 */
export const reliabilityDiagram = (
  outcomes: readonly PredictionOutcome[],
  numBins = 10,
): ReliabilityDiagram => {
  const bins = Math.max(1, Math.floor(numBins));
  const width = 1 / bins;
  const weightSum = new Array<number>(bins).fill(0);
  const predSum = new Array<number>(bins).fill(0);
  const labelSum = new Array<number>(bins).fill(0);
  let totalWeight = 0;
  let brierNumerator = 0;
  for (const o of outcomes) {
    const w = o.weight ?? 1;
    const p = o.predicted < 0 ? 0 : o.predicted > 1 ? 1 : o.predicted;
    let idx = Math.floor(p / width);
    if (idx >= bins) idx = bins - 1; // p === 1 → last bin.
    weightSum[idx] = (weightSum[idx] ?? 0) + w;
    predSum[idx] = (predSum[idx] ?? 0) + w * p;
    labelSum[idx] = (labelSum[idx] ?? 0) + w * o.label;
    totalWeight += w;
    brierNumerator += w * (p - o.label) * (p - o.label);
  }
  const outBins: ReliabilityBin[] = [];
  let ece = 0;
  let mce = 0;
  for (let i = 0; i < bins; i += 1) {
    const wSum = weightSum[i] ?? 0;
    const meanPredicted = wSum > 0 ? (predSum[i] ?? 0) / wSum : 0;
    const observedRate = wSum > 0 ? (labelSum[i] ?? 0) / wSum : 0;
    outBins.push({
      lowerEdge: i * width,
      upperEdge: i === bins - 1 ? 1 : (i + 1) * width,
      count: wSum,
      meanPredicted,
      observedRate,
    });
    if (wSum > 0 && totalWeight > 0) {
      const gap = Math.abs(observedRate - meanPredicted);
      ece += (wSum / totalWeight) * gap;
      if (gap > mce) mce = gap;
    }
  }
  return {
    bins: outBins,
    ece,
    mce,
    totalWeight,
    brier: totalWeight > 0 ? brierNumerator / totalWeight : 0,
  };
};

/**
 * End-to-end convenience: fit both calibrators on `samples`, then build a
 * reliability diagram for each plus the RAW (uncalibrated) scores mapped
 * through a sigmoid — so the artifact shows whether calibration actually
 * helped. Returns the fitted calibrators and their diagrams. Pure.
 */
export interface SurfaceCalibrationFit {
  readonly sampleCount: number;
  readonly positiveCount: number;
  readonly platt: PlattCalibrator;
  readonly temperature: TemperatureCalibrator;
  /** Reliability of the RAW score through a plain sigmoid (baseline). */
  readonly rawReliability: ReliabilityDiagram;
  /** Reliability after Platt scaling. */
  readonly plattReliability: ReliabilityDiagram;
  /** Reliability after temperature scaling. */
  readonly temperatureReliability: ReliabilityDiagram;
}

export const fitSurfaceCalibration = (
  samples: readonly CalibrationSample[],
  numBins = 10,
  platt: FitOptions = {},
  temperature: TemperatureFitOptions = {},
): SurfaceCalibrationFit => {
  const plattCal = fitPlatt(samples, platt);
  const tempCal = fitTemperature(samples, temperature);
  const toOutcome = (map: (s: number) => number): PredictionOutcome[] =>
    samples.map((s) => ({
      predicted: map(s.score),
      label: s.label,
      ...(s.weight === undefined ? {} : { weight: s.weight }),
    }));
  let positiveCount = 0;
  for (const s of samples) if (s.label === 1) positiveCount += s.weight ?? 1;
  return {
    sampleCount: samples.length,
    positiveCount,
    platt: plattCal,
    temperature: tempCal,
    rawReliability: reliabilityDiagram(toOutcome((x) => clamp01(sigmoid(x))), numBins),
    plattReliability: reliabilityDiagram(
      toOutcome((x) => applyPlatt(plattCal, x)),
      numBins,
    ),
    temperatureReliability: reliabilityDiagram(
      toOutcome((x) => applyTemperature(tempCal, x)),
      numBins,
    ),
  };
};
