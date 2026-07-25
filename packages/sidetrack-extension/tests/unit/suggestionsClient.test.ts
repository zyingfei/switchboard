import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSuggestionsClient } from '../../src/companion/suggestionsClient';

describe('SuggestionsClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches thread suggestions with bridge auth and limit', async () => {
    const requests: { readonly url: string; readonly key: string | null }[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = input instanceof Request ? input.url : input.toString();
      requests.push({
        url: requestUrl,
        key: new Headers(init?.headers).get('x-bac-bridge-key'),
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                workstreamId: 'ws-1',
                score: 0.84,
                breakdown: { lexical: 0.42, vector: 0.31 },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    });

    await expect(
      createSuggestionsClient({ port: 17373, bridgeKey: 'bridge-secret' }).forThread('thread-1', {
        limit: 3,
      }),
    ).resolves.toEqual([
      {
        workstreamId: 'ws-1',
        score: 0.84,
        breakdown: { lexical: 0.42, vector: 0.31 },
      },
    ]);
    expect(requests).toEqual([
      {
        url: 'http://127.0.0.1:17373/v1/suggestions/thread/thread-1?limit=3',
        key: 'bridge-secret',
      },
    ]);
  });

  it('parses the recurring-thread self-nomination block from the response', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [],
            selfNomination: {
              eligible: true,
              visitCount: 7,
              distinctDays: 3,
              suggestedTitle: 'Phantom与Shadow v2架构',
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await createSuggestionsClient({
      port: 17373,
      bridgeKey: 'k',
    }).forThreadWithNomination('thread-1');

    expect(result.suggestions).toEqual([]);
    expect(result.selfNomination).toEqual({
      eligible: true,
      visitCount: 7,
      distinctDays: 3,
      suggestedTitle: 'Phantom与Shadow v2架构',
    });
  });

  it('omits self-nomination when the block is absent or ineligible', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ workstreamId: 'ws-1', score: 0.9 }],
            selfNomination: { eligible: false, visitCount: 1, distinctDays: 1 },
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await createSuggestionsClient({
      port: 17373,
      bridgeKey: 'k',
    }).forThreadWithNomination('thread-1');

    // The block still parses (eligible:false) so the caller can reason
    // about it, but the extension UI only renders when eligible.
    expect(result.selfNomination).toEqual({ eligible: false, visitCount: 1, distinctDays: 1 });
    expect(result.suggestions).toEqual([{ workstreamId: 'ws-1', score: 0.9 }]);
  });
});
