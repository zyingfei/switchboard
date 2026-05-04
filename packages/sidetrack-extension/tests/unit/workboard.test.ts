import { describe, expect, it } from 'vitest';

import {
  companionStatusLabel,
  compareQueueItems,
  initialWorkboardSections,
  maskTitleForPrivacy,
  type QueueItem,
  type TrackedThread,
  type WorkstreamNode,
} from '../../src/workboard';

const queueItem = (overrides: Partial<QueueItem> & Pick<QueueItem, 'bac_id'>): QueueItem => ({
  bac_id: overrides.bac_id,
  text: overrides.text ?? 't',
  scope: overrides.scope ?? 'thread',
  status: overrides.status ?? 'pending',
  createdAt: overrides.createdAt ?? '2026-05-04T20:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-05-04T20:00:00.000Z',
  ...(overrides.targetId === undefined ? {} : { targetId: overrides.targetId }),
  ...(overrides.sortOrder === undefined ? {} : { sortOrder: overrides.sortOrder }),
  ...(overrides.lastError === undefined ? {} : { lastError: overrides.lastError }),
  ...(overrides.progress === undefined ? {} : { progress: overrides.progress }),
});

describe('workboard scaffold', () => {
  it('defines the six M1 workboard sections in display order', () => {
    expect(initialWorkboardSections.map((section) => section.id)).toEqual([
      'current-tab',
      'active-work',
      'queued',
      'inbound',
      'needs-organize',
      'recent-search',
    ]);
  });

  it('maps companion status to side-panel copy', () => {
    expect(companionStatusLabel('connected')).toBe('vault: synced');
    expect(companionStatusLabel('disconnected')).toBe('vault: disconnected');
    expect(companionStatusLabel('vault-error')).toBe('vault: unreachable');
    expect(companionStatusLabel('local-only')).toBe('local-only');
  });

  describe('compareQueueItems', () => {
    it('falls back to createdAt when neither item has a sortOrder', () => {
      const a = queueItem({ bac_id: 'a', createdAt: '2026-05-04T20:00:00.000Z' });
      const b = queueItem({ bac_id: 'b', createdAt: '2026-05-04T21:00:00.000Z' });
      expect([b, a].sort(compareQueueItems).map((i) => i.bac_id)).toEqual(['a', 'b']);
    });

    it('honors sortOrder over createdAt when both are stamped', () => {
      const a = queueItem({
        bac_id: 'a',
        createdAt: '2026-05-04T20:00:00.000Z',
        sortOrder: 2,
      });
      const b = queueItem({
        bac_id: 'b',
        createdAt: '2026-05-04T21:00:00.000Z',
        sortOrder: 0,
      });
      const c = queueItem({
        bac_id: 'c',
        createdAt: '2026-05-04T22:00:00.000Z',
        sortOrder: 1,
      });
      expect([a, b, c].sort(compareQueueItems).map((i) => i.bac_id)).toEqual(['b', 'c', 'a']);
    });

    it('puts stamped items before unstamped ones in the transient mixed state', () => {
      const ranked = queueItem({ bac_id: 'ranked', sortOrder: 0 });
      const unranked = queueItem({
        bac_id: 'unranked',
        createdAt: '2024-01-01T00:00:00.000Z',
      });
      expect([unranked, ranked].sort(compareQueueItems).map((i) => i.bac_id)).toEqual([
        'ranked',
        'unranked',
      ]);
    });
  });

  it('masks screenshare-sensitive workstreams only while screenshare mode is enabled', () => {
    const thread: TrackedThread = {
      bac_id: 'bac_thread',
      provider: 'claude',
      threadUrl: 'https://claude.ai/chat/thread',
      title: 'Visible title',
      lastSeenAt: '2026-05-03T20:16:00.000Z',
      status: 'active',
      trackingMode: 'auto',
      primaryWorkstreamId: 'bac_ws',
      tags: [],
    };
    const workstreams: readonly WorkstreamNode[] = [
      {
        bac_id: 'bac_ws',
        revision: 'rev',
        title: 'Sensitive',
        children: [],
        tags: [],
        checklist: [],
        privacy: 'shared',
        screenShareSensitive: true,
        updatedAt: '2026-05-03T20:16:00.000Z',
      },
    ];

    expect(maskTitleForPrivacy(thread, workstreams, false)).toBe('Visible title');
    expect(maskTitleForPrivacy(thread, workstreams, true)).toBe('[private]');
    expect(maskTitleForPrivacy(thread, [{ ...workstreams[0], privacy: 'private' }], false)).toBe(
      '[private]',
    );
  });
});
