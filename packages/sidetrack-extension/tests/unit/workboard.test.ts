import { describe, expect, it } from 'vitest';

import {
  companionStatusLabel,
  initialWorkboardSections,
  maskTitleForPrivacy,
  type TrackedThread,
  type WorkstreamNode,
} from '../../src/workboard';

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
