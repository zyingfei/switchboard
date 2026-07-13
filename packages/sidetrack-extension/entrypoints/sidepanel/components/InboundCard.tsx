export interface InboundReminder {
  readonly bac_id: string;
  readonly threadTitle: string;
  readonly provider: string;
  readonly providerLabel: string;
  readonly inboundTurnAt: string; // relative
  readonly status: 'unseen' | 'seen' | 'dismissed';
  readonly aiAuthored?: boolean;
  // §3.4 context line — the thread's workstream label and the excerpt
  // of the follow-up this reply answers. Both optional; the card omits
  // the part that's absent (never renders an empty "in reply to").
  readonly workstreamLabel?: string;
  readonly inReplyTo?: string;
  // Optional first ~90 chars of the reply itself (in-memory only).
  readonly replySnippet?: string;
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
  // §3.4 context line: "<workstream> · in reply to \"…\"". Masked cards
  // hide the in-reply-to excerpt (it can leak the private prompt) but
  // keep the workstream label. Built as parts so a missing piece never
  // renders a bare separator.
  const contextParts: string[] = [];
  if (reminder.workstreamLabel !== undefined && reminder.workstreamLabel.length > 0) {
    contextParts.push(reminder.workstreamLabel);
  }
  if (!masked && reminder.inReplyTo !== undefined && reminder.inReplyTo.length > 0) {
    contextParts.push(`in reply to “${reminder.inReplyTo}”`);
  }
  const contextLine = contextParts.join(' · ');
  const showSnippet =
    !masked && reminder.replySnippet !== undefined && reminder.replySnippet.length > 0;
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
      {contextLine.length > 0 ? <div className="inbound-context">{contextLine}</div> : null}
      {showSnippet ? <div className="inbound-snippet">“{reminder.replySnippet}”</div> : null}
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
