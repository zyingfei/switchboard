import { describe, expect, it } from 'vitest';

import {
  canScopeToWorkstream,
  resolveQueueScope,
  type QueueScopeThreadLite,
} from '../../src/sidepanel/queued/queueScopeChoice';

// §13 step 4 — the queue-compose scope selector. These pin the mapping
// from the composer's UI choice onto the QueueCreate scope/targetId that
// the background handler forwards verbatim to the companion route (and
// that groupQueueItems buckets on). The existing thread-scope path must
// stay byte-identical; workstream + global are the new options.

const thread: QueueScopeThreadLite = { bac_id: 't1', primaryWorkstreamId: 'w1' };
const orphanThread: QueueScopeThreadLite = { bac_id: 't2' };

describe('resolveQueueScope — §13 step 4', () => {
  it('thread choice keeps the current behavior (scope thread, targetId = thread)', () => {
    expect(resolveQueueScope('thread', thread, 'ask')).toEqual({
      text: 'ask',
      scope: 'thread',
      targetId: 't1',
    });
  });

  it('workstream choice rolls up to the thread home workstream', () => {
    expect(resolveQueueScope('workstream', thread, 'ask')).toEqual({
      text: 'ask',
      scope: 'workstream',
      targetId: 'w1',
    });
  });

  it('global choice drops the targetId', () => {
    const item = resolveQueueScope('global', thread, 'ask');
    expect(item).toEqual({ text: 'ask', scope: 'global' });
    expect('targetId' in item).toBe(false);
  });

  it('workstream choice on a thread with no workstream falls back to thread scope', () => {
    // Defends the wire contract — the selector shouldn't offer the
    // option, but if a stale choice reaches here we must not emit a
    // workstream-scoped item with no targetId.
    expect(resolveQueueScope('workstream', orphanThread, 'ask')).toEqual({
      text: 'ask',
      scope: 'thread',
      targetId: 't2',
    });
  });

  it('carries the trimmed text through verbatim', () => {
    expect(resolveQueueScope('global', thread, 'multi word ask').text).toBe('multi word ask');
  });
});

describe('canScopeToWorkstream — §13 step 4', () => {
  it('is true when the thread has a home workstream', () => {
    expect(canScopeToWorkstream(thread)).toBe(true);
  });

  it('is false when the thread has no workstream', () => {
    expect(canScopeToWorkstream(orphanThread)).toBe(false);
  });

  it('is false for an empty-string workstream id', () => {
    expect(canScopeToWorkstream({ bac_id: 't3', primaryWorkstreamId: '' })).toBe(false);
  });
});
