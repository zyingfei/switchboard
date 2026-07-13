// §13 steps 3/9 — map the workboard's inbound-reminder records onto the
// InboundCard view shape. Kept pure (no React, no clock beyond the
// injected relative formatter) so the join + status/label mapping is
// unit-testable in isolation.

import type { InboundReminder as InboundReminderRecord } from '../../workboard';
import type { InboundReminder as InboundCardReminder } from '../../../entrypoints/sidepanel/components/InboundCard';

export interface InboundThreadLite {
  readonly bac_id: string;
  readonly title: string;
  readonly lastTurnRole?: 'user' | 'assistant' | 'system' | 'unknown';
}

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

// Join one reminder with its thread. Returns null when the thread is
// gone (orphaned reminder) so callers can prune it from the list.
export const mapInboundReminder = (
  reminder: InboundReminderRecord,
  threads: readonly InboundThreadLite[],
  formatRelative: (iso: string) => string,
): InboundCardReminder | null => {
  const thread = threads.find((t) => t.bac_id === reminder.threadId);
  if (thread === undefined) return null;
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
  };
};

const mapSorted = (
  reminders: readonly InboundReminderRecord[],
  threads: readonly InboundThreadLite[],
  formatRelative: (iso: string) => string,
): readonly InboundCardReminder[] =>
  reminders
    .slice()
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
    .flatMap((r) => {
      const mapped = mapInboundReminder(r, threads, formatRelative);
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
): readonly InboundCardReminder[] =>
  mapSorted(
    reminders.filter((r) => r.status === 'new'),
    threads,
    formatRelative,
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
): readonly InboundCardReminder[] =>
  mapSorted(
    reminders.filter((r) => {
      if (r.status !== 'seen' && r.status !== 'relevant') return false;
      const detectedMs = Date.parse(r.detectedAt);
      return Number.isFinite(detectedMs) && nowMs - detectedMs <= READ_GROUP_WINDOW_MS;
    }),
    threads,
    formatRelative,
  );
