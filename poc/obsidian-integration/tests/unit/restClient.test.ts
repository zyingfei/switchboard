import { describe, expect, it } from 'vitest';
import { ObsidianRestClient, ObsidianRestError } from '../../src/obsidian/restClient';

describe('ObsidianRestClient', () => {
  it('sends bearer auth and exact frontmatter patch headers accepted by the real plugin', async () => {
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
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Operation')).toBe('replace');
    expect(headers.get('Target-Type')).toBe('frontmatter');
    expect(headers.get('Target')).toBe('project');
    expect(headers.get('Create-Target-If-Missing')).toBe('true');
    expect(call?.init.body).toBe('"SwitchBoard"');
  });

  it('uses exact markdown content type for PUT and heading PATCH requests', async () => {
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

    await client.writeFile('_BAC/inbox/Test.md', '# Test');
    await client.patchHeading('_BAC/inbox/Test.md', 'Notes', '- Appended');

    const putHeaders = new Headers(calls[0]?.init.headers);
    const patchHeaders = new Headers(calls[1]?.init.headers);
    expect(putHeaders.get('Content-Type')).toBe('text/markdown');
    expect(patchHeaders.get('Content-Type')).toBe('text/markdown');
    expect(patchHeaders.get('Operation')).toBe('append');
    expect(patchHeaders.get('Target-Type')).toBe('heading');
    expect(patchHeaders.get('Target')).toBe('Notes');
  });

  it('includes Obsidian error detail when the plugin rejects a request', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errorCode: 40012, message: 'Unknown or invalid Content-Type specified.' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
        },
      })) as typeof fetch;
    const client = new ObsidianRestClient(
      {
        baseUrl: 'http://127.0.0.1:27124',
        apiKey: 'secret',
      },
      fetchImpl,
    );

    await expect(client.writeFile('Test.md', '# Test')).rejects.toMatchObject({
      name: 'ObsidianRestError',
      status: 400,
      detail: 'Unknown or invalid Content-Type specified. (40012)',
      message: 'Obsidian REST request failed: 400 - Unknown or invalid Content-Type specified. (40012)',
    });
  });
});
