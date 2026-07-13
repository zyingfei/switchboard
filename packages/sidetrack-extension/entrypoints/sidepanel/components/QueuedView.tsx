import { useState } from 'react';
import type { QueueGroup } from '../../../src/sidepanel/queued/groupQueueItems';
import type { QueueItem } from '../../../src/workboard';
import { resolveQueueBlocker } from '../../../src/sidepanel/queued/blocker';

// The Queued view (§3.3) — the send-triage workbench. Every pending
// follow-up, grouped by its target thread, with the blocker that's
// keeping it from shipping NAMED and the one action that clears it.
// This is the fix for the "queued screen is basically useless"
// feedback: no row is a dead-end; each carries [Open] / [Send now] /
// [Edit] / [Remove].
//
// [Open] reopens/focuses the chat tab then drains (or, when auto-send
// is off, hands the redacted text to the paste flow). [Send now] fires
// the drain for an already-open tab. [Edit] rewrites the item text in
// place (the only non-Remove fix for the over-budget dead-end).
// [Remove] is the old Dismiss. All the send paths route through the
// §24.10 preflight funnel in App.tsx — this view is presentation +
// callbacks only.

export interface QueuedViewProps {
  readonly groups: readonly QueueGroup[];
  readonly onOpen: (targetId: string, itemId: string) => void;
  readonly onSendNow: (targetId: string, itemId: string) => void;
  readonly onEdit: (itemId: string, nextText: string) => void;
  readonly onRemove: (itemId: string) => void;
  // Any pre-existing non-thread-scoped items (workstream/global) — the
  // composer no longer offers those scopes (D6), but old records can
  // exist. When true, the view shows a banner explaining the dead-end.
  readonly hasNonThreadItems?: boolean;
}

// The row's action row, keyed off the resolved blocker. `provider` is
// the group's provider label (spliced into provider-opt-out copy).
function QueuedRow({
  item,
  provider,
  onOpen,
  onSendNow,
  onEdit,
  onRemove,
}: {
  readonly item: QueueItem;
  readonly provider?: string;
  readonly onOpen: (itemId: string) => void;
  readonly onSendNow: (itemId: string) => void;
  readonly onEdit: (itemId: string, nextText: string) => void;
  readonly onRemove: (itemId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const blocker = resolveQueueBlocker(item.lastError, provider);
  const blocked = blocker.kind !== 'none';

  if (editing) {
    return (
      <li className="queued-item queued-item-editing">
        <form
          className="queued-item-edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            onEdit(item.bac_id, draft);
            setEditing(false);
          }}
        >
          <textarea
            className="queued-item-edit-input mono"
            value={draft}
            rows={3}
            autoFocus
            onChange={(e) => {
              setDraft(e.target.value);
            }}
          />
          <div className="queued-item-actions">
            <button type="submit" className="btn-link queued-act-primary">
              Save
            </button>
            <button
              type="button"
              className="btn-link btn-muted"
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
    <li className={'queued-item' + (blocked ? ' has-blocker' : '')}>
      <span className="queued-item-text" title={item.text}>
        {item.text}
      </span>
      {blocked ? <span className="queued-item-blocker">{blocker.rowCopy}</span> : null}
      <span className="queued-item-actions">
        {/* Open — reopens/focuses the chat tab, then drains (or pastes
            when auto-send is off). The primary fix for a closed tab. */}
        {blocker.primaryAction === 'edit' ? null : (
          <button
            type="button"
            className={'btn-link' + (blocker.primaryAction === 'open' ? ' queued-act-primary' : '')}
            onClick={() => {
              onOpen(item.bac_id);
            }}
          >
            Open
          </button>
        )}
        {/* Send now — fires the drain for an already-open tab (gates
            still apply). Primary when there's no blocker. */}
        {blocker.kind === 'tab-closed' || blocker.primaryAction === 'edit' ? null : (
          <button
            type="button"
            className={
              'btn-link' + (blocker.primaryAction === 'send-now' ? ' queued-act-primary' : '')
            }
            onClick={() => {
              onSendNow(item.bac_id);
            }}
          >
            Send now
          </button>
        )}
        {/* Edit — rewrite the text in place; clears the blocker. Primary
            for the over-budget dead-end. */}
        <button
          type="button"
          className={'btn-link' + (blocker.primaryAction === 'edit' ? ' queued-act-primary' : '')}
          onClick={() => {
            setDraft(item.text);
            setEditing(true);
          }}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn-link btn-muted"
          onClick={() => {
            onRemove(item.bac_id);
          }}
        >
          Remove
        </button>
      </span>
    </li>
  );
}

export function QueuedView({
  groups,
  onOpen,
  onSendNow,
  onEdit,
  onRemove,
  hasNonThreadItems = false,
}: QueuedViewProps) {
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  return (
    <div className="queued-view" aria-label="Queued follow-ups">
      <div className="sec-head">
        <span>Queued follow-ups</span>
        <span className="count mono">{String(total)}</span>
      </div>
      {hasNonThreadItems ? (
        <div className="queued-nonthread-banner" role="note">
          This follow-up isn&apos;t tied to an open chat — Remove it and re-queue on a thread.
        </div>
      ) : null}
      {groups.length === 0 ? (
        <div className="thread-empty subtle queued-empty">
          <p className="queued-empty-head">Nothing queued yet.</p>
          <p>
            Queue a follow-up on any conversation and it waits here until it can send. When the
            tab&apos;s open and auto-send is on, it goes out on its own — otherwise Open the thread
            and we&apos;ll help you send it.
          </p>
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
                <QueuedRow
                  key={item.bac_id}
                  item={item}
                  provider={group.provider}
                  onOpen={(itemId) => {
                    onOpen(group.targetId ?? '', itemId);
                  }}
                  onSendNow={(itemId) => {
                    onSendNow(group.targetId ?? '', itemId);
                  }}
                  onEdit={onEdit}
                  onRemove={onRemove}
                />
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}
