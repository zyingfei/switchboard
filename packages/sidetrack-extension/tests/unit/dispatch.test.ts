import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpDispatchClient } from '../../src/dispatch/client';
import {
  mapUiPacketKind,
  mapUiTarget,
  providerIdToDispatchProvider,
} from '../../src/dispatch/types';

describe('dispatch type mappings', () => {
  it('maps UI packet kinds to companion kinds', () => {
    expect(mapUiPacketKind('research_packet')).toBe('research');
    expect(mapUiPacketKind('coding_agent_packet')).toBe('coding');
    expect(mapUiPacketKind('context_pack')).toBe('note');
    expect(mapUiPacketKind('notebook_export')).toBe('note');
  });

  it('maps UI targets to companion providers', () => {
    expect(mapUiTarget('gpt_pro')).toBe('chatgpt');
    expect(mapUiTarget('deep_research')).toBe('chatgpt');
    expect(mapUiTarget('claude')).toBe('claude');
    expect(mapUiTarget('claude_code')).toBe('claude_code');
    expect(mapUiTarget('notebook')).toBe('other');
    expect(mapUiTarget('markdown')).toBe('other');
  });

  it('maps captured provider ids to dispatch providers', () => {
    expect(providerIdToDispatchProvider('chatgpt')).toBe('chatgpt');
    expect(providerIdToDispatchProvider('claude')).toBe('claude');
    expect(providerIdToDispatchProvider('gemini')).toBe('gemini');
    expect(providerIdToDispatchProvider('unknown')).toBe('other');
  });
});

describe('HttpDispatchClient', () => {
  const settings = { port: 31415, bridgeKey: 'bridge-key-test' } as const;
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    fetchSpy.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it('submits a dispatch with bridge-key auth and idempotency-key header', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: { bac_id: 'disp_abc', status: 'recorded' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = new HttpDispatchClient(settings);
    const result = await client.submit(
      {
        kind: 'research',
        target: { provider: 'claude', mode: 'paste' },
        title: 'Sidetrack PRD §24.10',
        body: 'Body content for dispatch.',
      },
      'idem-key-1',
    );

    expect(result.bac_id).toBe('disp_abc');
    expect(result.status).toBe('recorded');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:31415/v1/dispatches');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('x-bac-bridge-key')).toBe('bridge-key-test');
    expect(headers.get('idempotency-key')).toBe('idem-key-1');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('captures token-budget warnings in the submit result', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { bac_id: 'disp_warn', status: 'recorded', tokenEstimate: 9001 },
          warnings: ['token-budget-exceeded'],
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );

    const client = new HttpDispatchClient(settings);
    const result = await client.submit(
      {
        kind: 'research',
        target: { provider: 'claude', mode: 'paste' },
        title: 'Long packet',
        body: 'x'.repeat(40_000),
      },
      'idem-key-2',
    );

    expect(result.warnings).toEqual(['token-budget-exceeded']);
    expect(result.tokenEstimate).toBe(9001);
  });

  it('throws with the problem detail message on non-2xx responses', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'urn:problem:companion:vault-unavailable',
          title: 'Vault not reachable',
          status: 503,
          code: 'VAULT_UNAVAILABLE',
          correlationId: 'corr-123',
          detail: 'Vault path was not writable.',
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ),
    );

    const client = new HttpDispatchClient(settings);
    await expect(
      client.submit(
        {
          kind: 'note',
          target: { provider: 'claude', mode: 'paste' },
          title: 'X',
          body: 'X',
        },
        'idem-key-3',
      ),
    ).rejects.toThrow('Vault path was not writable.');
  });

  it('lists recent dispatches with limit and since query params', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              bac_id: 'disp_1',
              kind: 'research',
              target: { provider: 'claude', mode: 'paste' },
              title: 'A',
              body: 'A',
              createdAt: '2026-04-26T10:00:00Z',
              redactionSummary: { matched: 0, categories: [] },
              tokenEstimate: 100,
              status: 'sent',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const client = new HttpDispatchClient(settings);
    const list = await client.listRecent({ limit: 10, since: '2026-04-25T00:00:00Z' });

    expect(list).toHaveLength(1);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/dispatches?');
    expect(url).toContain('limit=10');
    expect(url).toContain('since=2026-04-25T00%3A00%3A00Z');
  });
});
