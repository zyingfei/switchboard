// Recurring-thread self-nomination row for the workboard.
//
// A chat thread the user keeps returning to but the resolver can't
// home (its similarity neighborhood reaches too many workstreams to
// pick one) renders as a dead-end empty card today. The companion's
// /v1/suggestions/thread route flags these as `selfNomination.eligible`
// — a thread revisited N times across several days with no workstream
// and no attribution suggestion. Instead of nothing, we offer the
// user the one action that matches the signal: start a workstream from
// this thread, pre-filled with a cleaned title they can edit inline.
//
// Three states:
//  - eligible: "Start a workstream from this thread?" + editable title
//    + one Confirm button (+ Dismiss).
//  - confirming: Confirm shows a pending label; inputs lock.
//  - filed: a short confirmation ("Started · <name>") that the parent
//    replaces on its next refresh once the thread carries the new
//    workstream.

import { useState } from 'react';

export interface ThreadSelfNominationProps {
  readonly visitCount: number;
  readonly distinctDays: number;
  readonly suggestedTitle: string;
  // True while the create-workstream + file-thread round-trip is in
  // flight (Confirm was clicked). Locks the inputs and relabels Confirm.
  readonly pending?: boolean;
  // Set once the thread has been filed into the new workstream — the
  // row collapses to a brief confirmation until the parent refresh
  // removes it (the thread now has a home, so it's no longer eligible).
  readonly filedTitle?: string;
  readonly onConfirm: (title: string) => void;
  readonly onDismiss: () => void;
}

export function ThreadSelfNomination({
  visitCount,
  distinctDays,
  suggestedTitle,
  pending = false,
  filedTitle,
  onConfirm,
  onDismiss,
}: ThreadSelfNominationProps) {
  const [title, setTitle] = useState(suggestedTitle);

  if (filedTitle !== undefined) {
    return (
      <div className="nx-suggest thread-selfnom is-filed" role="status">
        <span className="lead">Started workstream</span>
        <span className="ws-sug">
          <span className="hp-dot green" />
          <b>{filedTitle}</b>
        </span>
      </div>
    );
  }

  const trimmed = title.trim();
  const canConfirm = !pending && trimmed.length > 0;
  // Honest recurrence readout — this is the whole rationale for the
  // nudge, so the user sees exactly why it fired.
  const recurrence =
    distinctDays > 1
      ? `Seen ${String(visitCount)} times across ${String(distinctDays)} days — no home yet`
      : `Seen ${String(visitCount)} times — no home yet`;

  return (
    <div
      className="nx-suggest thread-selfnom is-eligible"
      role="group"
      aria-label="Start a workstream from this thread"
    >
      <span className="lead">Start a workstream from this thread?</span>
      <span className="selfnom-why mono subtle">{recurrence}</span>
      <div className="selfnom-edit">
        <input
          type="text"
          className="selfnom-title"
          aria-label="New workstream name"
          value={title}
          disabled={pending}
          onChange={(e) => {
            setTitle(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canConfirm) {
              e.preventDefault();
              onConfirm(trimmed);
            }
          }}
        />
      </div>
      <div className="acts">
        <button
          type="button"
          className="primary"
          disabled={!canConfirm}
          onClick={() => {
            onConfirm(trimmed);
          }}
        >
          {pending ? 'Starting…' : 'Start workstream'}
        </button>
        <button
          type="button"
          className="dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
          disabled={pending}
        >
          ×
        </button>
      </div>
    </div>
  );
}
