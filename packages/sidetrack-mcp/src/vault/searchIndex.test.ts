import { describe, expect, it } from 'vitest';

import type { LiveVaultSnapshot } from './liveVaultReader.js';
import { buildIndex, searchIndex } from './searchIndex.js';

const snapshot = (generatedAt = '2026-05-01T00:00:00.000Z'): LiveVaultSnapshot => ({
  generatedAt,
  workstreams: [],
  events: [],
  threads: [
    {
      bac_id: 'bac_thread_exact',
      title: 'Live migration design',
      threadUrl: 'https://claude.ai/chat/live-migration',
      provider: 'claude',
      tags: ['architecture'],
    },
    {
      bac_id: 'bac_thread_partial',
      title: 'Design notes',
      threadUrl: 'https://chatgpt.com/c/notes',
      provider: 'chatgpt',
      tags: ['migration'],
    },
  ],
  queueItems: [
    {
      bac_id: 'bac_queue_1',
      text: 'Ask about migrating old vault projections',
      scope: 'thread',
      targetId: 'bac_thread_exact',
      status: 'pending',
    },
  ],
  reminders: [
    {
      bac_id: 'bac_reminder_1',
      threadId: 'bac_thread_exact',
      provider: 'claude',
      status: 'new',
    },
  ],
});

describe('searchIndex', () => {
  it('returns exact title matches ahead of partial field matches', () => {
    const hits = searchIndex(snapshot(), 'live migration');

    expect(hits[0]).toMatchObject({ kind: 'thread', id: 'bac_thread_exact' });
    expect(hits[0]?.score ?? 0).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it('normalizes simple stems', () => {
    const hits = searchIndex(snapshot(), 'migrating');

    expect(hits.some((hit) => hit.id === 'bac_thread_partial')).toBe(true);
    expect(hits.some((hit) => hit.id === 'bac_queue_1')).toBe(true);
  });

  it('returns no hits for an empty query', () => {
    expect(searchIndex(snapshot(), '   ')).toEqual([]);
  });

  it('reuses the cached index while snapshot.generatedAt is unchanged', () => {
    const source = snapshot('2026-05-01T01:00:00.000Z');

    expect(buildIndex(source)).toBe(buildIndex(source));
    expect(buildIndex(source)).not.toBe(buildIndex(snapshot('2026-05-01T02:00:00.000Z')));
  });
});
