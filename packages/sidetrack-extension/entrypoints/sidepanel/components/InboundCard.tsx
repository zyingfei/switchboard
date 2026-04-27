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

export function InboundCard({ reminder, masked = false, onOpen, onMarkRelevant, onDismiss }: InboundCardProps) {
  const title = masked ? '[private — workstream item]' : reminder.threadTitle;
  return (
    <div className={'inbound-card status-' + reminder.status}>
      <div className="inbound-row1">
        <span className={'pulse pulse-signal'} aria-hidden />
        <span className={'chip chip-' + reminder.provider}>{reminder.providerLabel}</span>
        <span className={'inbound-title' + (reminder.aiAuthored && !masked ? ' ai-italic' : '') + (masked ? ' masked' : '')}>
          {title}
        </span>
      </div>
      <div className="inbound-row2 mono">
        <span>{reminder.providerLabel} replied {reminder.inboundTurnAt}</span>
      </div>
      <div className="inbound-actions">
        <button type="button" className="btn-link" onClick={onOpen}>
          Open
        </button>
        <button type="button" className="btn-link" onClick={onMarkRelevant}>
          Mark relevant
        </button>
        <button type="button" className="btn-link btn-muted" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
