import type { SuggestionCandidateSummary } from '../../companion/categoryFlexibilityClient';

export interface WorkstreamSuggestionCardProps {
  readonly candidate: SuggestionCandidateSummary;
  // True while accept/decline is in flight — dims the actions so a second
  // click can't double-fire the create+file batch.
  readonly pending?: boolean;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
}

const leadFor = (candidate: SuggestionCandidateSummary): string => {
  const hasName = candidate.suggestedName !== null && candidate.suggestedName.trim().length > 0;
  if (candidate.kind === 'split') {
    return `These ${String(candidate.memberCount)} pages look like their own group — split?`;
  }
  return hasName
    ? `These ${String(candidate.memberCount)} unfiled pages look like a topic: ${candidate.suggestedName ?? ''} — create it?`
    : `These ${String(candidate.memberCount)} unfiled pages look like a topic — create it?`;
};

// Inline split / new-topic suggestion — companion PR #376 (split/new-
// category candidate engine) surfaced HERE, where the affected pages
// already live: rendered inside the source workstream's own page list for
// `kind: 'split'`, and at the top of the Inbox for `kind: 'new-category'`
// (docs/plans/2026-08-16-category-flexibility-hyde.md, UI-visibility
// phase). One component renders BOTH kinds — the store's own
// `kind: 'split' | 'new-category'` discriminator is the only branch here.
// Accept/decline vocabulary is deliberately "Accept"/"Decline" (not the
// existing dismiss-icon "×" used elsewhere) — this is a create-a-new-
// workstream decision, not a per-row hint dismissal, so it gets an
// explicit verb pair.
export function WorkstreamSuggestionCard({
  candidate,
  pending = false,
  onAccept,
  onDecline,
}: WorkstreamSuggestionCardProps) {
  return (
    <div
      className={`nx-suggest workstream-suggestion is-${candidate.kind}`}
      role="group"
      aria-label={candidate.kind === 'split' ? 'Split suggestion' : 'New topic suggestion'}
    >
      <span className="lead">{leadFor(candidate)}</span>
      {candidate.kind === 'split' &&
      candidate.suggestedName !== null &&
      candidate.suggestedName.trim().length > 0 ? (
        <span className="ws-sug">
          <span className="hp-dot green" />
          <b>{candidate.suggestedName}</b>
        </span>
      ) : null}
      <div className="acts">
        <button type="button" className="primary" onClick={onAccept} disabled={pending}>
          {pending ? '…' : 'Accept'}
        </button>
        <button type="button" onClick={onDecline} disabled={pending}>
          Decline
        </button>
      </div>
    </div>
  );
}
