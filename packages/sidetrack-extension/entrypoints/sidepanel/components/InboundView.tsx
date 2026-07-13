import { InboundCard, type InboundReminder } from './InboundCard';

// §13 steps 3/9 — the live Inbound view. Renders the already-built
// InboundCard for each reminder ("Claude replied 3 minutes ago").
// Mapping + pruning happens upstream (mapInboundReminders); this view
// is presentation + per-card callbacks only.
//
// The active list is UNREAD replies only (status 'new'). Read replies
// (opened, so status 'seen') collapse into an optional "Read"
// disclosure below — the thread still holds the reply, so this is a
// quiet recovery affordance, not a second inbox.

export interface InboundViewProps {
  readonly reminders: readonly InboundReminder[];
  // Read replies from the last 7 days, for the collapsed "Read"
  // group. Optional — when omitted or empty, no group renders.
  readonly readReminders?: readonly InboundReminder[];
  readonly onOpen: (reminderId: string) => void;
  readonly onDismiss: (reminderId: string) => void;
  // When true, private-workstream reminders render masked titles.
  readonly maskedIds?: ReadonlySet<string>;
}

export function InboundView({
  reminders,
  readReminders,
  onOpen,
  onDismiss,
  maskedIds,
}: InboundViewProps) {
  const read = readReminders ?? [];
  return (
    <div className="inbound-view" aria-label="Replies">
      <div className="sec-head">
        <span>Replies</span>
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
              onDismiss={() => {
                onDismiss(reminder.bac_id);
              }}
            />
          ))}
        </div>
      )}
      {read.length > 0 ? (
        <details className="inbound-read-group">
          <summary className="inbound-read-summary">
            Read <span className="count mono">{String(read.length)}</span>
          </summary>
          <div className="inbound-list inbound-read-list">
            {read.map((reminder) => (
              <InboundCard
                key={reminder.bac_id}
                reminder={reminder}
                masked={maskedIds?.has(reminder.bac_id) ?? false}
                onOpen={() => {
                  onOpen(reminder.bac_id);
                }}
                onDismiss={() => {
                  onDismiss(reminder.bac_id);
                }}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
