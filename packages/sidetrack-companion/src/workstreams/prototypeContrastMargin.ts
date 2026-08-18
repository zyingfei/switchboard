// Contrast-margin scoring — prototype lane v2
// (docs/plans/2026-08-16-category-flexibility-hyde.md §11).
//
// THE BUG THIS FIXES (day-one, live-verified). Raw cosine similarity has no
// notion of "confident relative to the alternatives" — three unrelated
// workstreams can each render as a ~0.82 candidate purely because the
// prototype text register (meta-description prose) is generically close to
// every tech page. A candidate list sorted by raw score alone cannot tell
// the difference between "clearly the best match" and "tied with two other
// guesses" — it just shows the top score either way.
//
// THE FIX. Rank candidates by MARGIN over the page's own cross-workstream
// mean similarity (the page's typical/noise-floor similarity to an
// arbitrary workstream, estimated from the candidate pool itself — no
// separate calibration corpus needed). When the leading candidate's margin
// over that mean is below a small threshold, the lane reports an HONEST
// EMPTY ("no clearly closer workstream") instead of surfacing a near-tie as
// if it were a confident pick. A solitary candidate (nothing to contrast
// against) is never penalized by this check — margin-over-mean is only
// meaningful once there is a mean of MORE than one thing to be above.

export interface ContrastCandidate {
  readonly workstreamId: string;
  readonly score: number;
}

export interface ContrastMarginResult {
  readonly kept: readonly ContrastCandidate[];
  /** The winning margin (top score minus the cross-workstream mean),
   *  Infinity for a solitary candidate (no contrast to measure), always
   *  present even when `kept` ends up empty — the raw numbers stay
   *  available for the caller's why/diagnostic string per the "transparency"
   *  requirement, even in the honest-empty case. */
  readonly topScore: number;
  readonly crossWorkstreamMean: number;
  readonly margin: number;
}

/** A judgment call (unspecified numerically by the brief beyond "small"),
 *  flagged for golden-set tuning like every other unspecified numeric
 *  threshold in this feature area. Chosen conservative-but-not-paralyzing:
 *  small enough that a genuinely distinctive top pick (the common case once
 *  medoids/keyword-profile are in the blend) always clears it, large enough
 *  that the day-one three-way-tie-at-0.82 case (margin ~0) is caught. */
export const CONTRAST_MARGIN_MIN = 0.05;

const EMPTY_RESULT: ContrastMarginResult = {
  kept: [],
  topScore: 0,
  crossWorkstreamMean: 0,
  margin: 0,
};

/**
 * Apply the contrast-margin gate to an already-scored candidate list. Pure,
 * deterministic, no I/O. `candidates` need not be pre-sorted; the result's
 * `kept` list IS sorted descending by score (stable tie-break by
 * workstreamId ascending, matching prototypeLane.ts's existing sort).
 *
 * A single candidate always passes (margin reported as Infinity — nothing to
 * contrast against). Two or more candidates: margin = top score minus the
 * mean of EVERY candidate's score (the pool's own noise floor, including the
 * top score itself — a deliberately conservative denominator, since
 * excluding the top from its own baseline would inflate the apparent margin
 * of exactly the near-tie cases this gate exists to catch).
 */
export const applyContrastMargin = (
  candidates: readonly ContrastCandidate[],
  minMargin: number = CONTRAST_MARGIN_MIN,
): ContrastMarginResult => {
  if (candidates.length === 0) return EMPTY_RESULT;
  const sorted = [...candidates].sort((left, right) =>
    right.score !== left.score ? right.score - left.score : left.workstreamId < right.workstreamId ? -1 : 1,
  );
  const topScore = sorted[0]!.score;

  if (sorted.length === 1) {
    return { kept: sorted, topScore, crossWorkstreamMean: topScore, margin: Infinity };
  }

  const mean = sorted.reduce((sum, c) => sum + c.score, 0) / sorted.length;
  const margin = topScore - mean;
  if (margin < minMargin) {
    return { kept: [], topScore, crossWorkstreamMean: mean, margin };
  }
  return { kept: sorted, topScore, crossWorkstreamMean: mean, margin };
};

/** The honest-empty reason string, carrying the raw numbers for transparency
 *  (the brief's explicit requirement: "raw values still available in the why
 *  for transparency" even when the lane declines to name a winner). */
export const contrastMarginEmptyReason = (result: ContrastMarginResult): string =>
  `too close to call — best list scores ${result.topScore.toFixed(2)}, ` +
  `but a typical list scores ${result.crossWorkstreamMean.toFixed(2)} for this page ` +
  `(gap ${result.margin.toFixed(2)}, needs ${CONTRAST_MARGIN_MIN.toFixed(2)})`;
