export interface InboundReminder {
  readonly bac_id: string;
  readonly threadTitle: string;
  readonly provider: string;
  readonly providerLabel: string;
  readonly inboundTurnAt: string; // relative
  readonly status: 'unseen' | 'seen' | 'dismissed';
  readonly aiAuthored?: boolean;
}

export interface InboundCardProps {
  readonly reminder: InboundReminder;
  readonly masked?: boolean;
  readonly onOpen: () => void;
  readonly onMarkRelevant: () => void;
  readonly onDismiss: () => void;
}

// Inbound reply row — rebuilt on the token system (R1.1). Clear anatomy:
//   Row 1  · unread dot (static; unseen only) + provider chip + title + age
//   Row 2  · one aligned action row (Open / Helpful / Dismiss)
// Unseen replies are accented (a left rail + a static unread dot) because
// an unread AI reply is the highest-value actionable-now signal; seen
// replies fall back to a quiet paper card. No muddy amber wash, no
// infinite pulse — the idle panel does not paint (CPU-runaway history).
export function InboundCard({
  reminder,
  masked = false,
  onOpen,
  onMarkRelevant,
  onDismiss,
}: InboundCardProps) {
  const title = masked ? '[private — workstream item]' : reminder.threadTitle;
  const unread = reminder.status === 'unseen';
  return (
    <div className={'inbound-card status-' + reminder.status}>
      <div className="inbound-row1">
        {unread ? <span className="inbound-unread-dot" aria-hidden /> : null}
        <span className={'chip chip-' + reminder.provider}>{reminder.providerLabel}</span>
        <span
          className={
            'inbound-title' +
            (reminder.aiAuthored && !masked ? ' ai-italic' : '') +
            (masked ? ' masked' : '')
          }
        >
          {title}
        </span>
        <span className="inbound-age mono">{reminder.inboundTurnAt}</span>
      </div>
      <div className="inbound-actions">
        {/* Screen-reader / test-stable provenance sentence. Visually
            folded into the age chip above; kept for the pinned
            "{provider} replied {age}" assertion + a11y. */}
        <span className="inbound-provenance-sr">
          {reminder.providerLabel} replied {reminder.inboundTurnAt}
        </span>
        <button type="button" className="inbound-btn inbound-btn-primary" onClick={onOpen}>
          Open
        </button>
        {/* Plain-language rename (R1.2 feedback 4): "Mark relevant" was
            ranker jargon. "Helpful" is the universal thumbs-up gesture a
            stranger reads instantly. LABEL-ONLY change — the click still
            fires the SAME updateReminder{status:'relevant'} → trainable
            recall.action emission (frozen ranker-label semantics). Do
            not rename the prop/status value. */}
        <button
          type="button"
          className="inbound-btn"
          onClick={onMarkRelevant}
          aria-label="Mark this reply as helpful"
          title="Tell Sidetrack this reply was useful — improves what it surfaces"
        >
          Helpful
        </button>
        <button type="button" className="inbound-btn inbound-btn-muted" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
