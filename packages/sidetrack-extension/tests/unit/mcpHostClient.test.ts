import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addServer } from '../../src/mcpHost/registry';
import { callTool, listTools, TimeoutError, TransportError } from '../../src/mcpHost/client';

const installChromeStorage = (): void => {
  const values = new Map<string, unknown>();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: values.get(key) }),
        set: (next: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(next)) {
            values.set(key, value);
          }
          return Promise.resolve();
        },
      },
    },
  });
};

describe('MCP host client', () => {
  beforeEach(async () => {
    installChromeStorage();
    await addServer({ id: 'local', url: 'https://mcp.example.test', transport: 'http' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lists tools and calls tools over HTTP transport', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const requestUrl = input instanceof Request ? input.url : input.toString();
      requests.push(requestUrl);
      return Promise.resolve(
        new Response(
          JSON.stringify(
            requestUrl.endsWith('/tools/list')
              ? { tools: [{ name: 'search' }] }
              : { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } },
          ),
          { status: 200 },
        ),
      );
    });

    await expect(listTools('local')).resolves.toEqual([{ name: 'search' }]);
    await expect(callTool({ serverId: 'local', tool: 'search', input: { q: 'x' } })).resolves.toEqual({
      ok: true,
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true },
    });
    expect(requests).toEqual([
      'https://mcp.example.test/tools/list',
      'https://mcp.example.test/tools/call',
    ]);
  });

  it('rejects SSE transport for this slice', async () => {
    await addServer({ id: 'stream', url: 'https://mcp.example.test', transport: 'sse' });

    await expect(listTools('stream')).rejects.toBeInstanceOf(TransportError);
  });

  it('surfaces request timeouts as TimeoutError', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    const pending = expect(listTools('local')).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);

    await pending;
  });
});
