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
import { GuessLanes } from '../../../src/sidepanel/tabsession/GuessLanes';
import type {
  GuessLaneResult,
  ResolveOutcomeError,
  TabSessionWorkstreamOption,
} from '../../../src/sidepanel/tabsession/types';

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
  // The last thread-suggestion fetch FAILED (transport error) or hung
  // past the pending deadline — NOT "the resolver abstained". Surfaced as
  // the SAME honest amber "busy — retrying" state the URL/current-tab card
  // uses, so a contended companion never reads as a confident "pick a
  // workstream…". The card's own retry loop owns recovery (clear-on-success,
  // late data wins); a populated `confidence` still supersedes this.
  readonly error?: ResolveOutcomeError;
  readonly onAccept: () => void;
  readonly onPickManual: () => void;
  // Guess-lanes (feat/guess-lanes) — the resolver's six per-lane guesses for
  // this thread, surfaced behind the shared GuessLanes disclosure in the
  // NO-SUGGESTION state so an abstaining fusion still shows what each lane
  // thought (parallel to the URL/tab SuggestionStats). Absent on older
  // companions; when omitted the card is unchanged. `laneWorkstreams` is the
  // id→name mapping GuessLanes needs; `onFileLane` files a lane candidate
  // through the EXISTING accept path (same handler as the primary Accept).
  readonly lanes?: readonly GuessLaneResult[];
  readonly laneWorkstreams?: readonly TabSessionWorkstreamOption[];
  readonly onFileLane?: (workstreamId: string) => void;
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
  error,
  onAccept,
  onPickManual,
  onRefresh,
  onDismiss,
  lanes,
  laneWorkstreams,
  onFileLane,
}: NeedsOrganizeSuggestionProps) {
  // Busy/error outranks the empty "pick a workstream" fallback but NOT a
  // populated suggestion: only surface the amber busy card when the fetch
  // failed/hung AND we have no confident pick to show (a late success still
  // supersedes it via `confidence > 0`). Mirrors suggestionStateFrom's
  // populated-wins precedence on the URL surface.
  if (error !== undefined && confidence <= 0) {
    return (
      <div className="nx-suggest is-busy" role="group" aria-label="Workstream suggestion">
        <span className="lead">Companion is busy — retrying</span>
        <span className="ws-sug">
          <span className="hp-dot amber" />
          <span
            className="conf"
            title={
              'Sidetrack couldn’t reach the resolver for this thread just now (the ' +
              'companion is busy catching up on a capture drain). This is NOT "no ' +
              'suggestion" — the check hasn’t completed. It retries automatically; ' +
              'no action needed.'
            }
          >
            Retrying automatically — the resolver is catching up
          </span>
        </span>
        <div className="acts">
          <button type="button" className="primary" onClick={onPickManual}>
            Pick…
          </button>
          {onRefresh !== undefined ? (
            <button
              type="button"
              className="ghost"
              onClick={onRefresh}
              aria-label="Recompute suggestion"
              title={pending ? 'Refreshing…' : 'Retry now'}
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
      {/* Guess-lanes — surface the resolver's per-lane guesses behind the
          shared disclosure ONLY when the fusion has no confident pick (the
          honesty case the feature is for). With a recommendation the lanes are
          redundant noise; without one, they show that "no auto-suggestion"
          doesn't mean every signal was silent. Absent on old companions →
          GuessLanes never mounts. */}
      {!hasRecommendation && lanes !== undefined && laneWorkstreams !== undefined ? (
        <GuessLanes
          lanes={lanes}
          workstreams={laneWorkstreams}
          {...(onFileLane === undefined ? {} : { onFileHere: onFileLane })}
        />
      ) : null}
    </div>
  );
}
