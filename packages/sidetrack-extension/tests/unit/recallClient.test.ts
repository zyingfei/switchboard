import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRecallClient } from '../../src/companion/recallClient';

const settings = { port: 17_373, bridgeKey: 'test-bridge-key' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RecallClient', () => {
  it('indexTurns POSTs the entire batch in one request', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { indexed: 3 } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const client = createRecallClient(settings);
    const items = [
      { id: 't:0', threadId: 't', capturedAt: '2026-05-05T00:00:00Z', text: 'one' },
      { id: 't:1', threadId: 't', capturedAt: '2026-05-05T00:00:00Z', text: 'two' },
      { id: 't:2', threadId: 't', capturedAt: '2026-05-05T00:00:00Z', text: 'three' },
    ];
    await client.indexTurns(items);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    const body = JSON.parse(String(init.body)) as { items: typeof items };
    expect(body.items).toEqual(items);
  });

  it('indexTurns is a no-op for an empty batch (no fetch call)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const client = createRecallClient(settings);
    await client.indexTurns([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('indexTurn delegates to indexTurns for a single item', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const client = createRecallClient(settings);
    await client.indexTurn({ id: 't:0', threadId: 't', capturedAt: '2026-05-05T00:00:00Z', text: 'one' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    const body = JSON.parse(String(init.body)) as { items: readonly unknown[] };
    expect(body.items).toHaveLength(1);
  });
});
