// Wave 0 — freeze-safe eval spine (report-only).
//
// Paired-bootstrap significance test between any two replay arms over the
// impression groups. The N=1 regime (a single user's vault) means a raw
// nDCG delta of "+0.02" is meaningless without an uncertainty estimate;
// the paired bootstrap resamples impressions WITH replacement and reports
// the distribution of the mean per-impression delta, so we can say whether
// an arm's win is inside the noise.
//
// REPORT-ONLY. This computes a verdict; it does NOT gate promotion. The
// shipGateV2 seam that would consume it is left as a followup (see
// SIGNIFICANCE_GATE_SEAM below) — wiring it into promotion is a later wave.

export interface PairedBootstrapInput {
  /** Per-impression metric for arm A, keyed by groupId (e.g. nDCG@10). */
  readonly armA: ReadonlyMap<string, number>;
  /** Per-impression metric for arm B, keyed by groupId. */
  readonly armB: ReadonlyMap<string, number>;
  /** Resample count. Default 10_000. */
  readonly iterations?: number;
  /** Deterministic seed so the verdict is reproducible + testable. */
  readonly seed?: number;
  /** Two-sided CI mass. Default 0.95. */
  readonly confidence?: number;
}

export interface PairedBootstrapResult {
  /** Number of impressions present in BOTH arms (the paired sample). */
  readonly pairedCount: number;
  /** Observed mean of (A − B) over the paired impressions. */
  readonly observedMeanDelta: number;
  /** Lower / upper bound of the bootstrap CI on the mean delta. */
  readonly ciLow: number;
  readonly ciHigh: number;
  /** Two-sided p-value for H0: mean delta == 0, via the bootstrap
   *  distribution's mass on the opposite side of 0 from the observation
   *  (doubled, clamped to [0,1]). */
  readonly pValue: number;
  /** Convenience verdict at the requested confidence: A is significantly
   *  better / worse / indistinguishable from B. */
  readonly verdict: 'a_better' | 'b_better' | 'indistinguishable';
  readonly confidence: number;
  readonly iterations: number;
  readonly seed: number;
}

/**
 * Deterministic PRNG (mulberry32). Seedable so a bootstrap verdict is
 * byte-reproducible across runs — essential for a persisted artifact the
 * freeze-lift decision leans on, and for hand-checkable tests.
 */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const percentileSorted = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
};

const DEFAULT_ITERATIONS = 10_000;

export const pairedBootstrap = (input: PairedBootstrapInput): PairedBootstrapResult => {
  const iterations = input.iterations ?? DEFAULT_ITERATIONS;
  const confidence = input.confidence ?? 0.95;
  const seed = input.seed ?? 0x5eed;

  // Pair on the shared group ids; ONLY impressions present in both arms
  // count (the delta is per-impression paired, not two independent means).
  const deltas: number[] = [];
  for (const [groupId, valueA] of input.armA) {
    const valueB = input.armB.get(groupId);
    if (valueB === undefined) continue;
    deltas.push(valueA - valueB);
  }
  const pairedCount = deltas.length;
  if (pairedCount === 0) {
    return {
      pairedCount: 0,
      observedMeanDelta: 0,
      ciLow: 0,
      ciHigh: 0,
      pValue: 1,
      verdict: 'indistinguishable',
      confidence,
      iterations,
      seed,
    };
  }

  const observedMeanDelta = deltas.reduce((sum, delta) => sum + delta, 0) / pairedCount;

  const rng = mulberry32(seed);
  const bootMeans: number[] = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let draw = 0; draw < pairedCount; draw += 1) {
      const index = Math.floor(rng() * pairedCount);
      sum += deltas[index]!;
    }
    bootMeans[iteration] = sum / pairedCount;
  }
  bootMeans.sort((left, right) => left - right);

  const alpha = (1 - confidence) / 2;
  const ciLow = percentileSorted(bootMeans, alpha);
  const ciHigh = percentileSorted(bootMeans, 1 - alpha);

  // Two-sided bootstrap p-value: the share of resampled means on the
  // opposite side of 0 from the observed mean, doubled + clamped.
  let onOppositeSide = 0;
  for (const mean of bootMeans) {
    if (observedMeanDelta >= 0 ? mean <= 0 : mean >= 0) onOppositeSide += 1;
  }
  const pValue = Math.min(1, (2 * onOppositeSide) / iterations);

  const verdict: PairedBootstrapResult['verdict'] =
    ciLow > 0 ? 'a_better' : ciHigh < 0 ? 'b_better' : 'indistinguishable';

  return {
    pairedCount,
    observedMeanDelta,
    ciLow,
    ciHigh,
    pValue,
    verdict,
    confidence,
    iterations,
    seed,
  };
};

/**
 * SEAM — the shipGateV2 promotion path does NOT consume this verdict yet.
 * When a later wave wires significance into promotion, the gate should
 * require `verdict === 'a_better'` (active arm A vs baseline arm B) at the
 * configured confidence BEFORE a model is allowed to replace the baseline,
 * in ADDITION to the existing point-estimate ship-gate. Kept as a named
 * constant so the wiring site is greppable and the intent is documented.
 */
export const SIGNIFICANCE_GATE_SEAM = {
  wired: false,
  requiredVerdictForPromotion: 'a_better' as const,
} as const;
