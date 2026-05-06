import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installChromeStorage = (): Map<string, unknown> => {
  const values = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (defaults: Record<string, unknown>) => {
          // chrome.storage.local.get({ key: fallback }) returns
          // either the stored value or the fallback, per the real
          // API contract. The stub mirrors that.
          const out: Record<string, unknown> = {};
          for (const [key, fallback] of Object.entries(defaults)) {
            out[key] = values.has(key) ? values.get(key) : fallback;
          }
          return Promise.resolve(out);
        },
        set: (next: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(next)) {
            values.set(key, value);
          }
          return Promise.resolve();
        },
      },
    },
  });
  return values;
};

describe('review-draft pending clientDeps', () => {
  beforeEach(() => {
    installChromeStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('chains queued events: each new ClientEvent observes the prior pending ids', async () => {
    const state = await import('../../src/background/state');
    // First edit while offline. The helper writes the queued event
    // and pushes its id onto the pending list.
    await state.enqueueLocalReviewDraftEvent('thread-1', 'https://example.test/t', {
      clientEventId: 'evt-1',
      type: 'review-draft.overall.set',
      payload: { text: 'A' },
    });
    expect(await state.readReviewDraftPending('thread-1')).toEqual(['evt-1']);

    // Second edit before the first is accepted. The helper attaches
    // `clientDeps: ['evt-1']` so the companion stamps deps that
    // covers evt-1 — preventing self-conflict.
    await state.enqueueLocalReviewDraftEvent('thread-1', 'https://example.test/t', {
      clientEventId: 'evt-2',
      type: 'review-draft.overall.set',
      payload: { text: 'B' },
    });
    expect(await state.readReviewDraftPending('thread-1')).toEqual(['evt-1', 'evt-2']);

    const queue = await (
      await import('../../src/review/outbox')
    ).readReviewDraftQueue();
    const events = queue.map((item) => item.payload.event);
    expect(events[0]?.clientDeps).toBeUndefined();
    expect(events[1]?.clientDeps).toEqual(['evt-1']);
  });

  it('markReviewDraftEventAccepted drops the id from the pending list', async () => {
    const state = await import('../../src/background/state');
    await state.enqueueLocalReviewDraftEvent('thread-1', 'url', {
      clientEventId: 'evt-1',
      type: 'review-draft.overall.set',
      payload: { text: 'A' },
    });
    await state.enqueueLocalReviewDraftEvent('thread-1', 'url', {
      clientEventId: 'evt-2',
      type: 'review-draft.overall.set',
      payload: { text: 'B' },
    });
    await state.markReviewDraftEventAccepted('thread-1', 'evt-1');
    expect(await state.readReviewDraftPending('thread-1')).toEqual(['evt-2']);

    // A third edit after evt-1 was acked depends only on the still-
    // pending evt-2.
    await state.enqueueLocalReviewDraftEvent('thread-1', 'url', {
      clientEventId: 'evt-3',
      type: 'review-draft.overall.set',
      payload: { text: 'C' },
    });
    const queue = await (await import('../../src/review/outbox')).readReviewDraftQueue();
    const evt3 = queue.find((item) => item.payload.event.clientEventId === 'evt-3');
    expect(evt3?.payload.event.clientDeps).toEqual(['evt-2']);
  });

  it('per-thread pending lists are isolated', async () => {
    const state = await import('../../src/background/state');
    await state.enqueueLocalReviewDraftEvent('thread-A', 'url', {
      clientEventId: 'a-1',
      type: 'review-draft.overall.set',
      payload: { text: 'A' },
    });
    await state.enqueueLocalReviewDraftEvent('thread-B', 'url', {
      clientEventId: 'b-1',
      type: 'review-draft.overall.set',
      payload: { text: 'B' },
    });
    expect(await state.readReviewDraftPending('thread-A')).toEqual(['a-1']);
    expect(await state.readReviewDraftPending('thread-B')).toEqual(['b-1']);
  });
});
