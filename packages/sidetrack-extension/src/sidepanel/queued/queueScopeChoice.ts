// §13 step 4 — the queue-compose scope selector. The composer lets the
// user choose whether a follow-up is parked on the THREAD (default,
// current behavior), rolled up to the thread's WORKSTREAM, or made
// GLOBAL (fires anywhere). This pure helper maps that UI choice onto the
// `QueueCreate` scope/targetId the background handler already forwards
// verbatim — grouping (groupQueueItems) + the companion route already
// understand all three. Keeping the derivation here makes it
// unit-testable without React and keeps App.tsx's submit path a
// one-liner.

import type { QueueCreate } from '../../companion/model';

// The three options the composer surfaces. Distinct from
// QueueCreate['scope'] only so a future UI-only variant (e.g. a
// per-workstream override) can't silently widen the wire contract.
export type QueueScopeChoice = 'thread' | 'workstream' | 'global';

// Minimal thread shape the selector needs — the row's id and its home
// workstream (when the thread is organized into one).
export interface QueueScopeThreadLite {
  readonly bac_id: string;
  readonly primaryWorkstreamId?: string;
}

// Whether the "Workstream" option should be offered for this thread.
// Only meaningful when the thread is organized into a workstream —
// otherwise there's nothing to roll the follow-up up to.
export const canScopeToWorkstream = (thread: QueueScopeThreadLite): boolean =>
  typeof thread.primaryWorkstreamId === 'string' && thread.primaryWorkstreamId.length > 0;

// Map the composer's choice → the QueueCreate scope/targetId.
//   thread     → { scope: 'thread', targetId: <thread id> }
//   workstream → { scope: 'workstream', targetId: <thread's workstream> }
//                (falls back to thread scope if the thread has no
//                 workstream — the selector shouldn't offer it then, but
//                 defend the wire contract so we never emit a
//                 workstream-scoped item with no targetId)
//   global     → { scope: 'global' } (no targetId)
export const resolveQueueScope = (
  choice: QueueScopeChoice,
  thread: QueueScopeThreadLite,
  text: string,
): QueueCreate => {
  if (choice === 'global') {
    return { text, scope: 'global' };
  }
  if (choice === 'workstream' && canScopeToWorkstream(thread)) {
    return { text, scope: 'workstream', targetId: thread.primaryWorkstreamId };
  }
  // Default + the workstream-without-workstream fallback.
  return { text, scope: 'thread', targetId: thread.bac_id };
};
