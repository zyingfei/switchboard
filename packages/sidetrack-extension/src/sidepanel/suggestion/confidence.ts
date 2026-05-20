// Shared confidence-presentation for suggestion surfaces.
//
// Both surfaces are backed by the SAME resolver (tabsession-resolver-v1):
//   - Inbox / current-tab card → SuggestionStats reads
//     TabSessionResolutionResult { rawFusionLogit, decision.margin }
//   - All-Threads "Needs organize" → NeedsOrganizeSuggestion reads the
//     thread-suggestion route which returns { score (already 0–1),
//     breakdown.margin }
//
// Before this module the two surfaces diverged in TWO layers:
//   (1) Display format: raw decimal ("Looks like → X 0.79") vs
//       bucketed label ("Highly likely"). Same number, two voices.
//   (2) Top-1 instability: when margin to the runner-up is tiny
//       (observed dogfood: 0.002, top-3 within ~0.0005), the model
//       has no clear winner — fetches at different graphRevisions
//       legitimately picked different "winners", and the UI invented
//       a confident-looking pick on a coin-flip. The label can be
//       unified all you want; the *decision* still diverges.
//
// This module folds both layers into one contract:
//   probabilityFromLogit → sigmoid on logit input
//   confidenceLevelFromProbability(p, { margin }) → bucket, with the
//     margin gate that promotes a "no clear pick" level when the gap
//     to the runner-up is below TIED_MARGIN_THRESHOLD. Honest about
//     ties instead of fabricating a winner.

export type ConfidenceLevel =
  | 'highly-likely'
  | 'likely'
  | 'possible'
  | 'unlikely'
  | 'not-likely'
  | 'no-clear-pick';

/** Below this margin we declare top-1 vs top-2 a tie and surface
 * "No clear pick" instead of inventing a winner. Observed dogfood
 * margin for ambiguous chats: ~0.002, with the top-3 within ~0.0005.
 * 0.05 (5pp) is comfortably above that noise floor while still
 * letting a real ~10pp+ lead read as a real preference. */
export const TIED_MARGIN_THRESHOLD = 0.05;

export const probabilityFromLogit = (logit: number): number => 1 / (1 + Math.exp(-logit));

export const confidenceLevelFromProbability = (
  probability: number,
  options?: { readonly margin?: number },
): ConfidenceLevel => {
  // Tie gate runs first: a near-equal top-1/top-2 is "no clear pick"
  // regardless of how confident the leader looks in isolation. The
  // model is admitting it can't separate them — the UI shouldn't.
  if (options?.margin !== undefined && options.margin < TIED_MARGIN_THRESHOLD) {
    return 'no-clear-pick';
  }
  if (probability >= 0.8) return 'highly-likely';
  if (probability >= 0.6) return 'likely';
  if (probability >= 0.4) return 'possible';
  if (probability >= 0.2) return 'unlikely';
  return 'not-likely';
};

export const confidenceLevelLabel = (level: ConfidenceLevel): string => {
  switch (level) {
    case 'highly-likely':
      return 'Highly likely';
    case 'likely':
      return 'Likely';
    case 'possible':
      return 'Possible';
    case 'unlikely':
      return 'Unlikely';
    case 'not-likely':
      return 'Not likely';
    case 'no-clear-pick':
      return 'No clear pick';
  }
};

/** True when the level reflects an honest "the model picked X with a
 * meaningful lead" — i.e., the UI is allowed to present an "Accept X"
 * affordance. False for no-clear-pick (ties) and not-likely (below
 * any threshold). */
export const isActionableLevel = (level: ConfidenceLevel): boolean =>
  level !== 'no-clear-pick' && level !== 'not-likely';
