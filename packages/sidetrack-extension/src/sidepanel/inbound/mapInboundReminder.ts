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
// (the user has acknowledged it); 'dismissed' passes through.
const cardStatusOf = (status: InboundReminderRecord['status']): InboundCardReminder['status'] => {
  if (status === 'new') return 'unseen';
  if (status === 'dismissed') return 'dismissed';
  return 'seen';
};

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

// Map + prune the full reminder list, newest-first. Dismissed
// reminders are dropped — the Inbound view is a live queue of replies
// that still want attention.
export const mapInboundReminders = (
  reminders: readonly InboundReminderRecord[],
  threads: readonly InboundThreadLite[],
  formatRelative: (iso: string) => string,
): readonly InboundCardReminder[] =>
  reminders
    .filter((r) => r.status !== 'dismissed')
    .slice()
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
    .flatMap((r) => {
      const mapped = mapInboundReminder(r, threads, formatRelative);
      return mapped === null ? [] : [mapped];
    });
