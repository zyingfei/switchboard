import type { QueueGroup } from '../../../src/sidepanel/queued/groupQueueItems';

// §13 step 9 — the Queued view. Pending queue items grouped by their
// target (thread / workstream / global). Grouping is done upstream
// (groupQueueItems); this view renders section headers + rows and
// exposes per-item dismiss/retry callbacks.

export interface QueuedViewProps {
  readonly groups: readonly QueueGroup[];
  readonly onDismiss: (queueItemId: string) => void;
  readonly onRetry: (queueItemId: string) => void;
}

export function QueuedView({ groups, onDismiss, onRetry }: QueuedViewProps) {
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  return (
    <div className="queued-view" aria-label="Queued follow-ups">
      <div className="sec-head">
        <span>Queued follow-ups</span>
        <span className="count mono">{String(total)}</span>
      </div>
      {groups.length === 0 ? (
        <div className="thread-empty subtle">
          <p>Nothing queued. Stack a follow-up on a thread and it waits here until it sends.</p>
        </div>
      ) : (
        groups.map((group) => (
          <div className="queued-group" key={group.key}>
            <div className="queued-group-head">
              <span className="queued-group-label">{group.label}</span>
              {group.provider !== undefined ? (
                <span className={'chip chip-' + group.provider}>{group.provider}</span>
              ) : null}
              <span className="count mono">{String(group.items.length)}</span>
            </div>
            <ul className="queued-group-list">
              {group.items.map((item) => (
                <li
                  key={item.bac_id}
                  className={'queued-item' + (item.lastError !== undefined ? ' has-error' : '')}
                >
                  <span className="queued-item-text">{item.text}</span>
                  {item.lastError !== undefined ? (
                    <span className="queued-item-error mono" title={item.lastError}>
                      failed
                    </span>
                  ) : null}
                  <span className="queued-item-actions">
                    {item.lastError !== undefined ? (
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => {
                          onRetry(item.bac_id);
                        }}
                      >
                        Retry
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn-link btn-muted"
                      onClick={() => {
                        onDismiss(item.bac_id);
                      }}
                    >
                      Dismiss
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
