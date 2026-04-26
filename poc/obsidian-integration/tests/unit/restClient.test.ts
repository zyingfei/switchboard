import { describe, expect, it } from 'vitest';
import { ObsidianRestClient } from '../../src/obsidian/restClient';

describe('ObsidianRestClient', () => {
  it('sends bearer auth and frontmatter patch headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const client = new ObsidianRestClient(
      {
        baseUrl: 'http://127.0.0.1:27124/',
        apiKey: 'secret',
      },
      fetchImpl,
    );

    await client.patchFrontmatter('_BAC/inbox/Test.md', 'project', 'SwitchBoard');

    const call = calls[0];
    const headers = new Headers(call?.init.headers);
    expect(call?.url).toBe('http://127.0.0.1:27124/vault/_BAC/inbox/Test.md');
    expect(call?.init.method).toBe('PATCH');
    expect(headers.get('Authorization')).toBe('Bearer secret');
    expect(headers.get('Target-Type')).toBe('frontmatter');
    expect(headers.get('Target')).toBe('project');
    expect(call?.init.body).toBe('"SwitchBoard"');
  });
});
