import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RemoteEngineError,
  remoteChatCompletionsUrl,
  remoteEngineFrom,
  remoteFailureCopy,
  remoteFailureKindOf,
  remoteReplyText,
  remoteRequestBody,
} from '../../src/sidepanel/nano/remoteEngine';
import {
  DEFAULT_REMOTE_BASE_URL,
  EMPTY_REMOTE_CONFIG,
  remoteConfigReady,
  type RemoteEngineConfig,
} from '../../src/sidepanel/nano/remoteConfig';
import {
  GENERATION_TEMPERATURE,
  GIST_GENERATION,
  GIST_MAX_NEW_TOKENS,
} from '../../src/sidepanel/nano/generationOptions';
import {
  __resetWebGpuEngineForTest,
  resolveReadyEngine,
} from '../../src/sidepanel/nano/engine';

// The OPTIONAL remote engine. Two things are on trial here: the wire shape (so a
// provider failure is a TYPED failure, not a mystery), and — much more
// importantly — the guarantee that this engine does not exist unless the user
// explicitly turned it on AND supplied a key.

const ARMED: RemoteEngineConfig = {
  enabled: true,
  baseUrl: DEFAULT_REMOTE_BASE_URL,
  model: 'gpt-4o-mini',
  apiKey: 'sk-test-abcdefghijkl',
};

const okReply = (content: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }) as unknown as Response;

const status = (code: number) =>
  ({
    ok: false,
    status: code,
    json: async () => ({}),
  }) as unknown as Response;

const chromeStub = (): void => {
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
};

beforeEach(() => {
  __resetWebGpuEngineForTest();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
});

afterEach(() => {
  __resetWebGpuEngineForTest();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
  delete (globalThis as Record<string, unknown>)['chrome'];
  vi.restoreAllMocks();
});

describe('remote adapter — the request it actually builds', () => {
  it('POSTs {baseUrl}/chat/completions with the key in Authorization and the tuned decoding', async () => {
    const fetchMock = vi.fn(async () => okReply('A factual summary of the page in question.'));
    const engine = remoteEngineFrom(ARMED, fetchMock);
    expect(engine).not.toBeNull();
    const out = await engine?.generate('the prompt', GIST_GENERATION);
    expect(out).toBe('A factual summary of the page in question.');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test-abcdefghijkl');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o-mini');
    expect(body['messages']).toEqual([{ role: 'user', content: 'the prompt' }]);
    expect(body['temperature']).toBe(GENERATION_TEMPERATURE);
    expect(body['max_tokens']).toBe(GIST_MAX_NEW_TOKENS);
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(remoteChatCompletionsUrl('https://example.test/v1/')).toBe(
      'https://example.test/v1/chat/completions',
    );
  });

  it('applies the same output cleanup every other engine gets', async () => {
    const engine = remoteEngineFrom(ARMED, async () => okReply('**A wrapped summary of things.**'));
    expect(await engine?.generate('p', GIST_GENERATION)).toBe('A wrapped summary of things.');
  });

  it('declares its identity and limits so a comparison row can name them', () => {
    const engine = remoteEngineFrom(ARMED, async () => okReply('x'));
    expect(engine?.identity?.label).toBe('remote');
    expect(engine?.identity?.modelName).toBe('gpt-4o-mini');
    expect(engine?.limits?.maxInputChars).toBe(24_000);
  });

  it('remoteRequestBody is pure and assertable on its own', () => {
    const body = remoteRequestBody(ARMED, 'hello', GIST_GENERATION);
    expect(body).toMatchObject({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
    });
    // Never the key.
    expect(JSON.stringify(body)).not.toContain('sk-test');
  });
});

describe('remote adapter — every failure is TYPED', () => {
  const cases: readonly (readonly [number, string])[] = [
    [401, 'auth-failed'],
    [403, 'auth-failed'],
    [429, 'rate-limited'],
    [500, 'bad-response'],
    [404, 'bad-response'],
  ];
  for (const [code, kind] of cases) {
    it(`maps HTTP ${String(code)} to ${kind}`, async () => {
      const engine = remoteEngineFrom(ARMED, async () => status(code));
      await expect(engine?.generate('p', GIST_GENERATION)).rejects.toMatchObject({ kind });
    });
  }

  it('maps a fetch throw to network — and never leaks the key into the message', async () => {
    const engine = remoteEngineFrom(ARMED, async () => {
      throw new TypeError('Failed to fetch https://api.openai.com/v1 with Bearer sk-test-abcdefghijkl');
    });
    const err = await engine?.generate('p', GIST_GENERATION).catch((e: unknown) => e);
    expect(remoteFailureKindOf(err)).toBe('network');
    expect(String((err as Error).message)).not.toContain('sk-test');
  });

  it('maps a non-JSON body to bad-response', async () => {
    const engine = remoteEngineFrom(ARMED, async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    }) as unknown as Response);
    await expect(engine?.generate('p', GIST_GENERATION)).rejects.toMatchObject({
      kind: 'bad-response',
    });
  });

  it('maps a malformed (well-formed JSON, wrong shape) body to bad-response', async () => {
    const engine = remoteEngineFrom(ARMED, async () => ({
      ok: true,
      status: 200,
      json: async () => ({ nonsense: true }),
    }) as unknown as Response);
    await expect(engine?.generate('p', GIST_GENERATION)).rejects.toMatchObject({
      kind: 'bad-response',
    });
    expect(remoteReplyText({ choices: [] })).toBeNull();
    expect(remoteReplyText(null)).toBeNull();
  });

  it('passes an AbortSignal through and reports an abort as its own kind', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const engine = remoteEngineFrom(ARMED, fetchMock);
    await expect(engine?.generate('p', GIST_GENERATION, controller.signal)).rejects.toMatchObject({
      kind: 'aborted',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('every typed kind has its own human sentence', () => {
    const kinds = ['auth-failed', 'rate-limited', 'network', 'bad-response', 'aborted'] as const;
    const seen = new Set(kinds.map((k) => remoteFailureCopy(k)));
    expect(seen.size).toBe(kinds.length);
    for (const copy of seen) expect(copy.length).toBeGreaterThan(0);
    expect(remoteFailureKindOf(new Error('not ours'))).toBeNull();
    expect(remoteFailureKindOf(new RemoteEngineError('network', 'x'))).toBe('network');
  });
});

describe('remote engine — NEVER selected without an explicit opt-in AND a key', () => {
  it('does not exist for the default (off) config', () => {
    expect(remoteConfigReady(EMPTY_REMOTE_CONFIG)).toBe(false);
    expect(remoteEngineFrom(EMPTY_REMOTE_CONFIG, async () => okReply('x'))).toBeNull();
  });

  it('does not exist when enabled but keyless', () => {
    const config = { ...ARMED, apiKey: '   ' };
    expect(remoteConfigReady(config)).toBe(false);
    expect(remoteEngineFrom(config, async () => okReply('x'))).toBeNull();
  });

  it('does not exist when a key is stored but the switch was never flipped', () => {
    const config = { ...ARMED, enabled: false };
    expect(remoteConfigReady(config)).toBe(false);
    expect(remoteEngineFrom(config, async () => okReply('x'))).toBeNull();
  });

  it('resolveReadyEngine returns null when the stored config is disabled, even with a key', async () => {
    chromeStub();
    await (globalThis as unknown as {
      chrome: { storage: { local: { set: (e: Record<string, unknown>) => Promise<void> } } };
    }).chrome.storage.local.set({
      'sidetrack.remoteEngine.v1': { ...ARMED, enabled: false },
    });
    expect(await resolveReadyEngine(undefined)).toBeNull();
  });

  it('resolveReadyEngine picks it up ONLY once enabled with a key — and after the on-device engines', async () => {
    chromeStub();
    await (globalThis as unknown as {
      chrome: { storage: { local: { set: (e: Record<string, unknown>) => Promise<void> } } };
    }).chrome.storage.local.set({ 'sidetrack.remoteEngine.v1': ARMED });
    expect((await resolveReadyEngine(undefined))?.kind).toBe('remote');
    // Nano is resident and free — it must still win.
    const nanoLm = {
      availability: async () => 'available',
      create: vi.fn(async () => ({ prompt: async () => 'a title', destroy: vi.fn() })),
    };
    expect((await resolveReadyEngine(nanoLm))?.kind).toBe('nano');
  });
});
