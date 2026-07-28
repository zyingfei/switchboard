// Guess-lanes (feat/guess-lanes) — the resolver's independent arms, each with
// its own ranked guess, surfaced behind a click-to-expand disclosure. Six on
// older companions (graph → recency); a 7th 'content' arm and an 8th 'ai' arm
// are appended on newer ones (feat/content-lane, feat/ai-lane) — the list
// renders in array order (see the `lanes.map` in GuessLanes) so the count and
// the order are data-driven, never hard-coded. That is why the disclosure needs
// no change per lane: the ONLY thing that can hide a lane here is the client
// parse dropping it (types.ts VALID_LANES) before it reaches this component.
//
// The fused decision is a weighted combination of these lanes; when it
// abstains (action='inbox' / no confident pick) the user used to see a bare
// "No signal yet". But an abstaining FUSION does not mean every lane was
// silent — the graph lane might have a weak edge, the topic lane a partial
// cluster, the recency lane a recent filing. This surface makes each lane
// account for itself so the honest story is "no confident pick, but here is
// what each signal thought", not a flat "nothing".
//
// Presentational only: it reuses the EXISTING onFileHere pick/move flow (the
// same handler the Possibilities list and the "Yes, that's right" action use)
// — no new backend. Renders inside SuggestionStats (Now/Inbox card) and the
// NeedsOrganizeSuggestion thread card, sharing one disclosure idiom.

import { GIST_LANE_MARKER, GIST_LANE_MARKER_TITLE, whyUsedGist } from './gistProvenance';
import type { GuessLaneResult, TabSessionWorkstreamOption } from './types';

// Human labels for the six lanes — the resolver's arm names are jargon
// ('graph', 'similarity', …); these are the plain words the user reads. Kept
// here (not in suggestionEndorsement) because they're specific to the lane
// breakdown surface. Order is the frozen wire order (graph → recency, then the
// optional 'content'), so a lanes array rendered in-order reads
// strongest-structural-signal first.
const LANE_LABEL: Record<GuessLaneResult['lane'], string> = {
  graph: 'Graph',
  similarity: 'Similar pages',
  topic: 'Topic',
  title: 'Title match',
  domain: 'Domain history',
  recency: 'Recently active',
  // 'content' (feat/content-lane) — the 7th arm, appended after recency; the
  // disclosure renders lanes in array order so it slots in automatically when
  // a newer companion sends it, and is simply never listed on older ones.
  content: 'Content match',
  // Lane 8 — the AI's own reading. Named for what it IS rather than how it is
  // computed, because the whole point of splitting it out from 'content' is
  // that a reader can see what the on-device model contributed.
  ai: 'AI gist match',
};

const workstreamLabel = (
  workstreamId: string,
  workstreams: readonly TabSessionWorkstreamOption[],
): string => workstreams.find((w) => w.bac_id === workstreamId)?.path ?? '(removed)';

// The lane score is lane-native (cosine / plurality share / recency decay) in
// [0, 1] — NOT the fusion logit — so we render it as a plain rounded percent,
// the same shape the SuggestionStats "Other candidates" row uses. We
// deliberately do NOT run it through confidenceLevelFromProbability: that
// calibration is fit for the fusion sigmoid, and dressing a raw lane score as
// "Highly likely" would falsify it.
const scorePercent = (score: number): string => `${String(Math.round(score * 100))}%`;

// Count of lanes that produced at least one candidate — the "N of 6 with
// signal" summary and the render's own "is there anything to show" check.
const lanesWithSignal = (lanes: readonly GuessLaneResult[]): number =>
  lanes.filter((lane) => lane.candidates.length > 0).length;

export interface GuessLanesProps {
  readonly lanes: readonly GuessLaneResult[];
  readonly workstreams: readonly TabSessionWorkstreamOption[];
  // The EXISTING pick/move flow (handleUrlAttribute on the Current Tab card).
  // When omitted the lane rows render read-only (no "File here" button), so
  // the surface degrades cleanly for callers that don't wire filing.
  readonly onFileHere?: (workstreamId: string) => void;
  // Pipeline-strip control (feat/pipeline-strip). When BOTH are provided the
  // disclosure becomes CONTROLLED — its open state is driven by the strip's
  // dots-row button (controls co-located with state) rather than the native
  // <details> toggle. When absent it stays uncontrolled (the original
  // click-the-summary behavior), so existing callers are unchanged.
  readonly open?: boolean;
  readonly onToggle?: (open: boolean) => void;
}

// One lane's row: label · (top candidate | empty reason). The additional
// candidates beyond the top are a small inline list with no extra chrome.
function LaneRow({
  lane,
  workstreams,
  onFileHere,
}: {
  readonly lane: GuessLaneResult;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
  readonly onFileHere?: (workstreamId: string) => void;
}) {
  const label = LANE_LABEL[lane.lane];
  const [top, ...rest] = lane.candidates;
  if (top === undefined) {
    // Empty lane — the lane accounts for itself with its own emptyReason so
    // the user sees all six lanes reported, not just the ones that fired.
    return (
      <li className="guess-lane is-empty">
        <span className="guess-lane-label subtle">{label}</span>
        <span className="guess-lane-empty mono subtle">
          {lane.emptyReason ?? 'no signal'}
        </span>
      </li>
    );
  }
  const topName = workstreamLabel(top.workstreamId, workstreams);
  return (
    <li className="guess-lane">
      <span className="guess-lane-head">
        <span className="guess-lane-label">{label}</span>
        <span className="guess-lane-name">{topName}</span>
        <span className="guess-lane-score mono subtle">· {scorePercent(top.score)}</span>
        {onFileHere !== undefined ? (
          <button
            type="button"
            className="btn-link guess-lane-file"
            onClick={() => {
              onFileHere(top.workstreamId);
            }}
            title={`File this page to ${topName}`}
          >
            File here
          </button>
        ) : null}
      </span>
      {/* The lane's raw `why`, verbatim — free text from the companion, never
          parsed for display. */}
      <span className="guess-lane-why subtle">{top.why}</span>
      {/* Provenance, guess → gist. The companion marks a content-lane `why`
          with ' · gist' when the resolved page's saved gist went into that
          lane's query text; that marker is jargon on its own, so the row says
          it in words and points at the gist shown on the same card. The claim
          stops at "used" — the ranking is not attributed to the gist. */}
      {lane.lane === 'content' && whyUsedGist(top.why) ? (
        <span
          className="guess-lane-gist mono subtle"
          title={GIST_LANE_MARKER_TITLE}
          data-testid="guess-lane-gist-marker"
        >
          {GIST_LANE_MARKER}
        </span>
      ) : null}
      {rest.length > 0 ? (
        <ul className="guess-lane-more">
          {rest.map((cand, index) => (
            <li
              key={`${cand.workstreamId}-${String(index)}`}
              className="guess-lane-more-row mono subtle"
            >
              {workstreamLabel(cand.workstreamId, workstreams)} · {scorePercent(cand.score)}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The lane breakdown disclosure. Renders nothing when `lanes` is empty (an
 * old companion passes no lanes; the caller shouldn't mount this then, but the
 * guard keeps it safe). Every lane in the payload is listed — empty lanes
 * included, and the optional 'content' lane when present — so the breakdown is
 * an honest full accounting. */
export function GuessLanes({
  lanes,
  workstreams,
  onFileHere,
  open,
  onToggle,
}: GuessLanesProps) {
  if (lanes.length === 0) return null;
  const withSignal = lanesWithSignal(lanes);
  // Controlled iff the strip wired both open + onToggle. In that mode we pin
  // the `open` attribute and mirror the native toggle event back up so a click
  // on the summary (not just the strip's dots button) still stays in sync.
  const controlled = open !== undefined && onToggle !== undefined;
  return (
    <details
      className="guess-lanes"
      {...(controlled ? { open } : {})}
      {...(onToggle !== undefined
        ? {
            onToggle: (event) => {
              onToggle((event.currentTarget as HTMLDetailsElement).open);
            },
          }
        : {})}
    >
      <summary className="guess-lanes-summary">
        Guess lanes · {String(withSignal)} of {String(lanes.length)} with signal
      </summary>
      <ul className="guess-lanes-list">
        {lanes.map((lane) => (
          <LaneRow
            key={lane.lane}
            lane={lane}
            workstreams={workstreams}
            {...(onFileHere === undefined ? {} : { onFileHere })}
          />
        ))}
      </ul>
    </details>
  );
}
