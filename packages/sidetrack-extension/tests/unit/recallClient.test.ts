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

  it('indexTurn delegates to indexTurns for a single item', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const client = createRecallClient(settings);
    await client.indexTurn({ id: 't:0', threadId: 't', capturedAt: '2026-05-05T00:00:00Z', text: 'one' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const init = calls[0][1];
    const rawBody = typeof init.body === 'string' ? init.body : '';
    const body = JSON.parse(rawBody) as { items: readonly unknown[] };
    expect(body.items).toHaveLength(1);
  });

  it('query preserves stable bac_id and human metadata from recall results', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              {
                id: 'chunk:provider-thread:0:0:abc',
                threadId: '69fcb926-3a98-8328-bbe4-baee4da7fbef',
                bacId: 'QMPG4BZ0SQC1HMJ0',
                capturedAt: '2026-05-14T05:04:59.674Z',
                score: 0.42,
                title: 'Switchboard - Correctness audit findings',
                provider: 'chatgpt',
                threadUrl: 'https://chatgpt.com/c/69fcb926-3a98-8328-bbe4-baee4da7fbef',
                snippet: 'relevant remembered text',
              },
            ],
          }),
      }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const client = createRecallClient(settings);
    await expect(client.query('correctness audit')).resolves.toEqual([
      {
        id: 'chunk:provider-thread:0:0:abc',
        threadId: '69fcb926-3a98-8328-bbe4-baee4da7fbef',
        bacId: 'QMPG4BZ0SQC1HMJ0',
        capturedAt: '2026-05-14T05:04:59.674Z',
        score: 0.42,
        title: 'Switchboard - Correctness audit findings',
        provider: 'chatgpt',
        threadUrl: 'https://chatgpt.com/c/69fcb926-3a98-8328-bbe4-baee4da7fbef',
        snippet: 'relevant remembered text',
      },
    ]);
  });
});
