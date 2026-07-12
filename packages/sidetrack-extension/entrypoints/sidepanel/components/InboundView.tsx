import { InboundCard, type InboundReminder } from './InboundCard';

// §13 steps 3/9 — the live Inbound view. Renders the already-built
// InboundCard for each reminder ("Claude replied 3 minutes ago").
// Mapping + pruning happens upstream (mapInboundReminders); this view
// is presentation + per-card callbacks only.

export interface InboundViewProps {
  readonly reminders: readonly InboundReminder[];
  readonly onOpen: (reminderId: string) => void;
  readonly onMarkRelevant: (reminderId: string) => void;
  readonly onDismiss: (reminderId: string) => void;
  // When true, private-workstream reminders render masked titles.
  readonly maskedIds?: ReadonlySet<string>;
}

export function InboundView({
  reminders,
  onOpen,
  onMarkRelevant,
  onDismiss,
  maskedIds,
}: InboundViewProps) {
  return (
    <div className="inbound-view" aria-label="Inbound replies">
      <div className="sec-head">
        <span>Inbound replies</span>
        <span className="count mono">{String(reminders.length)}</span>
      </div>
      {reminders.length === 0 ? (
        <div className="thread-empty subtle">
          <p>No new replies waiting. When an AI answers a tracked thread, it lands here.</p>
        </div>
      ) : (
        <div className="inbound-list">
          {reminders.map((reminder) => (
            <InboundCard
              key={reminder.bac_id}
              reminder={reminder}
              masked={maskedIds?.has(reminder.bac_id) ?? false}
              onOpen={() => {
                onOpen(reminder.bac_id);
              }}
              onMarkRelevant={() => {
                onMarkRelevant(reminder.bac_id);
              }}
              onDismiss={() => {
                onDismiss(reminder.bac_id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
