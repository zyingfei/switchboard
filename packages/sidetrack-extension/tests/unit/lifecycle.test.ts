import { describe, expect, it } from 'vitest';

import { deriveLifecycle, STALE_AFTER_MS } from '../../src/sidepanel/lifecycle';
import type { TrackedThread } from '../../src/workboard';

const NOW_MS = Date.parse('2026-04-29T12:00:00.000Z');

const thread = (overrides: Partial<TrackedThread> = {}): TrackedThread => ({
  bac_id: 'bac_thread_1',
  provider: 'claude',
  threadUrl: 'https://claude.ai/chat/abc',
  title: 'Test thread',
  lastSeenAt: '2026-04-29T11:59:00.000Z',
  status: 'active',
  trackingMode: 'auto',
  // Default to a workstream so the new "needs-organize when no
  // workstream" rule doesn't short-circuit every other lifecycle test.
  primaryWorkstreamId: 'ws_test',
  tags: [],
  ...overrides,
});

describe('deriveLifecycle', () => {
  it('returns tab-closed for restorable / closed status (no pill)', () => {
    const result = deriveLifecycle(thread({ status: 'restorable' }), [], NOW_MS);
    expect(result.kind).toBe('tab-closed');
    expect(result.dotClass).toBe('gray');
    expect(result.lifecyclePill).toBeUndefined();
  });

  it('returns tracking-stopped when trackingMode is stopped (no pill)', () => {
    const result = deriveLifecycle(thread({ trackingMode: 'stopped' }), [], NOW_MS);
    expect(result.kind).toBe('tracking-stopped');
  });

  it('lights signal pill when there is an unread (new) reminder for the thread', () => {
    const result = deriveLifecycle(thread(), [{ threadId: 'bac_thread_1', status: 'new' }], NOW_MS);
    expect(result.kind).toBe('unread-reply');
    expect(result.dotClass).toBe('signal');
    // Renamed from "Unread reply" so the row + Inbox use the same words.
    expect(result.lifecyclePill?.label).toBe('Replied · unread');
    expect(result.lifecyclePill?.tone).toBe('signal');
    expect(result.loopChip?.label).toBe('Replied · unread');
  });

  it('does NOT light Unread reply when the only reminder is dismissed', () => {
    // Regression guard — a dismissed reminder must not light the pill.
    const result = deriveLifecycle(
      thread(),
      [{ threadId: 'bac_thread_1', status: 'dismissed' }],
      NOW_MS,
    );
    expect(result.kind).not.toBe('unread-reply');
  });

  it('does NOT light Unread reply when the reminder has been READ (seen)', () => {
    // Read-semantics core: opening a reply (or auto-marking it seen
    // for the active tab) sets status 'seen'. The reminder record
    // survives, but the unread pill must clear — "unread" now means
    // 'new', not merely "not dismissed".
    const seen = deriveLifecycle(thread(), [{ threadId: 'bac_thread_1', status: 'seen' }], NOW_MS);
    expect(seen.kind).not.toBe('unread-reply');
    // Legacy 'relevant' records collapse to read too.
    const relevant = deriveLifecycle(
      thread(),
      [{ threadId: 'bac_thread_1', status: 'relevant' }],
      NOW_MS,
    );
    expect(relevant.kind).not.toBe('unread-reply');
  });

  it('ignores reminders that target other threads', () => {
    const result = deriveLifecycle(
      thread({ bac_id: 'bac_thread_target' }),
      [{ threadId: 'bac_thread_OTHER', status: 'new' }],
      NOW_MS,
    );
    expect(result.kind).not.toBe('unread-reply');
  });

  it('returns waiting-ai when last turn is by user', () => {
    const result = deriveLifecycle(thread({ lastTurnRole: 'user' }), [], NOW_MS);
    expect(result.kind).toBe('waiting-ai');
    expect(result.lifecyclePill?.label).toBe('Waiting on AI');
    expect(result.dotClass).toBe('amber');
    expect(result.stampLabel).toBe('Last sent');
  });

  it('returns ai-replied when last turn is by assistant (no pending reminder)', () => {
    const result = deriveLifecycle(thread({ lastTurnRole: 'assistant' }), [], NOW_MS);
    expect(result.kind).toBe('ai-replied');
    expect(result.lifecyclePill?.label).toBe('AI replied last');
    expect(result.dotClass).toBe('green');
  });

  it('returns needs-organize for needs_organize status (no reminder)', () => {
    const result = deriveLifecycle(thread({ status: 'needs_organize' }), [], NOW_MS);
    expect(result.kind).toBe('needs-organize');
    expect(result.lifecyclePill?.label).toBe('Needs organize');
  });

  it('returns stale once age crosses the staleness threshold', () => {
    const oldThread = thread({
      lastSeenAt: new Date(NOW_MS - STALE_AFTER_MS - 1000).toISOString(),
    });
    const result = deriveLifecycle(oldThread, [], NOW_MS);
    expect(result.kind).toBe('stale');
  });

  it('Replied · unread trumps Waiting on AI when both apply', () => {
    // If the user just sent a turn and an old assistant reminder is
    // still in storage, we must show Replied · unread — the more
    // urgent signal.
    const result = deriveLifecycle(
      thread({ lastTurnRole: 'user' }),
      [{ threadId: 'bac_thread_1', status: 'new' }],
      NOW_MS,
    );
    expect(result.kind).toBe('unread-reply');
  });
});

describe('deriveLifecycle — loop-state chip (§3.2)', () => {
  const queue = (over: Partial<Parameters<typeof deriveLifecycle>[3] & object> = {}) => ({
    pendingCount: 1,
    anyTyping: false,
    tabOpen: true,
    ...over,
  });

  it('emits no chip for an idle thread with no queue', () => {
    const result = deriveLifecycle(thread(), [], NOW_MS, queue({ pendingCount: 0 }));
    expect(result.kind).toBe('fresh');
    expect(result.loopChip).toBeUndefined();
  });

  it('"N queued · send now" when pending, tab open, no blocker', () => {
    const result = deriveLifecycle(thread(), [], NOW_MS, queue({ pendingCount: 2, tabOpen: true }));
    expect(result.kind).toBe('queued');
    expect(result.loopChip?.label).toBe('2 queued · send now');
    expect(result.loopChip?.tone).toBe('amber');
  });

  it('"N queued · open to send" when pending and tab closed (no error yet)', () => {
    const result = deriveLifecycle(thread(), [], NOW_MS, queue({ tabOpen: false }));
    expect(result.loopChip?.label).toBe('1 queued · open to send');
  });

  it('"N queued · open to send" from the drain\'s tab-closed lastError', () => {
    const result = deriveLifecycle(
      thread(),
      [],
      NOW_MS,
      queue({
        tabOpen: true,
        frontRunnerLastError:
          'Open the chat tab; auto-send needs the conversation visible to type into.',
      }),
    );
    expect(result.loopChip?.label).toBe('1 queued · open to send');
  });

  it('"N queued · auto-send off" from the toggle-off blocker', () => {
    const result = deriveLifecycle(
      thread(),
      [],
      NOW_MS,
      queue({ frontRunnerLastError: 'Auto-send is off for this thread.' }),
    );
    expect(result.loopChip?.label).toBe('1 queued · auto-send off');
  });

  it('"Sending…" when any pending item is typing (outranks Queued)', () => {
    const result = deriveLifecycle(thread(), [], NOW_MS, queue({ pendingCount: 3, anyTyping: true }));
    expect(result.kind).toBe('sending');
    expect(result.loopChip?.label).toBe('Sending…');
  });

  it('Queued outranks Waiting on AI (a stacked ask is more actionable)', () => {
    const result = deriveLifecycle(thread({ lastTurnRole: 'user' }), [], NOW_MS, queue());
    expect(result.kind).toBe('queued');
  });

  it('Replied · unread outranks Queued', () => {
    const result = deriveLifecycle(
      thread(),
      [{ threadId: 'bac_thread_1', status: 'new' }],
      NOW_MS,
      queue({ pendingCount: 5 }),
    );
    expect(result.kind).toBe('unread-reply');
  });

  it('falls back to Waiting on AI chip when there is no queue', () => {
    const result = deriveLifecycle(thread({ lastTurnRole: 'user' }), [], NOW_MS);
    expect(result.kind).toBe('waiting-ai');
    expect(result.loopChip?.label).toBe('Waiting on AI');
  });

  it('Tab closed still wins over any queue state', () => {
    const result = deriveLifecycle(thread({ status: 'restorable' }), [], NOW_MS, queue());
    expect(result.kind).toBe('tab-closed');
    expect(result.loopChip).toBeUndefined();
  });
});
