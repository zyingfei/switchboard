import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCompanionClient } from '../../src/companion/client';

const settings = { port: 51234, bridgeKey: 'test-key' };

// Minimal Response-like stub for the client's `await response.json()`
// + `response.ok` path.
const jsonResponse = (body: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    headers: new Headers(),
    json: async () => body,
  }) as unknown as Response;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exportWorkstream — §13 step 13 client contract', () => {
  it('POSTs to the tree-path route and returns the written file paths', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        jsonResponse({ data: { files: [{ path: 'Sidetrack/MVP-PRD/report1.md' }] } }),
      );
    const client = createCompanionClient(settings);

    const paths = await client.exportWorkstream('ws-1', { includeThreads: true });

    expect(paths).toEqual(['Sidetrack/MVP-PRD/report1.md']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:51234/v1/workstreams/ws-1/export');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ includeThreads: true });
  });

  it('sends an empty body when no options are given', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ data: { files: [] } }));
    const client = createCompanionClient(settings);

    await client.exportWorkstream('ws-1');

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({});
  });

  it('exportThread hits the thread route', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ data: { files: [{ path: 'Sidetrack/threads/t.md' }] } }));
    const client = createCompanionClient(settings);

    const paths = await client.exportThread('t-9');

    expect(paths).toEqual(['Sidetrack/threads/t.md']);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:51234/v1/threads/t-9/export');
  });

  it('throws when the response shape is malformed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: {} }));
    const client = createCompanionClient(settings);

    await expect(client.exportWorkstream('ws-1')).rejects.toThrow(/files array/);
  });
});
