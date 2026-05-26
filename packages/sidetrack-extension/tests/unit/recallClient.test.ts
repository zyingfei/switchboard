import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRecallClient } from '../../src/companion/recallClient';

const settings = { port: 17_373, bridgeKey: 'test-bridge-key' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RecallClient', () => {
  it('indexTurns POSTs the entire batch in one request', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { indexed: 3 } }),
      }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const client = createRecallClient(settings);
    const items = [
      { id: 't:0', threadId: 't', capturedAt: '2026-05-05T00:00:00Z', text: 'one' },
      { id: 't:1', threadId: 't', capturedAt: '2026-05-05T00:00:00Z', text: 'two' },
      { id: 't:2', threadId: 't', capturedAt: '2026-05-05T00:00:00Z', text: 'three' },
    ];
    await client.indexTurns(items);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const init = calls[0][1];
    const rawBody = typeof init.body === 'string' ? init.body : '';
    const body = JSON.parse(rawBody) as { items: typeof items };
    expect(body.items).toEqual(items);
  });

  it('indexTurns is a no-op for an empty batch (no fetch call)', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const client = createRecallClient(settings);
    await client.indexTurns([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('indexTurnsCoalesced collapses concurrent calls into one POST (FU1)', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { indexed: 4 } }),
        }),
      ) as unknown as typeof fetch;
      vi.stubGlobal('fetch', fetchMock);

      const { indexTurnsCoalesced } = await import('../../src/companion/recallClient');
      const itemsA = [
        { id: 'A:0', threadId: 'A', capturedAt: '2026-05-05T00:00:00Z', text: 'a0' },
        { id: 'A:1', threadId: 'A', capturedAt: '2026-05-05T00:00:00Z', text: 'a1' },
      ];
      const itemsB = [
        { id: 'B:0', threadId: 'B', capturedAt: '2026-05-05T00:00:01Z', text: 'b0' },
        { id: 'B:1', threadId: 'B', capturedAt: '2026-05-05T00:00:01Z', text: 'b1' },
      ];
      const a = indexTurnsCoalesced(settings, itemsA);
      const b = indexTurnsCoalesced(settings, itemsB);
      // Both calls land inside the 200ms COALESCE_WINDOW_MS; nothing
      // should fire until the timer drains.
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      await Promise.all([a, b]);
      // ONE coalesced POST with both batches merged.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock
        .calls[0][1];
      const body = JSON.parse(init.body as string) as { items: typeof itemsA };
      expect(body.items).toHaveLength(4);
      expect(body.items.map((i) => i.id)).toEqual(['A:0', 'A:1', 'B:0', 'B:1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('indexTurn delegates to indexTurns for a single item', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const client = createRecallClient(settings);
    await client.indexTurn({
      id: 't:0',
      threadId: 't',
      capturedAt: '2026-05-05T00:00:00Z',
      text: 'one',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const init = calls[0][1];
    const rawBody = typeof init.body === 'string' ? init.body : '';
    const body = JSON.parse(rawBody) as { items: readonly unknown[] };
    expect(body.items).toHaveLength(1);
  });
});
