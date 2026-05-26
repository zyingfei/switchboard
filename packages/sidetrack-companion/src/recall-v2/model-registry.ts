// Recall v2 — per-embedder retrieval-tuning registry.
//
// All semantic-stream gating constants live here, keyed by model ID.
// They are model properties (a function of the embedder's cosine
// distribution on this corpus), NOT pipeline constants — swapping
// embedders shifts the cosine space radically and would silently
// break any thresholds hardcoded in retrieval logic.
//
// To add a new model:
//   1. Land the embedder change behind a flag.
//   2. Run the cosine-distribution probe (scripts/recall-v2-cosine-probe.ts
//      — covers 8 queries spanning navigational + informational
//      intents at top-50).
//   3. Compute noise-floor and full-signal gap thresholds from the
//      observed distribution.
//   4. Add the entry below with `calibratedAt: <ISO date>`.
//   5. Flip the flag to default-on.
//
// Without an entry, `profileFor` returns a safe default that disables
// the gap-gate (semantic contribution always full strength) AND logs a
// console.warn so the operator notices. Better to over-trust semantic
// on an unknown model than to silently break it.
//
// See docs/recall-v2-hybrid-rerank-design.md §D7.

export interface RetrievalModelProfile {
  readonly modelId: string;
  readonly embeddingDim: number;

  /** Cosine-gap threshold at which the semantic stream contributes
   *  ZERO to fusion. Measured: `top - p50` of the candidate cosine
   *  distribution for a query is below this → the stream is flat
   *  noise, every candidate is at the model's intrinsic noise floor.
   *  e5-small on this corpus: 0.03 (measured 2026-05-26 across 8
   *  queries; pure-noise queries like "Bayesian" had gap=0.009,
   *  noise-tail queries like "Mullvad exit IPs" had gap=0.028; first
   *  query with meaningful signal at the top was 0.041). */
  readonly semGapNoiseFloor: number;

  /** Cosine-gap threshold at which the semantic stream contributes
   *  at FULL strength. Gap above this → real signal at the top,
   *  trust the stream verbatim. e5-small: 0.07 (measured: "BGP
   *  convergence" gap=0.075 had clearly-relevant top hit; below
   *  ~0.06 had marginal signal). */
  readonly semGapFullSignal: number;

  /** Absolute cosine threshold above which ALL candidates are
   *  considered real signal regardless of the gap. The gap statistic
   *  only meaningfully separates signal-from-noise when the
   *  distribution has BOTH signal and noise — i.e. when at least
   *  some candidates sit at the noise floor. When every filtered
   *  candidate is already above this threshold, the entire stream is
   *  signal, no noise tail exists, and the gate must pass through
   *  unconditionally even with a tight cosine cluster (which is
   *  exactly what test fixtures with axis-aligned synthetic vectors
   *  produce — cosines all > 0.98 with gap < 0.01).
   *
   *  For e5-small: 0.6 (well above the empirical noise floor of
   *  ~0.38; a corpus item with cosine 0.6+ is unambiguously
   *  semantically related, not noise). */
  readonly semAbsoluteSignalFloor: number;

  /** ISO date the thresholds were calibrated. Re-calibrate when the
   *  underlying corpus changes shape materially (10x doc count,
   *  major new content category). */
  readonly calibratedAt: string;
}

const KNOWN_MODELS: Record<string, RetrievalModelProfile> = {
  // Production embedder. Calibrated 2026-05-26 from a measurement
  // pass over 8 queries × top-50 candidates on the dogfood vault
  // (~1300 timeline-visit / ~60 page-content / ~7800 chat-turn /
  // 1275 vectors).
  'Xenova/multilingual-e5-small': {
    modelId: 'Xenova/multilingual-e5-small',
    embeddingDim: 384,
    semGapNoiseFloor: 0.03,
    semGapFullSignal: 0.07,
    semAbsoluteSignalFloor: 0.6,
    calibratedAt: '2026-05-26',
  },
};

/** Strip the model-revision suffix that the embedder appends to the
 *  model ID (`#rev=...#prefix-query-v1`). The revision-pinning is
 *  important for cache invalidation but the retrieval profile is a
 *  property of the model architecture, not the revision. */
const stripRevisionSuffix = (modelId: string): string => {
  const hash = modelId.indexOf('#');
  return hash === -1 ? modelId : modelId.slice(0, hash);
};

let warnedForUnknown = new Set<string>();

export const profileFor = (modelId: string | undefined): RetrievalModelProfile => {
  const baseId = modelId === undefined ? 'unknown' : stripRevisionSuffix(modelId);
  const exact = KNOWN_MODELS[baseId];
  if (exact !== undefined) return exact;
  // Unknown model — safe default disables the gap-gate (multiplier
  // always = 1, semantic always contributes at full strength). Log
  // the warn once per process per modelId so the operator notices
  // without flooding logs.
  if (!warnedForUnknown.has(baseId)) {
    warnedForUnknown.add(baseId);
    // eslint-disable-next-line no-console
    console.warn(
      `[recall-v2] unknown embedder ${baseId} — using safe defaults ` +
        `(semantic gap-gate disabled). Add an entry to ` +
        `packages/sidetrack-companion/src/recall-v2/model-registry.ts ` +
        `after running scripts/recall-v2-cosine-probe.ts to calibrate.`,
    );
  }
  return {
    modelId: baseId,
    embeddingDim: 384,
    semGapNoiseFloor: 0,
    semGapFullSignal: 0.0001,
    semAbsoluteSignalFloor: 0, // pass-through
    calibratedAt: 'default-unsafe',
  };
};

/** Below this candidate count, the distribution isn't statistically
 *  meaningful — `top - p50` becomes either 0 (when n ≤ 2) or
 *  hyper-noisy. Pass the stream through ungated for small pools.
 *  In production this rarely matters (corpus has 1000+ vectors so
 *  semantic_query routinely returns 20+ hits); in eval fixtures with
 *  6-12 docs total it's the difference between the gate working and
 *  the gate silently zeroing every semantic hit. */
const SMALL_POOL_THRESHOLD = 5;

/** Smooth ramp from gap-noise-floor (multiplier=0) to gap-full-signal
 *  (multiplier=1). Linear interp; sigmoid would be nicer but a linear
 *  ramp is easier to reason about and re-calibrate.
 *
 *  Three short-circuits ahead of the ramp:
 *  1. `candidateCount < SMALL_POOL_THRESHOLD`: pass through. Small
 *     pools have no useful distribution statistic.
 *  2. `minCosine >= semAbsoluteSignalFloor`: pass through. The entire
 *     distribution is above the model's noise floor, so there's no
 *     noise tail to suppress — the tight cluster IS the signal. This
 *     handles axis-aligned fixture vectors (cosines clustered at
 *     0.98-1.00) and any production query where the corpus has a
 *     coherent topic match.
 *  3. `range <= 0`: safe-default unknown-model profile. Always pass.
 *
 *  Otherwise: gap-based linear ramp.
 *
 *  This is "score-modulated RRF" — the principled way to encode
 *  per-stream confidence without hardcoding source weights. */
export const semanticContributionMultiplier = (
  profile: RetrievalModelProfile,
  topCosine: number,
  p50Cosine: number,
  minCosine: number,
  candidateCount: number,
): number => {
  if (candidateCount < SMALL_POOL_THRESHOLD) return 1;
  if (minCosine >= profile.semAbsoluteSignalFloor) return 1;
  const gap = topCosine - p50Cosine;
  const range = profile.semGapFullSignal - profile.semGapNoiseFloor;
  if (range <= 0) return 1;
  const normalized = (gap - profile.semGapNoiseFloor) / range;
  if (normalized <= 0) return 0;
  if (normalized >= 1) return 1;
  return normalized;
};

// Test seam — reset the once-only warn cache so unit tests can
// observe the warn behavior fresh per test.
export const __resetUnknownModelWarnCache = (): void => {
  warnedForUnknown = new Set();
};
