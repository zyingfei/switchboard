import { useState, type DragEvent } from 'react';
import type { QueueItem } from '../../../src/workboard';
import { resolveQueueBlocker } from '../../../src/sidepanel/queued/blocker';

// The inline per-thread queue row (under a thread card). Mirrors the
// Queued view's row anatomy (§3.3) so both surfaces agree on vocabulary
// and actions: text + blocker line + [Open] / [Send now] / [Edit] /
// [Remove]. The two surfaces are two views of the SAME queue predicate.
//
// §3.5: the user-facing `progress:'waiting'` label is REMOVED — once an
// item ships it's 'done' and the *thread* is Waiting on AI (its loop
// chip). A per-item "waiting for reply" competed with that thread-level
// signal ("two waitings"). The `waiting` field stays for the drain's
// internal use; it just isn't rendered as a label here. `typing` still
// renders as "Sending…" progress (the transient in-flight state).

export interface AutoSendQueueRowDnd {
  readonly draggable: boolean;
  readonly dragOverActive: boolean;
  readonly onDragStart: (event: DragEvent<HTMLLIElement>) => void;
  readonly onDragEnd: (event: DragEvent<HTMLLIElement>) => void;
  readonly onDragOver: (event: DragEvent<HTMLLIElement>) => void;
  readonly onDragLeave: (event: DragEvent<HTMLLIElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLLIElement>) => void;
}

export interface AutoSendQueueRowProps {
  readonly item: QueueItem;
  readonly index: number;
  readonly total: number;
  readonly providerLabel: string;
  readonly onOpen: () => void;
  readonly onSendNow: () => void;
  readonly onEdit: (nextText: string) => void;
  readonly onRemove: () => void;
  readonly dnd?: AutoSendQueueRowDnd;
}

export function AutoSendQueueRow({
  item,
  index,
  total,
  providerLabel,
  onOpen,
  onSendNow,
  onEdit,
  onRemove,
  dnd,
}: AutoSendQueueRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);

  const blocker = resolveQueueBlocker(item.lastError, providerLabel);
  const blocked = blocker.kind !== 'none';
  const typing = item.progress === 'typing';
  const sent = item.status === 'done';
  const statusClass = blocked ? 'failed' : sent ? 'sent' : typing ? 'active' : 'queued';
  const glyph = blocked ? '✕' : sent ? '✓' : typing ? '◉' : '◯';
  // Header word mirrors the loop vocabulary: Sending (typing) / Sent /
  // Blocked / Queued. No "waiting for reply" (that's the thread chip).
  const label = blocked ? 'Blocker' : sent ? 'Sent' : typing ? 'Sending' : 'Queued';

  const dndProps = dnd
    ? {
        draggable: dnd.draggable,
        onDragStart: dnd.onDragStart,
        onDragEnd: dnd.onDragEnd,
        onDragOver: dnd.onDragOver,
        onDragLeave: dnd.onDragLeave,
        onDrop: dnd.onDrop,
      }
    : {};
  const className = [
    'queue-row',
    statusClass,
    dnd?.draggable ? 'draggable' : '',
    dnd?.dragOverActive ? 'drag-over' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (editing) {
    return (
      <li className="queue-row editing">
        <form
          className="queue-row-edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            onEdit(draft);
            setEditing(false);
          }}
        >
          <textarea
            className="queue-row-edit-input mono"
            value={draft}
            rows={2}
            autoFocus
            onChange={(e) => {
              setDraft(e.target.value);
            }}
          />
          <div className="queue-row-actions">
            <button type="submit" className="btn-link">
              Save
            </button>
            <button
              type="button"
              className="btn-link"
              onClick={() => {
                setDraft(item.text);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className={className} {...dndProps}>
      {dnd?.draggable ? (
        <span className="queue-row-grip mono" aria-hidden title="Drag to reorder">
          ⋮⋮
        </span>
      ) : null}
      <div className="queue-row-status mono" aria-hidden>
        {glyph}
      </div>
      <div className="queue-row-main">
        <div className="queue-row-head mono">
          <span>{label}</span>
          <span>
            · {String(index + 1)} of {String(total)}
          </span>
        </div>
        <div className="queue-row-text" title={item.text}>
          “{item.text}”
        </div>
        {typing ? (
          <div className="queue-row-phase mono" role="status">
            typing into {providerLabel}…
          </div>
        ) : null}
        {blocked ? <div className="queue-row-blocker mono">{blocker.rowCopy}</div> : null}
      </div>
      <div className="queue-row-actions">
        {/* Mirror the Queued-view actions. Hide Send now when the tab is
            closed (Open handles it); hide Open when the fix is Edit
            (over-budget). Remove is always available. */}
        {blocker.primaryAction === 'edit' ? null : (
          <button type="button" className="btn-link" onClick={onOpen}>
            Open
          </button>
        )}
        {blocker.kind === 'tab-closed' || blocker.primaryAction === 'edit' ? null : (
          <button type="button" className="btn-link" onClick={onSendNow}>
            Send now
          </button>
        )}
        <button
          type="button"
          className="btn-link"
          onClick={() => {
            setDraft(item.text);
            setEditing(true);
          }}
        >
          Edit
        </button>
        <button type="button" className="btn-link" onClick={onRemove}>
          Remove
        </button>
      </div>
    </li>
  );
}
