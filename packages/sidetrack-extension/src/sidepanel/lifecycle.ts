// Derives the lifecycle pill state for a tracked thread row from its
// stored fields plus current reminders. Pure — no DOM, no chrome.*
// access — so the side panel can render off it and the unit tests
// can assert against it directly.
//
// Single source of truth for the dot color and the row2 stamp word
// (so the signal-orange pulse and the "Unread reply" text never
// disagree).

import type { TrackedThread } from '../workboard';

export type LifecycleKind =
  | 'unread-reply'
  | 'waiting-ai'
  | 'you-replied'
  | 'needs-organize'
  | 'stale'
  | 'tab-closed'
  | 'tracking-stopped'
  | 'fresh';

export interface LifecycleResult {
  readonly kind: LifecycleKind;
  readonly dotClass: 'signal' | 'amber' | 'green' | 'gray';
  readonly stampLabel: string;
  readonly lifecyclePill?: { readonly label: string; readonly tone: 'signal' | 'amber' | 'gray' };
}

export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface LifecycleReminderInput {
  readonly threadId: string;
  readonly status: string;
}

export const deriveLifecycle = (
  thread: TrackedThread,
  reminders: readonly LifecycleReminderInput[],
  nowMs: number = Date.now(),
): LifecycleResult => {
  if (thread.status === 'restorable' || thread.status === 'closed') {
    return { kind: 'tab-closed', dotClass: 'gray', stampLabel: 'Tab closed' };
  }
  if (thread.trackingMode === 'stopped') {
    return { kind: 'tracking-stopped', dotClass: 'gray', stampLabel: 'Tracking stopped' };
  }
  const hasUnread = reminders.some((r) => r.threadId === thread.bac_id && r.status !== 'dismissed');
  if (hasUnread) {
    return {
      kind: 'unread-reply',
      dotClass: 'signal',
      stampLabel: 'Last seen',
      lifecyclePill: { label: 'Unread reply', tone: 'signal' },
    };
  }
  // "Needs organize" fires when the thread has no workstream
  // assignment OR has the explicit needs_organize status. The
  // status-only check missed all the auto-captured threads that
  // landed without a workstream — the user reported 16/18 threads
  // had primaryWorkstreamId === undefined yet zero showed the
  // suggestion row.
  if (thread.status === 'needs_organize' || thread.primaryWorkstreamId === undefined) {
    return {
      kind: 'needs-organize',
      dotClass: 'amber',
      stampLabel: 'Last seen',
      lifecyclePill: { label: 'Needs organize', tone: 'amber' },
    };
  }
  const ageMs = nowMs - Date.parse(thread.lastSeenAt);
  if (Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS) {
    return {
      kind: 'stale',
      dotClass: 'gray',
      stampLabel: 'Last seen',
      lifecyclePill: { label: 'Stale', tone: 'gray' },
    };
  }
  if (thread.lastTurnRole === 'user') {
    return {
      kind: 'waiting-ai',
      dotClass: 'amber',
      stampLabel: 'Last sent',
      lifecyclePill: { label: 'Waiting on AI', tone: 'amber' },
    };
  }
  if (thread.lastTurnRole === 'assistant') {
    return {
      kind: 'you-replied',
      dotClass: 'green',
      stampLabel: 'Last seen',
      lifecyclePill: { label: 'You replied last', tone: 'gray' },
    };
  }
  return { kind: 'fresh', dotClass: 'green', stampLabel: 'Last seen' };
};
