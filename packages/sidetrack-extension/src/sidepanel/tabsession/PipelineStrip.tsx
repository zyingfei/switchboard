// Pipeline strip (feat/pipeline-strip) — a COMPACT, two-line visualization of
// the resolver's attribution pipeline, sized for the narrow side panel
// (~340px, degrading to ~300px via flex-wrap; no fixed widths, no horizontal
// scroll). It answers, at a glance: which signals fired, and what the fused
// decision did with them.
//
//   Line 1 — lane dots: six fixed-order chips (Graph · Similar · Topic · Title
//     · Domain · Recent), a FILLED dot when that lane produced ≥1 candidate, a
//     HOLLOW dot when it was empty/absent. The optional tail chips (Content,
//     then AI) are appended in that order, each ONLY when the payload actually
//     carries that lane (feat/content-lane, feat/ai-lane) — on an old companion
//     / a disabled lane it's simply absent, never a phantom hollow dot. The
//     whole row is a BUTTON that toggles the GuessLanes
//     disclosure it sits above (controls co-located with state — this repo's UI
//     taste rule). Each chip's title/aria carries the lane's top candidate
//     (filled) or emptyReason (hollow) for hover + screen readers.
//
//   Line 2 — verdict: one arrow line derived from decision.gate
//     (pipelineVerdictLine): "→ auto-filed" / "→ suggested" / "→ held: {why}",
//     with a fused-candidate-count fallback on old companions (no gate).
//
// Presentational only. It renders wherever GuessLanes renders (all lane states:
// populated, empty, compact, full), always ABOVE the disclosure it controls.

import {
  type GuessGate,
  type GuessLane,
  type GuessLaneResult,
  type TabSessionWorkstreamOption,
  pipelineVerdictLine,
} from './types';

// Fixed render order + short labels for the base six lanes. This is the frozen
// wire order (graph → recency); the strip ALWAYS renders these six in this
// order regardless of which the payload happens to include, so the dots row is
// a stable, scannable shape. The optional tail lanes are appended AFTER these
// six ONLY when the payload carries them — see OPTIONAL_LANE_ORDER + the
// render. Short labels (vs GuessLanes' longer LANE_LABEL) keep the row on one
// wrap-line in the narrow panel.
const BASE_LANE_ORDER: readonly GuessLane[] = [
  'graph',
  'similarity',
  'topic',
  'title',
  'domain',
  'recency',
];
// The optional TAIL lanes, in wire order after the base six: 'content' (lane 7,
// query-time retrieval) then 'ai' (lane 8, the same retrieval asked with the
// gist alone). Each is rendered only when the payload actually carries it, so
// an old companion / a disabled lane never gets a phantom hollow dot.
//
// WHY A LIST, not a hard-coded `has('content')` check: the previous shape
// appended exactly one optional chip and had no branch for 'ai', so a live
// 8-lane payload rendered seven dots and the AI lane was invisible on the strip
// even once the client parse kept it. A lane added to GuessLane that can arrive
// after 'recency' belongs in this array — that is the single place the strip's
// tail order is decided.
const OPTIONAL_LANE_ORDER: readonly GuessLane[] = ['content', 'ai'];
const LANE_SHORT_LABEL: Record<GuessLane, string> = {
  graph: 'Graph',
  similarity: 'Similar',
  topic: 'Topic',
  title: 'Title',
  domain: 'Domain',
  recency: 'Recent',
  content: 'Content',
  ai: 'AI',
};

const workstreamLabel = (
  workstreamId: string,
  workstreams: readonly TabSessionWorkstreamOption[],
): string => workstreams.find((w) => w.bac_id === workstreamId)?.path ?? '(removed)';

// The per-chip hover/aria description: filled → the lane's top candidate name;
// hollow → the lane's own emptyReason (or a plain "no signal" / "absent").
const chipDescription = (
  label: string,
  lane: GuessLaneResult | undefined,
  workstreams: readonly TabSessionWorkstreamOption[],
): string => {
  if (lane === undefined) return `${label}: absent`;
  const top = lane.candidates[0];
  if (top !== undefined) {
    return `${label}: ${workstreamLabel(top.workstreamId, workstreams)}`;
  }
  return `${label}: ${lane.emptyReason ?? 'no signal'}`;
};

export interface PipelineStripProps {
  readonly lanes: readonly GuessLaneResult[];
  readonly workstreams: readonly TabSessionWorkstreamOption[];
  // The parsed decision gate (may be absent on an old companion — the verdict
  // then falls back to the fused-candidate count).
  readonly gate?: GuessGate;
  // Number of FUSED candidates the resolver returned — only used for the
  // gate-absent verdict fallback (held below the bar vs nothing corroborated).
  readonly fusedCount: number;
  // The GuessLanes disclosure this strip controls: `open` is its current state
  // and `onToggle` flips it. The dots row is the toggle button (controls
  // co-located with state).
  readonly open: boolean;
  readonly onToggle: () => void;
}

export function PipelineStrip({
  lanes,
  workstreams,
  gate,
  fusedCount,
  open,
  onToggle,
}: PipelineStripProps) {
  // Index the payload's lanes by name so we can render the FIXED base six-lane
  // order even when the payload omits a lane (defensive — the wire contract
  // sends all six, but a lenient parse can drop a malformed one).
  const byLane = new Map<GuessLane, GuessLaneResult>();
  for (const lane of lanes) byLane.set(lane.lane, lane);
  // The optional tail chips (Content, then AI) are appended ONLY for lanes the
  // payload actually carries — an old companion / a disabled lane never gets a
  // phantom hollow dot, so the row is exactly six then, seven with content, and
  // eight once the AI lane rides along.
  const laneOrder: readonly GuessLane[] = [
    ...BASE_LANE_ORDER,
    ...OPTIONAL_LANE_ORDER.filter((laneName) => byLane.has(laneName)),
  ];
  const verdict = pipelineVerdictLine(gate, fusedCount);
  return (
    <div className="pipeline-strip">
      <button
        type="button"
        className="pipeline-strip-dots"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? 'Hide lane breakdown' : 'Show lane breakdown'}
        title={open ? 'Hide lane breakdown' : 'Show lane breakdown'}
      >
        {laneOrder.map((laneName) => {
          const lane = byLane.get(laneName);
          const label = LANE_SHORT_LABEL[laneName];
          const filled = lane !== undefined && lane.candidates.length > 0;
          const description = chipDescription(label, lane, workstreams);
          return (
            <span
              key={laneName}
              className={`pipeline-chip${filled ? ' is-filled' : ' is-empty'}`}
              title={description}
              aria-label={description}
            >
              <span className="pipeline-dot" aria-hidden="true">
                {filled ? '●' : '○'}
              </span>
              <span className="pipeline-chip-label">{label}</span>
            </span>
          );
        })}
      </button>
      <span className="pipeline-strip-verdict mono subtle">{verdict}</span>
    </div>
  );
}
