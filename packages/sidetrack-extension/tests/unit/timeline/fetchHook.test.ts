import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDefaultTimelineFetchHook,
  resetTimelineMaterializerStateForTests,
  setCompanionReachableForTimeline,
  setTimelineFetchHook,
  timelinePluginMaterializer,
} from '../../../src/timeline/materializer';

// Reviewer RV3: fetchExtended must actually call the companion. The
// previous implementation returned an empty list regardless of
// state, which silently broke the "companion-extended" claim.

const stubFetch = (
  responses: Array<{ status: number; body: unknown }>,
): { mock: ReturnType<typeof vi.fn>; restore: () => void } => {
  const original = globalThis.fetch;
  let i = 0;
  const mock = vi.fn(async () => {
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    return new Response(JSON.stringify(r?.body ?? {}), {
      status: r?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = mock as unknown as typeof fetch;
  return {
    mock,
    restore: () => {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
    },
  };
};

describe('createDefaultTimelineFetchHook', () => {
  let restore: (() => void) | null = null;
  beforeEach(() => {
    restore = null;
    resetTimelineMaterializerStateForTests();
    setTimelineFetchHook(null);
  });
  afterEach(() => {
    if (restore !== null) restore();
    restore = null;
  });

  it('builds the right URL with q + limit query params', async () => {
    const stub = stubFetch([{ status: 200, body: { data: { scope: 'companion-extended', items: [] } } }]);
    restore = stub.restore;
    const hook = createDefaultTimelineFetchHook({
      companionUrl: 'http://127.0.0.1:9999',
      bridgeKey: 'k',
    });
    await hook({ q: 'recipe', limit: 25 });
    expect(stub.mock.mock.calls).toHaveLength(1);
    const [url] = stub.mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/timeline?');
    expect(url).toContain('q=recipe');
    expect(url).toContain('limit=25');
  });

  it('returns the companion items unchanged inside scope envelope', async () => {
    const stub = stubFetch([
      {
        status: 200,
        body: {
          data: {
            scope: 'companion-extended',
            items: [
              {
                id: 'https://x/a',
                date: '2026-05-07',
                firstSeenAt: '2026-05-07T10:00:00.000Z',
                lastSeenAt: '2026-05-07T11:00:00.000Z',
                url: 'https://x/a',
                visitCount: 2,
              },
            ],
          },
        },
      },
    ]);
    restore = stub.restore;
    const hook = createDefaultTimelineFetchHook({
      companionUrl: 'http://127.0.0.1:9999',
      bridgeKey: 'k',
    });
    const result = await hook({});
    expect(result.scope).toBe('companion-extended');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.url).toBe('https://x/a');
    expect(result.items[0]?.visitCount).toBe(2);
  });

  it('non-OK HTTP throws (caller maps to unreachable scope)', async () => {
    const stub = stubFetch([{ status: 500, body: {} }]);
    restore = stub.restore;
    const hook = createDefaultTimelineFetchHook({
      companionUrl: 'http://127.0.0.1:9999',
      bridgeKey: 'k',
    });
    await expect(hook({})).rejects.toThrow('timeline fetch HTTP 500');
  });
});

describe('timelinePluginMaterializer.fetchExtended', () => {
  beforeEach(() => {
    resetTimelineMaterializerStateForTests();
    setTimelineFetchHook(null);
  });

  it('returns plugin-active-only-companion-unreachable when companion is offline', async () => {
    setCompanionReachableForTimeline(false);
    const result = await timelinePluginMaterializer.fetchExtended({});
    expect(result.scope).toBe('plugin-active-only-companion-unreachable');
    expect(result.items).toHaveLength(0);
  });

  it('returns companion-extended with synthesized observations when reachable', async () => {
    setCompanionReachableForTimeline(true);
    setTimelineFetchHook(async () => ({
      scope: 'companion-extended',
      items: [
        {
          id: 'https://chatgpt.com/c/abc',
          date: '2026-05-07',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T11:00:00.000Z',
          url: 'https://chatgpt.com/c/abc',
          canonicalUrl: 'https://chatgpt.com/c/abc',
          title: 'My chat',
          provider: 'chatgpt',
          visitCount: 3,
        },
      ],
    }));
    const result = await timelinePluginMaterializer.fetchExtended({});
    expect(result.scope).toBe('companion-extended');
    expect(result.items).toHaveLength(1);
    const obs = result.items[0]!.payload;
    // Synthesized observation: lastSeenAt → observedAt; transition
    // is 'updated'. visitCount + firstSeenAt are NOT preserved (the
    // ActiveTimelineObservation shape doesn't carry them).
    expect(obs.eventId).toBe('https://chatgpt.com/c/abc');
    expect(obs.observedAt).toBe('2026-05-07T11:00:00.000Z');
    expect(obs.transition).toBe('updated');
    expect(obs.title).toBe('My chat');
    expect(obs.provider).toBe('chatgpt');
  });

  it('falls back to unreachable scope when fetchHook throws', async () => {
    setCompanionReachableForTimeline(true);
    setTimelineFetchHook(async () => {
      throw new Error('connection refused');
    });
    const result = await timelinePluginMaterializer.fetchExtended({});
    expect(result.scope).toBe('plugin-active-only-companion-unreachable');
    expect(result.items).toHaveLength(0);
  });
});
