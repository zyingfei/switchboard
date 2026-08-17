import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCategoryFlexibilityClient } from '../../src/companion/categoryFlexibilityClient';

const client = () => createCategoryFlexibilityClient({ port: 17373, bridgeKey: 'bridge-secret' });

type CapturedRequest = { readonly url: string; readonly method: string; readonly key: string | null; readonly body: unknown };

const capture = (response: unknown, status = 200) => {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = input instanceof Request ? input.url : input.toString();
    requests.push({
      url: requestUrl,
      method: init?.method ?? 'GET',
      key: new Headers(init?.headers).get('x-bac-bridge-key'),
      body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    return Promise.resolve(new Response(JSON.stringify(response), { status }));
  });
  return requests;
};

describe('CategoryFlexibilityClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listMemberships reads and filters malformed rows', async () => {
    const requests = capture({
      data: {
        memberships: [
          { workstreamId: 'ws-1', role: 'secondary', provenance: 'user-filed', acceptedAtMs: 1000 },
          { workstreamId: 'ws-bad' }, // missing required fields — dropped
        ],
      },
    });

    const rows = await client().listMemberships('https://example.test/a');
    expect(rows).toEqual([
      { workstreamId: 'ws-1', role: 'secondary', provenance: 'user-filed', acceptedAtMs: 1000 },
    ]);
    expect(requests[0]?.url).toBe(
      'http://127.0.0.1:17373/v1/visits/https%3A%2F%2Fexample.test%2Fa/memberships',
    );
    expect(requests[0]?.key).toBe('bridge-secret');
  });

  it('addMembership POSTs workstreamId with an idempotency-key header', async () => {
    const requests = capture({ data: { accepted: {} } }, 201);
    await client().addMembership('https://example.test/a', 'ws-2');
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.body).toMatchObject({ workstreamId: 'ws-2' });
    // role omitted -> companion default 'secondary'; no bogus fields sent.
    expect(requests[0]?.body).not.toHaveProperty('role');
  });

  it('addMembership forwards role/suggestionSource/servedOpportunityId when provided', async () => {
    const requests = capture({ data: { accepted: {} } }, 201);
    await client().addMembership('https://example.test/a', 'ws-2', {
      role: 'primary',
      suggestionSource: 'workstream-split',
      servedOpportunityId: 'laneopp_deadbeef00000000000000000000000000',
    });
    expect(requests[0]?.body).toMatchObject({
      workstreamId: 'ws-2',
      role: 'primary',
      suggestionSource: 'workstream-split',
      servedOpportunityId: 'laneopp_deadbeef00000000000000000000000000',
    });
  });

  it('removeMembership POSTs to the per-workstream remove route with a default reason', async () => {
    const requests = capture({ data: { accepted: {} } }, 201);
    await client().removeMembership('https://example.test/a', 'ws-2');
    expect(requests[0]?.url).toContain('/memberships/ws-2/remove');
    expect(requests[0]?.body).toEqual({ reason: 'user-removed' });
  });

  it('splitSuggestionsFor reads emitted candidates scoped to a workstream', async () => {
    const requests = capture({
      data: {
        candidates: [
          {
            kind: 'split',
            scopeId: 'ws-1',
            fingerprint: 'a b',
            memberIds: ['a', 'b'],
            memberCount: 2,
            suggestedName: 'kv-cache recsys',
            updatedAt: 5000,
          },
        ],
      },
    });
    const candidates = await client().splitSuggestionsFor('ws-1');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.suggestedName).toBe('kv-cache recsys');
    expect(requests[0]?.url).toBe(
      'http://127.0.0.1:17373/v1/workstreams/suggestions?kind=split&workstreamId=ws-1',
    );
  });

  it('newCategorySuggestions reads the unfiled-pool candidates', async () => {
    const requests = capture({
      data: {
        candidates: [
          {
            kind: 'new-category',
            scopeId: '__unfiled__',
            fingerprint: 'x y',
            memberIds: ['x', 'y'],
            memberCount: 2,
            suggestedName: null,
            updatedAt: 6000,
          },
        ],
      },
    });
    const candidates = await client().newCategorySuggestions();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.suggestedName).toBeNull();
    expect(requests[0]?.url).toBe(
      'http://127.0.0.1:17373/v1/workstreams/suggestions?kind=new-category',
    );
  });

  it('declineSuggestionCandidate includes workstreamId only for kind=split', async () => {
    const requests = capture({ data: { dismissed: true } }, 201);
    await client().declineSuggestionCandidate({
      kind: 'split',
      fingerprint: 'a b',
      scopeId: 'ws-1',
    });
    expect(requests[0]?.body).toEqual({ kind: 'split', fingerprint: 'a b', workstreamId: 'ws-1' });

    const requests2 = capture({ data: { dismissed: true } }, 201);
    await client().declineSuggestionCandidate({ kind: 'new-category', fingerprint: 'x y' });
    expect(requests2[0]?.body).toEqual({ kind: 'new-category', fingerprint: 'x y' });
  });

  it('prototypeStatuses reads the per-workstream status list', async () => {
    capture({
      data: {
        statuses: [
          {
            workstreamId: 'ws-1',
            prototypeCount: 3,
            generatedAt: 7000,
            evidenceCount: 12,
            evidenceWatermark: '12:abc',
            engine: 'apple-fm#reason=ok',
            engineLabel: 'Apple Intelligence',
            method: 'generated',
            methodNote: null,
            whyNot: null,
            whyNotDetail: null,
          },
        ],
      },
    });
    const statuses = await client().prototypeStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ workstreamId: 'ws-1', prototypeCount: 3, engine: 'apple-fm#reason=ok' });
  });

  it('throws the problem detail message on a non-2xx response', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: 'workstreamId query param is required when kind=split.' }), {
          status: 400,
        }),
      ),
    );
    await expect(client().splitSuggestionsFor('')).rejects.toThrow(
      'workstreamId query param is required when kind=split.',
    );
  });
});
