import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserTimelineObservedPayload } from '../../../src/timeline/events';
import { createDefaultTimelineDrainHook } from '../../../src/timeline/materializer';
import type { SpoolEntry } from '../../../src/sync/spool';

// Reviewer F4: the drain hook must treat
// skipped[reason='already-imported'] as ACKED. The dot is on the
// companion (a previous POST landed but the response was lost on the
// way back; or the same archive was re-imported). Anything else in
// `skipped` (invalid-event-type / invalid-payload / arbitrary error)
// stays in the spool for the next attempt.

const buildEntry = (seq: number): SpoolEntry<BrowserTimelineObservedPayload> => ({
  edgeDot: { replicaId: 'edge_test', seq },
  clientEventId: `evt-${String(seq)}`,
  surface: 'timeline',
  payload: {
    eventId: `evt-${String(seq)}`,
    observedAt: '2026-05-07T10:00:00.000Z',
    url: 'https://x/a',
    transition: 'activated',
  },
  state: 'spooled',
  createdAt: '2026-05-07T10:00:00.000Z',
  lastTransitionAt: '2026-05-07T10:00:00.000Z',
});

const stubFetch = (
  response: { status: number; body: unknown },
): { mock: ReturnType<typeof vi.fn>; restore: () => void } => {
  const original = globalThis.fetch;
  const mock = vi.fn(async () => {
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;
  return {
    mock,
    restore: () => {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
    },
  };
};

describe('createDefaultTimelineDrainHook — already-imported is acked', () => {
  let restore: (() => void) | null = null;
  beforeEach(() => {
    restore = null;
  });
  afterEach(() => {
    if (restore !== null) restore();
    restore = null;
  });

  it('imported dots are returned as uploaded', async () => {
    const stub = stubFetch({
      status: 200,
      body: { data: { imported: [{ replicaId: 'edge_test', seq: 1 }], skipped: [] } },
    });
    restore = stub.restore;
    const hook = createDefaultTimelineDrainHook({
      companionUrl: 'http://127.0.0.1:9999',
      bridgeKey: 'k',
    });
    const result = await hook([buildEntry(1)]);
    expect(result.uploaded).toEqual([{ replicaId: 'edge_test', seq: 1 }]);
  });

  it('already-imported skipped entries ARE returned as uploaded', async () => {
    const stub = stubFetch({
      status: 200,
      body: {
        data: {
          imported: [],
          skipped: [{ replicaId: 'edge_test', seq: 1, reason: 'already-imported' }],
        },
      },
    });
    restore = stub.restore;
    const hook = createDefaultTimelineDrainHook({
      companionUrl: 'http://127.0.0.1:9999',
      bridgeKey: 'k',
    });
    const result = await hook([buildEntry(1)]);
    expect(result.uploaded).toEqual([{ replicaId: 'edge_test', seq: 1 }]);
  });

  it('invalid-event-type / invalid-payload skipped entries are NOT acked', async () => {
    const stub = stubFetch({
      status: 200,
      body: {
        data: {
          imported: [{ replicaId: 'edge_test', seq: 1 }],
          skipped: [
            { replicaId: 'edge_test', seq: 2, reason: 'invalid-event-type' },
            { replicaId: 'edge_test', seq: 3, reason: 'invalid-payload' },
          ],
        },
      },
    });
    restore = stub.restore;
    const hook = createDefaultTimelineDrainHook({
      companionUrl: 'http://127.0.0.1:9999',
      bridgeKey: 'k',
    });
    const result = await hook([buildEntry(1), buildEntry(2), buildEntry(3)]);
    expect(result.uploaded).toEqual([{ replicaId: 'edge_test', seq: 1 }]);
  });

  it('imported + already-imported are folded together in uploaded', async () => {
    const stub = stubFetch({
      status: 200,
      body: {
        data: {
          imported: [{ replicaId: 'edge_test', seq: 1 }],
          skipped: [{ replicaId: 'edge_test', seq: 2, reason: 'already-imported' }],
        },
      },
    });
    restore = stub.restore;
    const hook = createDefaultTimelineDrainHook({
      companionUrl: 'http://127.0.0.1:9999',
      bridgeKey: 'k',
    });
    const result = await hook([buildEntry(1), buildEntry(2)]);
    expect(result.uploaded.map((d) => d.seq).sort()).toEqual([1, 2]);
  });

  it('non-OK HTTP status throws', async () => {
    const stub = stubFetch({
      status: 503,
      body: { error: 'service unavailable' },
    });
    restore = stub.restore;
    const hook = createDefaultTimelineDrainHook({
      companionUrl: 'http://127.0.0.1:9999',
      bridgeKey: 'k',
    });
    await expect(hook([buildEntry(1)])).rejects.toThrow('timeline drain HTTP 503');
  });
});
