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
});
