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
  readonly onDismiss: () => void;
}

// Inbound reply row — rebuilt on the token system (R1.1). Clear anatomy:
//   Row 1  · unread dot (static; unseen only) + provider chip + title + age
//   Row 2  · one aligned action row (Open / Dismiss)
// Unseen replies are accented (a left rail + a static unread dot) because
// an unread AI reply is the highest-value actionable-now signal; seen
// replies fall back to a quiet paper card. No muddy amber wash, no
// infinite pulse — the idle panel does not paint (CPU-runaway history).
export function InboundCard({
  reminder,
  masked = false,
  onOpen,
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
        {/* Open marks the reply read (status 'seen'), which clears it
            from the active inbound list and the Inbox badge — the
            unread signal is "you haven't read this reply yet". */}
        <button type="button" className="inbound-btn inbound-btn-primary" onClick={onOpen}>
          Open
        </button>
        {/* No "Helpful" affordance: the previous button wrote
            status:'relevant' and claimed a trainable recall.action
            emission, but updateReminder never touches the recall
            action path — it emitted no training signal. Removed rather
            than left as a dead, misleading control. */}
        <button type="button" className="inbound-btn inbound-btn-muted" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
