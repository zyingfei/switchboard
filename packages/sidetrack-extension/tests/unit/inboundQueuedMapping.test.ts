import { describe, expect, it } from 'vitest';

import {
  mapInboundReminder,
  mapInboundReminders,
  mapReadInboundReminders,
  resolveInReplyTo,
  READ_GROUP_WINDOW_MS,
  type InboundContext,
  type InboundThreadLite,
} from '../../src/sidepanel/inbound/mapInboundReminder';
import { groupQueueItems } from '../../src/sidepanel/queued/groupQueueItems';
import type { InboundReminder, QueueItem } from '../../src/workboard';

const rel = (iso: string): string => `rel(${iso})`;

const reminder = (over: Partial<InboundReminder> & Pick<InboundReminder, 'bac_id'>): InboundReminder => ({
  threadId: 't1',
  provider: 'claude',
  detectedAt: '2026-07-11T10:00:00.000Z',
  status: 'new',
  ...over,
});

const threads: readonly InboundThreadLite[] = [
  { bac_id: 't1', title: 'State machine review', lastTurnRole: 'assistant' },
  { bac_id: 't2', title: 'PRD cleanup', lastTurnRole: 'user' },
];

describe('mapInboundReminders — §13 steps 3/9', () => {
  it('joins reminders to their thread title + provider label', () => {
    const [mapped] = mapInboundReminders([reminder({ bac_id: 'r1' })], threads, rel);
    expect(mapped.threadTitle).toBe('State machine review');
    expect(mapped.providerLabel).toBe('Claude');
    expect(mapped.inboundTurnAt).toBe('rel(2026-07-11T10:00:00.000Z)');
  });

  it("maps status 'new' → 'unseen' and marks assistant replies ai-authored", () => {
    const [mapped] = mapInboundReminders([reminder({ bac_id: 'r1' })], threads, rel);
    expect(mapped.status).toBe('unseen');
    expect(mapped.aiAuthored).toBe(true);
  });

  it('drops dismissed reminders', () => {
    const mapped = mapInboundReminders(
      [reminder({ bac_id: 'r1', status: 'dismissed' })],
      threads,
      rel,
    );
    expect(mapped).toHaveLength(0);
  });

  it('active list is UNREAD only — read (seen/relevant) reminders drop out', () => {
    const mapped = mapInboundReminders(
      [
        reminder({ bac_id: 'r-new', status: 'new' }),
        reminder({ bac_id: 'r-seen', status: 'seen' }),
        reminder({ bac_id: 'r-relevant', status: 'relevant' }),
        reminder({ bac_id: 'r-dismissed', status: 'dismissed' }),
      ],
      threads,
      rel,
    );
    expect(mapped.map((m) => m.bac_id)).toEqual(['r-new']);
  });

  it('prunes reminders whose thread is gone', () => {
    const mapped = mapInboundReminders(
      [reminder({ bac_id: 'r1', threadId: 'missing' })],
      threads,
      rel,
    );
    expect(mapped).toHaveLength(0);
  });

  it('orders newest-first', () => {
    const mapped = mapInboundReminders(
      [
        reminder({ bac_id: 'old', detectedAt: '2026-07-11T09:00:00.000Z' }),
        reminder({ bac_id: 'new', detectedAt: '2026-07-11T11:00:00.000Z' }),
      ],
      threads,
      rel,
    );
    expect(mapped.map((m) => m.bac_id)).toEqual(['new', 'old']);
  });
});

describe('mapReadInboundReminders — collapsed "Read" group', () => {
  const NOW = Date.parse('2026-07-11T12:00:00.000Z');

  it('includes read (seen + legacy relevant) replies within the window, newest-first', () => {
    const read = mapReadInboundReminders(
      [
        reminder({ bac_id: 'r-new', status: 'new', detectedAt: '2026-07-11T11:00:00.000Z' }),
        reminder({ bac_id: 'r-seen', status: 'seen', detectedAt: '2026-07-11T10:00:00.000Z' }),
        reminder({
          bac_id: 'r-relevant',
          status: 'relevant',
          detectedAt: '2026-07-11T11:30:00.000Z',
        }),
        reminder({
          bac_id: 'r-dismissed',
          status: 'dismissed',
          detectedAt: '2026-07-11T11:45:00.000Z',
        }),
      ],
      threads,
      rel,
      NOW,
    );
    // 'new' + 'dismissed' excluded; seen/relevant kept, newest-first.
    expect(read.map((m) => m.bac_id)).toEqual(['r-relevant', 'r-seen']);
  });

  it('excludes read replies older than the 7-day window', () => {
    const stale = new Date(NOW - READ_GROUP_WINDOW_MS - 1000).toISOString();
    const fresh = new Date(NOW - 1000).toISOString();
    const read = mapReadInboundReminders(
      [
        reminder({ bac_id: 'r-stale', status: 'seen', detectedAt: stale }),
        reminder({ bac_id: 'r-fresh', status: 'seen', detectedAt: fresh }),
      ],
      threads,
      rel,
      NOW,
    );
    expect(read.map((m) => m.bac_id)).toEqual(['r-fresh']);
  });
});

describe('mapInboundReminder — §3.4 context line', () => {
  const wsThreads: readonly InboundThreadLite[] = [
    {
      bac_id: 't1',
      title: 'State machine review',
      lastTurnRole: 'assistant',
      workstreamLabel: 'MVP / PRD',
    },
    { bac_id: 't2', title: 'Ungrouped thread', lastTurnRole: 'assistant' },
  ];

  const doneFollowUp: QueueItem = {
    bac_id: 'q-done',
    text: 'Can you compare this with the alternative design?',
    scope: 'thread',
    targetId: 't1',
    status: 'done',
    createdAt: '2026-07-11T09:58:00.000Z',
    updatedAt: '2026-07-11T09:59:00.000Z',
  };

  it('joins the thread workstream label onto the card', () => {
    const [mapped] = mapInboundReminders([reminder({ bac_id: 'r1' })], wsThreads, rel);
    expect(mapped.workstreamLabel).toBe('MVP / PRD');
  });

  it('resolves "in reply to" from the nearest done follow-up before the reply', () => {
    const ctx: InboundContext = { queueItems: [doneFollowUp] };
    const [mapped] = mapInboundReminders([reminder({ bac_id: 'r1' })], wsThreads, rel, ctx);
    expect(mapped.inReplyTo).toBe('Can you compare this with the alternative design?');
  });

  it('falls back to a thread-sourced dispatch body when no done follow-up exists', () => {
    const ctx: InboundContext = {
      dispatches: [
        {
          sourceThreadId: 't1',
          body: 'Forwarded context: please critique the ranker approach.',
          createdAt: '2026-07-11T09:30:00.000Z',
        },
      ],
    };
    const [mapped] = mapInboundReminders([reminder({ bac_id: 'r1' })], wsThreads, rel, ctx);
    expect(mapped.inReplyTo).toBe('Forwarded context: please critique the ranker approach.');
  });

  it('prefers the done follow-up over a dispatch when both exist', () => {
    const ctx: InboundContext = {
      queueItems: [doneFollowUp],
      dispatches: [{ sourceThreadId: 't1', body: 'dispatch body', createdAt: '2026-07-11T09:30:00.000Z' }],
    };
    const [mapped] = mapInboundReminders([reminder({ bac_id: 'r1' })], wsThreads, rel, ctx);
    expect(mapped.inReplyTo).toBe('Can you compare this with the alternative design?');
  });

  it('omits "in reply to" when there is neither follow-up nor dispatch (never fabricates)', () => {
    const [mapped] = mapInboundReminders([reminder({ bac_id: 'r1' })], wsThreads, rel, {});
    expect(mapped.inReplyTo).toBeUndefined();
    // Still shows the workstream label.
    expect(mapped.workstreamLabel).toBe('MVP / PRD');
  });

  it('omits the workstream label for an ungrouped thread', () => {
    const [mapped] = mapInboundReminders(
      [reminder({ bac_id: 'r1', threadId: 't2' })],
      wsThreads,
      rel,
      {},
    );
    expect(mapped.workstreamLabel).toBeUndefined();
  });

  it('ignores a done follow-up dated AFTER the reply (can\'t answer the unsent)', () => {
    const laterFollowUp: QueueItem = {
      ...doneFollowUp,
      updatedAt: '2026-07-11T10:05:00.000Z', // after detectedAt 10:00
    };
    const ctx: InboundContext = { queueItems: [laterFollowUp] };
    const [mapped] = mapInboundReminders([reminder({ bac_id: 'r1' })], wsThreads, rel, ctx);
    expect(mapped.inReplyTo).toBeUndefined();
  });

  it('surfaces an in-memory reply snippet, and skips it when absent', () => {
    const withSnippet = mapInboundReminder(reminder({ bac_id: 'r1' }), wsThreads, rel, {
      replySnippetByReminderId: { r1: 'Here is the comparison you asked for…' },
    });
    expect(withSnippet?.replySnippet).toBe('Here is the comparison you asked for…');
    const withoutSnippet = mapInboundReminder(reminder({ bac_id: 'r1' }), wsThreads, rel, {});
    expect(withoutSnippet?.replySnippet).toBeUndefined();
  });

  it('resolveInReplyTo returns undefined with no candidates', () => {
    expect(resolveInReplyTo('t1', '2026-07-11T10:00:00.000Z', [], [])).toBeUndefined();
  });

  it('null-safe: no context arg still produces a valid card (no context line)', () => {
    const [mapped] = mapInboundReminders([reminder({ bac_id: 'r1' })], threads, rel);
    expect(mapped.workstreamLabel).toBeUndefined();
    expect(mapped.inReplyTo).toBeUndefined();
    expect(mapped.threadTitle).toBe('State machine review');
  });
});

const queueItem = (over: Partial<QueueItem> & Pick<QueueItem, 'bac_id'>): QueueItem => ({
  text: 'ask',
  scope: 'thread',
  status: 'pending',
  createdAt: '2026-07-11T10:00:00.000Z',
  updatedAt: '2026-07-11T10:00:00.000Z',
  ...over,
});

describe('groupQueueItems — §13 step 9', () => {
  const queueThreads = [{ bac_id: 't1', title: 'State machine review', provider: 'claude' }];
  const queueWorkstreams = [{ bac_id: 'w1', title: 'MVP PRD' }];

  it('groups pending items by target and resolves labels', () => {
    const groups = groupQueueItems(
      [
        queueItem({ bac_id: 'q1', scope: 'thread', targetId: 't1', createdAt: 'a' }),
        queueItem({ bac_id: 'q2', scope: 'thread', targetId: 't1', createdAt: 'b' }),
        queueItem({ bac_id: 'q3', scope: 'workstream', targetId: 'w1', createdAt: 'c' }),
      ],
      queueThreads,
      queueWorkstreams,
    );
    const threadGroup = groups.find((g) => g.targetId === 't1');
    expect(threadGroup?.label).toBe('State machine review');
    expect(threadGroup?.provider).toBe('claude');
    expect(threadGroup?.items).toHaveLength(2);
    const wsGroup = groups.find((g) => g.targetId === 'w1');
    expect(wsGroup?.label).toBe('MVP PRD');
  });

  it('excludes non-pending items', () => {
    const groups = groupQueueItems(
      [
        queueItem({ bac_id: 'q1', targetId: 't1', status: 'done' }),
        queueItem({ bac_id: 'q2', targetId: 't1', status: 'dismissed' }),
      ],
      queueThreads,
      queueWorkstreams,
    );
    expect(groups).toHaveLength(0);
  });

  it('labels a global-scope group and an unresolved target with fallbacks', () => {
    const groups = groupQueueItems(
      [
        queueItem({ bac_id: 'q1', scope: 'global', targetId: undefined }),
        queueItem({ bac_id: 'q2', scope: 'thread', targetId: 'gone' }),
      ],
      queueThreads,
      queueWorkstreams,
    );
    const global = groups.find((g) => g.scope === 'global');
    expect(global?.label).toBe('Anywhere');
    const orphan = groups.find((g) => g.targetId === 'gone');
    expect(orphan?.label).toBe('Unknown thread');
  });
});
