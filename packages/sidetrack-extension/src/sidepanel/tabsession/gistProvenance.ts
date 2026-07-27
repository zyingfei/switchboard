// The gist ↔ guess connection, said out loud in BOTH directions.
//
// THE BUG THIS FIXES (user report, 2026-07-27): "don't know how gist's output
// provides guess line output from UI." The companion already marks the content
// lane's `why` with ' · gist' when the resolved page's saved gist went into
// that lane's query text — but nothing on screen tied that marker back to the
// gist the user had just watched being generated two rows above.
//
// WHAT WE MAY HONESTLY CLAIM. The companion's contentLane.ts composes the
// lane's embed + FTS query as `gist + title + urlTokens` and sets the ' · gist'
// suffix exactly when the gist was part of that text. That supports ONE claim:
// the gist is part of the Content lane's query text. It does NOT support "the
// gist produced this ranking" — the lane also carries the title and URL tokens,
// the neighbour hits are not gist-derived at all, and the fused decision
// weighs six other lanes. So every line this module renders states the
// contribution and refuses the causal upgrade.

import type { GuessLaneResult, TabSessionWorkstreamOption } from './types';

/** The suffix the companion appends to a content-lane `why` (contentLane.ts). */
export const GIST_WHY_MARKER = '· gist';

/** Did this lane candidate's evidence include the resolved page's gist? */
export const whyUsedGist = (why: string): boolean => why.includes(GIST_WHY_MARKER);

/**
 * The one sentence that is actually true, reused verbatim in every direction so
 * the two surfaces cannot drift into two different stories.
 */
export const GIST_QUERY_FRAMING =
  "the gist is part of the Content lane's query text, not the ranking on its own";

/** The lane-row marker: the Content lane's side of the same connection. */
export const GIST_LANE_MARKER = 'used the gist you generated';
export const GIST_LANE_MARKER_TITLE =
  "This lane's query text included the gist generated for this page — see the on-device AI row " +
  'below the guess. The gist is one part of that query text, not the ranking on its own.';

export type GistInfluenceState =
  /** The content lane's `why` marks the gist, on ≥1 candidate. */
  | 'feeding'
  /** No content lane in this resolve (old companion, or the lane is off). */
  | 'lane-absent'
  /** The content lane ran and picked nothing. */
  | 'lane-empty'
  /** The content lane picked, and its evidence did not include the gist. */
  | 'lane-unused';

export interface GistInfluence {
  readonly state: GistInfluenceState;
  /** Workstream names whose content-lane candidate used the gist. */
  readonly workstreamNames: readonly string[];
}

const workstreamLabel = (
  workstreamId: string,
  workstreams: readonly TabSessionWorkstreamOption[],
): string => workstreams.find((w) => w.bac_id === workstreamId)?.path ?? '(removed)';

/**
 * Read the resolve's lanes and report, honestly, what the gist is doing. Pure —
 * it never asks the companion anything, it only reads the marker the companion
 * already sends.
 */
export const gistInfluenceFrom = (
  lanes: readonly GuessLaneResult[] | undefined,
  workstreams: readonly TabSessionWorkstreamOption[],
): GistInfluence => {
  const contentLane = lanes?.find((lane) => lane.lane === 'content');
  if (contentLane === undefined) return { state: 'lane-absent', workstreamNames: [] };
  if (contentLane.candidates.length === 0) return { state: 'lane-empty', workstreamNames: [] };
  const names = contentLane.candidates
    .filter((candidate) => whyUsedGist(candidate.why))
    .map((candidate) => workstreamLabel(candidate.workstreamId, workstreams));
  return names.length === 0
    ? { state: 'lane-unused', workstreamNames: [] }
    : { state: 'feeding', workstreamNames: names };
};

/**
 * The line rendered under the gist. Names the guess(es) the gist is feeding, or
 * says plainly that it is feeding none yet — and in every case ends with the
 * framing above, so the surface never implies the gist decided anything.
 */
export const gistProvenanceLine = (influence: GistInfluence): string => {
  switch (influence.state) {
    case 'feeding':
      return `Feeding the Content lane guess: ${influence.workstreamNames.join(', ')} — ${GIST_QUERY_FRAMING}.`;
    case 'lane-absent':
      return `Not influencing any guess yet — no Content lane in this resolve; ${GIST_QUERY_FRAMING}.`;
    case 'lane-empty':
      return `Not influencing any guess yet — the Content lane has no pick for this page; ${GIST_QUERY_FRAMING}.`;
    case 'lane-unused':
      return `Not influencing any guess yet — the Content lane's pick did not use it; ${GIST_QUERY_FRAMING}.`;
  }
};
