import { describe, expect, it } from 'vitest';

import {
  drainReviewDraftOutbox,
  enqueueReviewDraftEvent,
  readReviewDraftQueue,
  type QueuedReviewDraftEvent,
} from '../../src/review/outbox';
import type { OutboxStorage } from '../../src/companion/outbox';

const memoryStorage = (): OutboxStorage => {
  const values = new Map<string, unknown>();
  return {
    get(key, fallback) {
      return Promise.resolve((values.has(key) ? values.get(key) : fallback) as typeof fallback);
    },
    set(next) {
      Object.entries(next).forEach(([k, v]) => values.set(k, v));
      return Promise.resolve();
    },
  };
};

describe('review-draft outbox', () => {
  it('enqueueReviewDraftEvent stores typed events with a UUID outbox id and a baseVector', async () => {
    const storage = memoryStorage();
    await enqueueReviewDraftEvent(
      'thread-1',
      'https://example.test/1',
      {
        clientEventId: 'evt-1',
        type: 'review-draft.span.added',
        baseVector: { 'host-a': 5 },
        payload: { spanId: 's1', anchor: {}, quote: 'hi', comment: '' },
      },
      storage,
    );
    const queue = await readReviewDraftQueue(storage);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.payload.threadId).toBe('thread-1');
    expect(queue[0]?.payload.event.type).toBe('review-draft.span.added');
    expect(queue[0]?.payload.event.baseVector).toEqual({ 'host-a': 5 });
    expect(queue[0]?.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('drainReviewDraftOutbox passes the queued event + outbox id to send and clears on success', async () => {
    const storage = memoryStorage();
    await enqueueReviewDraftEvent(
      't',
      'url',
      { clientEventId: 'a', type: 'review-draft.span.added', baseVector: {}, payload: {} },
      storage,
    );
    await enqueueReviewDraftEvent(
      't',
      'url',
      {
        clientEventId: 'b',
        type: 'review-draft.span.removed',
        baseVector: {},
        payload: { spanId: 'x' },
      },
      storage,
    );

    const seen: { queued: QueuedReviewDraftEvent; key: string }[] = [];
    const result = await drainReviewDraftOutbox(
      (queued, key) => {
        seen.push({ queued, key });
        return Promise.resolve();
      },
      { storage, ignoreBackoff: true },
    );
    expect(result).toEqual({ sent: 2, remaining: 0 });
    expect(seen.map((entry) => entry.queued.event.type)).toEqual([
      'review-draft.span.added',
      'review-draft.span.removed',
    ]);
    for (const entry of seen) {
      expect(entry.key).toMatch(/^[0-9a-f-]{36}$/i);
    }
    expect(await readReviewDraftQueue(storage)).toHaveLength(0);
  });

  it('drainReviewDraftOutbox leaves failing items behind for the next pass', async () => {
    const storage = memoryStorage();
    await enqueueReviewDraftEvent(
      't',
      'url',
      { clientEventId: 'a', type: 'review-draft.span.added', baseVector: {}, payload: {} },
      storage,
    );
    await enqueueReviewDraftEvent(
      't',
      'url',
      {
        clientEventId: 'b',
        type: 'review-draft.span.removed',
        baseVector: {},
        payload: { spanId: 'x' },
      },
      storage,
    );
    const result = await drainReviewDraftOutbox(
      (queued) => {
        if (queued.event.type === 'review-draft.span.removed') {
          return Promise.reject(new Error('offline'));
        }
        return Promise.resolve();
      },
      { storage, ignoreBackoff: true },
    );
    expect(result).toEqual({ sent: 1, remaining: 1 });
    const remaining = await readReviewDraftQueue(storage);
    expect(remaining[0]?.payload.event.type).toBe('review-draft.span.removed');
    expect(remaining[0]?.attempts).toBe(1);
  });

  it('drainReviewDraftOutbox preserves FIFO order when an earlier causal dependency fails', async () => {
    const storage = memoryStorage();
    await enqueueReviewDraftEvent(
      't',
      'url',
      {
        clientEventId: 'a',
        type: 'review-draft.overall.set',
        baseVector: {},
        payload: { text: 'A' },
      },
      storage,
    );
    await enqueueReviewDraftEvent(
      't',
      'url',
      {
        clientEventId: 'b',
        type: 'review-draft.overall.set',
        baseVector: {},
        clientDeps: ['a'],
        payload: { text: 'B' },
      },
      storage,
    );

    const seen: string[] = [];
    const result = await drainReviewDraftOutbox(
      (queued) => {
        seen.push(queued.event.clientEventId);
        return Promise.reject(new Error('companion unavailable'));
      },
      { storage, ignoreBackoff: true },
    );

    const remaining = await readReviewDraftQueue(storage);
    expect(result).toEqual({ sent: 0, remaining: 2 });
    expect(seen).toEqual(['a']);
    expect(remaining.map((entry) => entry.payload.event.clientEventId)).toEqual(['a', 'b']);
    expect(remaining.map((entry) => entry.attempts)).toEqual([1, 0]);
  });
});
