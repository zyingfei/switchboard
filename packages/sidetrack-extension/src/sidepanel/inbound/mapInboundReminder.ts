// §13 steps 3/9 — map the workboard's inbound-reminder records onto the
// InboundCard view shape. Kept pure (no React, no clock beyond the
// injected relative formatter) so the join + status/label mapping is
// unit-testable in isolation.

import type { InboundReminder as InboundReminderRecord, QueueItem } from '../../workboard';
import type { InboundReminder as InboundCardReminder } from '../../../entrypoints/sidepanel/components/InboundCard';

export interface InboundThreadLite {
  readonly bac_id: string;
  readonly title: string;
  readonly lastTurnRole?: 'user' | 'assistant' | 'system' | 'unknown';
  // The thread's home workstream, resolved to a display label by the
  // caller (App.tsx already has workstreamPath). Feeds the Inbox card's
  // context line "<workstream> · in reply to …". Absent when the thread
  // is ungrouped.
  readonly workstreamLabel?: string;
}

// The minimal dispatch shape the "in reply to" join needs — a recorded
// outbound whose body is the follow-up we sent to this thread. Only
// thread-sourced dispatches are relevant (sourceThreadId).
export interface InboundDispatchLite {
  readonly sourceThreadId?: string;
  readonly body: string;
  readonly createdAt: string;
}

// Trim a follow-up/dispatch body to a one-line disambiguator for the
// "in reply to" excerpt. Collapses whitespace, strips the leading
// markdown heading noise a forwarded packet carries, caps at ~80 chars.
const excerptOf = (text: string, max = 80): string => {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
};

// Best-of "in reply to" resolution (spec §3.4), in strict precedence:
//   1. a QueueItem auto-resolved 'done' for this thread nearest before
//      the reply (the follow-up that prompted it), else
//   2. the most recent thread-sourced dispatch body before the reply,
//      else
//   3. undefined — NEVER fabricate.
// `detectedAtMs` anchors "near/before the reply"; done items/dispatches
// must be at or before it (a follow-up can't be answered before it's
// sent) and we take the latest such candidate.
export const resolveInReplyTo = (
  threadId: string,
  detectedAt: string,
  queueItems: readonly QueueItem[],
  dispatches: readonly InboundDispatchLite[],
): string | undefined => {
  const detectedAtMs = Date.parse(detectedAt);
  const atOrBefore = (iso: string): boolean => {
    if (!Number.isFinite(detectedAtMs)) return true;
    const ms = Date.parse(iso);
    return !Number.isFinite(ms) || ms <= detectedAtMs;
  };
  const doneForThread = queueItems
    .filter(
      (q) =>
        q.status === 'done' &&
        q.scope === 'thread' &&
        q.targetId === threadId &&
        atOrBefore(q.updatedAt),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (doneForThread.length > 0) {
    return excerptOf(doneForThread[0].text);
  }
  const dispatchForThread = dispatches
    .filter((d) => d.sourceThreadId === threadId && atOrBefore(d.createdAt))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (dispatchForThread.length > 0) {
    return excerptOf(dispatchForThread[0].body);
  }
  return undefined;
};

const PROVIDER_LABELS: Record<string, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
  unknown: 'AI',
};

const providerLabelOf = (provider: string): string => PROVIDER_LABELS[provider] ?? 'AI';

// The workboard status vocabulary ('new' | 'seen' | 'relevant' |
// 'dismissed') is richer than the card's ('unseen' | 'seen' |
// 'dismissed'). 'new' → 'unseen'; 'relevant' collapses to 'seen'
// (a legacy acknowledgement — the 'relevant' status is no longer
// written by any UI path but old records still carry it, so we treat
// it as 'seen' everywhere); 'dismissed' passes through.
const cardStatusOf = (status: InboundReminderRecord['status']): InboundCardReminder['status'] => {
  if (status === 'new') return 'unseen';
  if (status === 'dismissed') return 'dismissed';
  return 'seen';
};

// How far back the collapsed "Read" group reaches. Read replies older
// than this simply drop off the list — the thread itself still holds
// the reply.
export const READ_GROUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Optional context for the card's §3.4 context line + snippet. All
// fields are best-effort progressive enhancement — absent means the
// card renders the workstream label only (or nothing extra). Never
// causes a store read: `replySnippetByReminderId` is an in-memory map
// the caller already holds; when a snippet isn't there, it's skipped.
export interface InboundContext {
  readonly queueItems?: readonly QueueItem[];
  readonly dispatches?: readonly InboundDispatchLite[];
  // reminder bac_id → first ~90 chars of the pinned assistant turn, if
  // it's in memory. Caller supplies only what it already has.
  readonly replySnippetByReminderId?: Readonly<Record<string, string>>;
}

// Join one reminder with its thread. Returns null when the thread is
// gone (orphaned reminder) so callers can prune it from the list.
export const mapInboundReminder = (
  reminder: InboundReminderRecord,
  threads: readonly InboundThreadLite[],
  formatRelative: (iso: string) => string,
  context?: InboundContext,
): InboundCardReminder | null => {
  const thread = threads.find((t) => t.bac_id === reminder.threadId);
  if (thread === undefined) return null;
  const inReplyTo = resolveInReplyTo(
    reminder.threadId,
    reminder.detectedAt,
    context?.queueItems ?? [],
    context?.dispatches ?? [],
  );
  const replySnippet = context?.replySnippetByReminderId?.[reminder.bac_id];
  return {
    bac_id: reminder.bac_id,
    threadTitle: thread.title,
    provider: reminder.provider,
    providerLabel: providerLabelOf(reminder.provider),
    inboundTurnAt: formatRelative(reminder.detectedAt),
    status: cardStatusOf(reminder.status),
    // The reply that triggered the reminder is an assistant turn; the
    // card italicizes AI-authored titles. Mirror the thread's last
    // turn role when known, else assume assistant (reminders fire on
    // inbound assistant replies).
    aiAuthored: thread.lastTurnRole === undefined || thread.lastTurnRole === 'assistant',
    // §3.4 context line — workstream label + "in reply to" excerpt.
    // Each is omitted when absent so the card never renders an empty
    // "· in reply to \"\"" or a bare separator.
    ...(thread.workstreamLabel === undefined ? {} : { workstreamLabel: thread.workstreamLabel }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    ...(replySnippet === undefined || replySnippet.trim().length === 0
      ? {}
      : { replySnippet: replySnippet.trim() }),
  };
};

const mapSorted = (
  reminders: readonly InboundReminderRecord[],
  threads: readonly InboundThreadLite[],
  formatRelative: (iso: string) => string,
  context?: InboundContext,
): readonly InboundCardReminder[] =>
  reminders
    .slice()
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
    .flatMap((r) => {
      const mapped = mapInboundReminder(r, threads, formatRelative, context);
      return mapped === null ? [] : [mapped];
    });

// The ACTIVE inbound list is unread replies only — a reply you have
// not read yet. Opening one marks it 'seen', which drops it from this
// list (the thread still holds the reply). 'seen'/'relevant'
// (read) and 'dismissed' reminders never appear here; read items are
// available in the collapsed group below (mapReadInboundReminders).
export const mapInboundReminders = (
  reminders: readonly InboundReminderRecord[],
  threads: readonly InboundThreadLite[],
  formatRelative: (iso: string) => string,
  context?: InboundContext,
): readonly InboundCardReminder[] =>
  mapSorted(
    reminders.filter((r) => r.status === 'new'),
    threads,
    formatRelative,
    context,
  );

// The collapsed "Read" group — replies you've already read (status
// 'seen', or the legacy 'relevant') within the last 7 days, so a
// glance can recover a reply you dismissed from the active list by
// reading it. Older read replies and dismissed replies are excluded.
export const mapReadInboundReminders = (
  reminders: readonly InboundReminderRecord[],
  threads: readonly InboundThreadLite[],
  formatRelative: (iso: string) => string,
  nowMs: number = Date.now(),
  context?: InboundContext,
): readonly InboundCardReminder[] =>
  mapSorted(
    reminders.filter((r) => {
      if (r.status !== 'seen' && r.status !== 'relevant') return false;
      const detectedMs = Date.parse(r.detectedAt);
      return Number.isFinite(detectedMs) && nowMs - detectedMs <= READ_GROUP_WINDOW_MS;
    }),
    threads,
    formatRelative,
    context,
  );
