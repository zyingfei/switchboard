// Derives the lifecycle pill state for a tracked thread row from its
// stored fields plus current reminders. Pure — no DOM, no chrome.*
// access — so the side panel can render off it and the unit tests
// can assert against it directly.
//
// Single source of truth for the dot color and the row2 loop-state
// chip word (so the signal-orange pulse and the "Replied · unread"
// text never disagree). The chip is the conversation-loop state per
// §3.2 of the loop spec: one thread, one machine, every surface a
// view of it.

import type { TrackedThread } from '../workboard';
import { resolveQueueBlocker } from './queued/blocker';

export type LifecycleKind =
  | 'unread-reply'
  | 'sending'
  | 'queued'
  | 'waiting-ai'
  | 'ai-replied'
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
  // The single conversation-loop chip for this thread row (§3.2). One
  // per row; text already carries the count/blocker. Absent for Idle.
  readonly loopChip?: { readonly label: string; readonly tone: 'signal' | 'amber' | 'gray' };
}

export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface LifecycleReminderInput {
  readonly threadId: string;
  readonly status: string;
}

// The thread's pending thread-scoped queue items, summarized for the
// chip. Computed by the caller (App.tsx already filters these per row)
// and passed in so deriveLifecycle stays pure and testable.
export interface LifecycleQueueSummary {
  // Count of pending thread-scoped items targeting this thread.
  readonly pendingCount: number;
  // True when any pending item is mid-send (progress:'typing').
  readonly anyTyping: boolean;
  // The front-runner pending item's lastError (drain bail reason), if
  // any — drives the blocker suffix on the chip. Undefined = no blocker.
  readonly frontRunnerLastError?: string;
  // Whether the thread's chat tab is currently open. When true and
  // there's no blocker, the chip reads "N queued · send now"; when
  // false it reads "N queued · open to send".
  readonly tabOpen: boolean;
  // Provider display label for splicing into the provider-opt-out
  // blocker copy (e.g. "ChatGPT isn't opted in").
  readonly providerLabel?: string;
}

const pluralQueued = (count: number): string => `${String(count)} queued`;

export const deriveLifecycle = (
  thread: TrackedThread,
  reminders: readonly LifecycleReminderInput[],
  nowMs: number = Date.now(),
  queue?: LifecycleQueueSummary,
): LifecycleResult => {
  if (thread.status === 'restorable' || thread.status === 'closed') {
    return { kind: 'tab-closed', dotClass: 'gray', stampLabel: 'Tab closed' };
  }
  if (thread.trackingMode === 'stopped') {
    return { kind: 'tracking-stopped', dotClass: 'gray', stampLabel: 'Tracking stopped' };
  }
  // "Replied · unread" means a reply the user has not READ yet — status
  // 'new'. Once opened (status 'seen') or auto-marked-seen for the
  // active tab, the chip clears even though the reminder record
  // persists (only 'dismissed' used to clear it, so a read-but-kept
  // reply wrongly stayed "unread"). Renamed from "Unread reply" so the
  // thread row and the Inbox use the SAME words for the same event.
  const hasUnread = reminders.some((r) => r.threadId === thread.bac_id && r.status === 'new');
  if (hasUnread) {
    return {
      kind: 'unread-reply',
      dotClass: 'signal',
      stampLabel: 'Last seen',
      lifecyclePill: { label: 'Replied · unread', tone: 'signal' },
      loopChip: { label: 'Replied · unread', tone: 'signal' },
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
      loopChip: { label: 'Needs organize', tone: 'amber' },
    };
  }
  const ageMs = nowMs - Date.parse(thread.lastSeenAt);
  if (Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS) {
    return {
      kind: 'stale',
      dotClass: 'gray',
      stampLabel: 'Last seen',
      lifecyclePill: { label: 'Stale', tone: 'gray' },
      loopChip: { label: 'Stale', tone: 'gray' },
    };
  }
  // Sending > Queued > Waiting on AI. An item I stacked but haven't
  // shipped is more actionable than a thread already mid-turn with the
  // AI; Sending outranks Queued because it's transient progress.
  if (queue !== undefined && queue.pendingCount > 0) {
    if (queue.anyTyping) {
      return {
        kind: 'sending',
        dotClass: 'amber',
        stampLabel: 'Last sent',
        loopChip: { label: 'Sending…', tone: 'amber' },
      };
    }
    // No blocker + tab open → "send now". A blocker → its suffix. Tab
    // closed with no explicit error → "open to send".
    const blocker = resolveQueueBlocker(queue.frontRunnerLastError, queue.providerLabel);
    const suffix =
      blocker.kind === 'none' ? (queue.tabOpen ? 'send now' : 'open to send') : blocker.chipSuffix;
    return {
      kind: 'queued',
      dotClass: 'amber',
      stampLabel: 'Last seen',
      loopChip: { label: `${pluralQueued(queue.pendingCount)} · ${suffix}`, tone: 'amber' },
    };
  }
  if (thread.lastTurnRole === 'user') {
    return {
      kind: 'waiting-ai',
      dotClass: 'amber',
      stampLabel: 'Last sent',
      lifecyclePill: { label: 'Waiting on AI', tone: 'amber' },
      loopChip: { label: 'Waiting on AI', tone: 'amber' },
    };
  }
  if (thread.lastTurnRole === 'assistant') {
    // The AI sent the last turn. The previous label "You replied
    // last" was inverted from the data — it ran on lastTurnRole ===
    // 'assistant' but read as if the user had replied. The user's
    // mental model is "what's the most recent action on this
    // thread?", so the chip now mirrors the actual last actor.
    return {
      kind: 'ai-replied',
      dotClass: 'green',
      stampLabel: 'Last seen',
      lifecyclePill: { label: 'AI replied last', tone: 'gray' },
      loopChip: { label: 'AI replied last', tone: 'gray' },
    };
  }
  return { kind: 'fresh', dotClass: 'green', stampLabel: 'Last seen' };
};
