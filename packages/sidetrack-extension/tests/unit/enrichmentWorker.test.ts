import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runTitleEnrichment,
  selectJunkTitledThreads,
  SUBMITTED_STORAGE_KEY,
} from '../../src/sidepanel/nano/enrichmentWorker';

// A backing-map chrome.storage.local stub (same shape as ProducerPin's).
const installChromeStub = (): Record<string, unknown> => {
  const backing: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in backing ? { [key]: backing[key] } : {}),
        set: async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) backing[k] = v;
        },
        remove: async (key: string) => {
          delete backing[key];
        },
      },
    },
  };
  return backing;
};

const installNano = (prompt: () => Promise<string> = async () => 'A synthesized title') => {
  const destroy = vi.fn();
  const create = vi.fn(async () => ({ prompt, destroy }));
  (globalThis as { LanguageModel?: unknown }).LanguageModel = {
    availability: async () => 'available',
    create,
  };
  return { create, destroy };
};

const LONG_MD = 'User: how do I analyze CloudTrail logs across accounts?\n'.repeat(4);

afterEach(() => {
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
  delete (globalThis as Record<string, unknown>)['chrome'];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('selectJunkTitledThreads', () => {
  it('keeps empty / URL-shaped / ≥3-recurring titles and drops unique real titles', () => {
    const threads = [
      { bac_id: 't1', title: 'ChatGPT' },
      { bac_id: 't2', title: 'ChatGPT' },
      { bac_id: 't3', title: 'ChatGPT' },
      { bac_id: 't4', title: 'A real specific title' },
      { bac_id: 't5', title: '' },
      { bac_id: 't6', title: 'https://example.com/x' },
    ];
    const junk = selectJunkTitledThreads(threads, 10);
    expect(junk.map((t) => t.bac_id)).toEqual(['t1', 't2', 't3', 't5', 't6']);
  });

  it('respects the limit', () => {
    const threads = Array.from({ length: 8 }, (_, i) => ({ bac_id: `t${String(i)}`, title: '' }));
    expect(selectJunkTitledThreads(threads, 3)).toHaveLength(3);
  });
});

describe('runTitleEnrichment', () => {
  beforeEach(() => {
    installChromeStub();
    installNano();
  });

  const wireFetch = (opts?: {
    accepted?: number;
    skipped?: number;
    postOk?: boolean;
  }): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/threads')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { bac_id: 't1', title: 'ChatGPT' },
              { bac_id: 't2', title: 'ChatGPT' },
              { bac_id: 't3', title: 'ChatGPT' },
              { bac_id: 't4', title: 'A real specific title' },
            ],
          }),
        };
      }
      if (url.includes('/markdown')) {
        return { ok: true, status: 200, json: async () => ({ data: { markdown: LONG_MD } }) };
      }
      if (url.endsWith('/v1/enrichment/titles')) {
        void init;
        return {
          ok: opts?.postOk ?? true,
          status: opts?.postOk === false ? 500 : 200,
          json: async () => ({ accepted: opts?.accepted ?? 3, skipped: opts?.skipped ?? 0 }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('synthesizes the junk threads and POSTs one batch with the frozen shape + auth', async () => {
    const fetchMock = wireFetch({ accepted: 3, skipped: 0 });
    const stats = await runTitleEnrichment({ port: 17_374, bridgeKey: 'k', budget: 10 });

    expect(stats).toEqual({ generated: 3, accepted: 3, skipped: 0 });

    const post = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/v1/enrichment/titles'));
    expect(post).toBeDefined();
    const init = post?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-bac-bridge-key']).toBe('k');
    const body = JSON.parse(init.body as string) as {
      items: {
        kind: string;
        id: string;
        synthesizedTitle: string;
        sourceContentHash: string;
        model: string;
        generatedAt: string;
      }[];
    };
    expect(body.items).toHaveLength(3);
    for (const item of body.items) {
      expect(item.kind).toBe('thread');
      expect(item.model).toBe('gemini-nano');
      expect(item.synthesizedTitle).toBe('A synthesized title');
      expect(item.sourceContentHash).toMatch(/^[0-9a-f]+$/u);
      expect(item.synthesizedTitle.length).toBeLessThanOrEqual(200);
      expect(item.sourceContentHash.length).toBeLessThanOrEqual(64);
      expect(typeof item.generatedAt).toBe('string');
    }
    // Only the 3 junk threads were fetched for markdown (unique title skipped).
    expect(body.items.map((i) => i.id).sort()).toEqual(['t1', 't2', 't3']);
  });

  it('records submitted hashes and a re-run skips resubmission (dedup by hash)', async () => {
    const backing = installChromeStub();
    installNano();
    wireFetch({ accepted: 3, skipped: 0 });

    const first = await runTitleEnrichment({ port: 17_374, bridgeKey: 'k', budget: 10 });
    expect(first.generated).toBe(3);
    const stored = backing[SUBMITTED_STORAGE_KEY] as string[];
    expect(stored).toHaveLength(3);

    // Second run: same content → same hashes → all skipped, nothing POSTed.
    const fetch2 = wireFetch({ accepted: 3, skipped: 0 });
    const second = await runTitleEnrichment({ port: 17_374, bridgeKey: 'k', budget: 10 });
    expect(second).toEqual({ generated: 0, accepted: 0, skipped: 3 });
    expect(
      fetch2.mock.calls.some((c) => String(c[0]).endsWith('/v1/enrichment/titles')),
    ).toBe(false);
  });

  it('respects the budget (≤ budget threads synthesized)', async () => {
    installChromeStub();
    installNano();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/threads')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: Array.from({ length: 20 }, (_, i) => ({ bac_id: `t${String(i)}`, title: '' })),
          }),
        };
      }
      if (url.includes('/markdown')) {
        // Unique content per thread so hashes differ (no dedup interference).
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { markdown: `${LONG_MD} ${url}` } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ accepted: 2, skipped: 0 }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const stats = await runTitleEnrichment({ port: 17_374, bridgeKey: 'k', budget: 2 });
    expect(stats.generated).toBe(2);
    const mdCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/markdown'));
    expect(mdCalls).toHaveLength(2);
  });

  it('returns zeros without POSTing when Nano is not available', async () => {
    installChromeStub();
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: async () => 'downloadable',
      create: vi.fn(),
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const stats = await runTitleEnrichment({ port: 17_374, bridgeKey: 'k' });
    expect(stats).toEqual({ generated: 0, accepted: 0, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not record hashes when the POST fails', async () => {
    const backing = installChromeStub();
    installNano();
    wireFetch({ postOk: false });
    const stats = await runTitleEnrichment({ port: 17_374, bridgeKey: 'k', budget: 10 });
    expect(stats).toEqual({ generated: 3, accepted: 0, skipped: 0 });
    expect(backing[SUBMITTED_STORAGE_KEY]).toBeUndefined();
  });
});
