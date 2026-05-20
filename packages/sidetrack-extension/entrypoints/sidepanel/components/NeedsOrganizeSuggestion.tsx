// Per-row workstream suggestion for the workboard's Needs-Organize
// section. Backed by the companion's unified resolver compatibility
// route (tabsession-resolver-v1 — the SAME engine the Inbox /
// current-tab SuggestionStats uses). Renders inline below a thread
// row's existing label/provider line.
//
// Three visual modes, decided by the shared confidence module so this
// surface and the Inbox SuggestionStats speak the same vocabulary AND
// honour the same tie gate (no more raw "0.79" here, "Highly likely"
// there for the same row):
//  - actionable + margin OK (level ∈ {highly-likely, likely, possible,
//    unlikely}): "Looks like → <name> · <Level>" with Accept enabled.
//  - "No clear pick" (margin < TIED_MARGIN_THRESHOLD, regardless of
//    how high the leader's probability looks): the resolver is
//    admitting it can't separate top-1 from top-2; we drop Accept
//    and surface the manual picker so the user resolves the tie.
//  - "No auto" (confidence === 0): plain manual-picker affordance,
//    no fake recommendation.

import {
  confidenceLevelFromProbability,
  confidenceLevelLabel,
  isActionableLevel,
} from '../../../src/sidepanel/suggestion/confidence';

interface NeedsOrganizeSuggestionProps {
  readonly suggestedLabel: string;
  /** The leader's probability in [0, 1] — already sigmoided. The
   * thread-suggestion route returns this directly as `score`. */
  readonly confidence: number;
  /** Margin to the runner-up (0..1). When < TIED_MARGIN_THRESHOLD the
   * shared module bumps the level to "no clear pick" and Accept
   * disappears — same behaviour as the Inbox card for the same row.
   * Optional only for callers that haven't been updated yet; when
   * omitted, no tie gate is applied. */
  readonly margin?: number;
  // True while a background fetch is in flight so the refresh button
  // can show its spinning state without blocking the existing UI.
  readonly pending?: boolean;
  readonly onAccept: () => void;
  readonly onPickManual: () => void;
  // Optional explicit re-fetch handle. Lets the user force the
  // companion to recompute the suggestion (e.g. after renaming a
  // workstream the panel hasn't picked up yet, or to verify that a
  // dismissed suggestion no longer ranks high).
  readonly onRefresh?: () => void;
  readonly onDismiss: () => void;
}

export function NeedsOrganizeSuggestion({
  suggestedLabel,
  confidence,
  margin,
  pending = false,
  onAccept,
  onPickManual,
  onRefresh,
  onDismiss,
}: NeedsOrganizeSuggestionProps) {
  const hasNonZeroConfidence = confidence > 0;
  const level = confidenceLevelFromProbability(
    confidence,
    margin === undefined ? undefined : { margin },
  );
  const isTied = level === 'no-clear-pick';
  // Accept only when the resolver has a meaningful pick: non-zero
  // confidence AND not in a tie. Mirrors isActionableLevel and the
  // SuggestionStats "actionable" reading.
  const hasRecommendation = hasNonZeroConfidence && isActionableLevel(level);
  const leadText = isTied
    ? 'No clear pick — multiple matches:'
    : hasRecommendation
      ? 'Looks like →'
      : 'No auto-suggestion — pick a workstream:';
  return (
    <div
      className={`nx-suggest is-${level}`}
      role="group"
      aria-label="Workstream suggestion"
    >
      <span className="lead">{leadText}</span>
      {hasNonZeroConfidence ? (
        <span className="ws-sug">
          <span className={`hp-dot ${isTied ? 'amber' : 'green'}`} />
          <b>{suggestedLabel}</b>
          <span className="conf" title={`Probability ${confidence.toFixed(2)}`}>
            {confidenceLevelLabel(level)}
          </span>
        </span>
      ) : null}
      <div className="acts">
        {hasRecommendation ? (
          <button type="button" className="primary" onClick={onAccept}>
            Accept
          </button>
        ) : null}
        <button
          type="button"
          className={hasRecommendation ? '' : 'primary'}
          onClick={onPickManual}
        >
          Pick…
        </button>
        {onRefresh !== undefined ? (
          <button
            type="button"
            className="ghost"
            onClick={onRefresh}
            aria-label="Recompute suggestion"
            title={pending ? 'Refreshing…' : 'Recompute suggestion'}
            disabled={pending}
          >
            {pending ? '⟳' : '↻'}
          </button>
        ) : null}
        <button type="button" className="dismiss" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      </div>
    </div>
  );
}
