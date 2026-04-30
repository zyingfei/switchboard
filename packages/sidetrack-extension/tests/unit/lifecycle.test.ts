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

  it('lights signal pill when there is a non-dismissed reminder for the thread', () => {
    const result = deriveLifecycle(
      thread(),
      [{ threadId: 'bac_thread_1', status: 'new' }],
      NOW_MS,
    );
    expect(result.kind).toBe('unread-reply');
    expect(result.dotClass).toBe('signal');
    expect(result.lifecyclePill?.label).toBe('Unread reply');
    expect(result.lifecyclePill?.tone).toBe('signal');
  });

  it('does NOT light Unread reply when the only reminder is dismissed', () => {
    // Regression guard for the bug we just fixed — once
    // dismissRemindersForActiveTab runs, the pill must clear.
    const result = deriveLifecycle(
      thread(),
      [{ threadId: 'bac_thread_1', status: 'dismissed' }],
      NOW_MS,
    );
    expect(result.kind).not.toBe('unread-reply');
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

  it('returns you-replied when last turn is by assistant (no pending reminder)', () => {
    const result = deriveLifecycle(thread({ lastTurnRole: 'assistant' }), [], NOW_MS);
    expect(result.kind).toBe('you-replied');
    expect(result.lifecyclePill?.label).toBe('You replied last');
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

  it('Unread reply trumps Waiting on AI when both apply', () => {
    // If the user just sent a turn and an old assistant reminder is
    // still in storage, we must show Unread reply — that's the more
    // urgent signal.
    const result = deriveLifecycle(
      thread({ lastTurnRole: 'user' }),
      [{ threadId: 'bac_thread_1', status: 'new' }],
      NOW_MS,
    );
    expect(result.kind).toBe('unread-reply');
  });
});
