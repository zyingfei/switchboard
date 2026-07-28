// The lane-fallback pick, labelled for what it is.
//
// WHAT THE COMPANION NOW DOES (tabsession/laneFallback.ts). When fusion produced
// NOTHING at all — zero fused candidates, gate 'no-candidates' — but the
// query-time content + ai guess lanes DID name workstreams, the companion fills
// the served `fusedCandidates` with up to 3 synthesized picks so the card can
// show a best guess on partial data instead of a dash. The decision itself
// (action / workstreamId / margin) is returned untouched, so nothing about
// filing or auto-apply changes; only what the panel DISPLAYS.
//
// WHY THE PANEL MUST KNOW. Those candidates arrive in the same array a real
// fused candidate would, and the card's populated path is built for fusion
// output: it reads `rawFusionLogit` as a log-odds, runs it through the sigmoid,
// and prints a confidence word. For a synthesized candidate that number is NOT
// a fusion logit (it is the lane-native score in [0,1], carried in that field
// for ordering + auditability), so dressing it as calibrated confidence would
// be exactly the falsehood this feature exists to avoid. The panel detects
// these picks by their provenance and says the honest thing instead:
// UNCONFIRMED, from page content, no fusion behind it.
//
// The detection is a string prefix on the candidate's own reason summary — the
// companion writes it, this reads it, and neither may change without the other
// (see LANE_FALLBACK_WHY_PREFIX on both sides).

import type { TabSessionResolverCandidate } from './types';

/** The prefix the companion puts on a synthesized candidate's
 *  `reasons[0].summary` (companion tabsession/laneFallback.ts). Frozen: it is
 *  the wire contract for "this pick did not come from fusion". */
export const LANE_FALLBACK_WHY_PREFIX =
  'content-lane fallback — page-content evidence only, unconfirmed';

/**
 * True when this candidate was synthesized from the content/ai guess lanes
 * rather than produced by fusion. Lenient by construction: an older companion
 * (no fallback) and any candidate whose reasons are empty simply read false, so
 * the card keeps its existing behavior.
 */
export const isLaneFallbackCandidate = (
  candidate: TabSessionResolverCandidate | undefined,
): boolean =>
  candidate !== undefined &&
  candidate.reasons.some((reason) => reason.summary.startsWith(LANE_FALLBACK_WHY_PREFIX));

/** The headline chip for a lane-fallback pick. Deliberately leads with the
 *  uncertainty, not the workstream: the reader must not be able to skim this as
 *  a suggestion. "AI-assisted" is honest about the gist-driven 'ai' lane being
 *  one of the two retrievals behind it. */
export const LANE_FALLBACK_PICK_LABEL = 'Unconfirmed — from page content (AI-assisted)';

export const LANE_FALLBACK_PICK_TITLE =
  'Nothing reached the combined resolver for this page — no graph path, no similar-page edges, ' +
  'no topic, no title/domain/recency vote. This pick comes only from matching this page’s text ' +
  '(and its on-device gist) against pages you have already filed, so it is a best guess on ' +
  'partial evidence and nothing was filed. Expand the lanes below to see the evidence, or ' +
  'confirm/pick another to settle it.';
