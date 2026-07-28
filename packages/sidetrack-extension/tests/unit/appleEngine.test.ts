import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appleChatCompletionsUrl,
  appleEngineFrom,
  appleFailureKindOf,
  appleReplyText,
  appleRequestBody,
  isUnsupportedLanguageError,
} from '../../src/sidepanel/nano/appleEngine';
import {
  APPLE_FALLBACK_CONTEXT_TOKENS,
  APPLE_GENERATION_PROBE_TIMEOUT_MS,
  APPLE_PROBE_TIMEOUT_MS,
  APPLE_SERVICE_ABSENT,
  appleMaxInputChars,
  appleModelEntry,
  appleUnavailableCopy,
  probeAppleService,
  type AppleServiceInfo,
} from '../../src/sidepanel/nano/appleService';
import { appleLimits } from '../../src/sidepanel/nano/engineLimits';
import { GIST_GENERATION } from '../../src/sidepanel/nano/generationOptions';
import {
  appleCanServe,
  routeEnrichmentEngine,
  type EngineAvailability,
} from '../../src/sidepanel/nano/language';
import {
  appleServiceStatus,
  setAppleProbeForTest,
} from '../../src/sidepanel/nano/engine';

// Apple Foundation Models — macOS 26's on-device ~3B model, reached through a
// local OpenAI-compatible service (apfel). Measured 2026-07-28 on M2/16GB
// against the SAME documents, prompts and scoring used to tune the WebGPU lane:
//
//   WebGPU gemma-1B q4   17.3s median   groundedness 0.47
//   Apple FM via apfel    4.1s median   groundedness 0.61
//
// These tests pin the things that measurement DISAGREED with the docs about,
// plus the safety properties that keep an on-device claim honest.

const UP: AppleServiceInfo = {
  available: true,
  contextTokens: 4096,
  modelId: 'apple-foundationmodel',
  reason: 'ok',
};

const okResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response;
const errResponse = (status: number, body: unknown = null): Response =>
  ({ ok: false, status, json: () => Promise.resolve(body) }) as unknown as Response;

afterEach(() => {
  // Restore the suite-wide absent stub (tests/setup.ts) so an available probe
  // installed here cannot leak into another file.
  setAppleProbeForTest(() => Promise.resolve(APPLE_SERVICE_ABSENT));
});

describe('apple service probe', () => {
  it('reads the LIVE context window rather than hardcoding 4096', async () => {
    // macOS 26 reports 4096 and macOS 27 reports 8192. A constant would throw
    // away half the window on a newer OS, silently.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        okResponse({ data: [{ id: 'apple-foundationmodel', context_window: 8192 }] }),
      ),
    );
    const info = await probeAppleService('http://localhost:11434/v1', fetchImpl);
    expect(info.available).toBe(true);
    expect(info.contextTokens).toBe(8192);
  });

  it('falls back to the documented window when the service omits one', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(okResponse({ data: [{ id: 'apple-foundationmodel' }] })),
    );
    expect((await probeAppleService('http://x/v1', fetchImpl)).contextTokens).toBe(
      APPLE_FALLBACK_CONTEXT_TOKENS,
    );
  });

  it('REFUSES a service on the right port that is not Apple', async () => {
    // 11434 is also Ollama's default. A bare 200 must not be enough, or page
    // text would route to whatever model Ollama happens to host — a different
    // engine wearing Apple's on-device privacy guarantees.
    const fetchImpl = vi.fn(() =>
      Promise.resolve(okResponse({ data: [{ id: 'llama3.2:3b' }] })),
    );
    const info = await probeAppleService('http://localhost:11434/v1', fetchImpl);
    expect(info.available).toBe(false);
    expect(info.reason).toBe('wrong-service');
  });

  it('reports not-running instead of throwing when the port is closed', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const info = await probeAppleService('http://localhost:11434/v1', fetchImpl);
    expect(info.available).toBe(false);
    expect(info.reason).toBe('not-running');
  });

  it('is NOT fooled by a service that lists models but refuses to generate', async () => {
    // THE LIVE TRAP, 2026-07-28. apfel enforces an origin allowlist, and a
    // browser sends `Origin` on a JSON POST but not on a simple GET. So
    // GET /v1/models returned 200 from the extension page while every
    // POST /chat/completions returned 403. A probe that only did the GET
    // reported the engine READY and then failed every gist — green tests,
    // broken feature. The probe must test what it claims.
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/models')
          ? okResponse({ data: [{ id: 'apple-foundationmodel', context_window: 4096 }] })
          : errResponse(403, {
              error: { message: "Origin 'chrome-extension://abc' is not allowed." },
            }),
      ),
    );
    const info = await probeAppleService('http://localhost:11434/v1', fetchImpl);
    expect(info.available).toBe(false);
    expect(info.reason).toBe('origin-blocked');
    // Both endpoints were exercised — the POST check is not skippable.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('probes generation with the SMALLEST possible request', async () => {
    // The check has to be real, but it must not cost a paragraph of inference
    // every 30 seconds.
    let genBody: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn((url: string, init: RequestInit) => {
      if (url.endsWith('/chat/completions')) {
        genBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Promise.resolve(okResponse({ choices: [{ message: { content: 'k' } }] }));
      }
      return Promise.resolve(
        okResponse({ data: [{ id: 'apple-foundationmodel', context_window: 4096 }] }),
      );
    });
    const info = await probeAppleService('http://localhost:11434/v1', fetchImpl);
    expect(info.available).toBe(true);
    expect((genBody as unknown as Record<string, unknown> | null)?.['max_tokens']).toBe(1);
  });

  it('tells the user the actual fix when the origin is blocked', () => {
    expect(appleUnavailableCopy('origin-blocked')).toContain('--allowed-origins');
  });

  it('gives the COLD generation probe its own, much longer budget', async () => {
    // THE SECOND LIVE TRAP, and it was self-inflicted. The generation probe was
    // added to catch an origin-blocked service, but it inherited the LIVENESS
    // timeout (1500ms). A cold Apple Foundation Models session is spun up by
    // the OS on first use:
    //
    //     GET         0.0006s
    //     POST cold   6.96s
    //     POST warm   0.33s
    //
    // So the probe aborted every time the panel opened, reported
    // 'not-running', and the engine was invisible — while apfel's own log
    // showed the request completing 200. Verifying the ENDPOINT is not the
    // same as verifying the SHIPPED CODE PATH.
    expect(APPLE_GENERATION_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(APPLE_PROBE_TIMEOUT_MS).toBeLessThan(APPLE_GENERATION_PROBE_TIMEOUT_MS);

    // And the budgets must be SEPARATE signals, not one shared controller:
    // a 7s POST under a 1.5s liveness deadline is exactly the original bug.
    const signals: (AbortSignal | undefined)[] = [];
    const fetchImpl = vi.fn((url: string, init: RequestInit) => {
      signals.push(init.signal ?? undefined);
      return Promise.resolve(
        url.endsWith('/models')
          ? okResponse({ data: [{ id: 'apple-foundationmodel', context_window: 4096 }] })
          : okResponse({ choices: [{ message: { content: 'k' } }] }),
      );
    });
    await probeAppleService('http://localhost:11434/v1', fetchImpl);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it('survives a slow cold start that exceeds the LIVENESS budget', async () => {
    // The regression in one case: the generation takes longer than the
    // liveness timeout and the service must still come back available.
    const fetchImpl = vi.fn((url: string) => {
      if (url.endsWith('/models')) {
        return Promise.resolve(
          okResponse({ data: [{ id: 'apple-foundationmodel', context_window: 4096 }] }),
        );
      }
      return new Promise<Response>((resolve) => {
        setTimeout(() => { resolve(okResponse({ choices: [{ message: { content: 'k' } }] })); }, 60);
      });
    });
    // Liveness 10ms (would have killed the 60ms generation under one budget),
    // generation 5000ms.
    const info = await probeAppleService('http://x/v1', fetchImpl, 10, 5_000);
    expect(info.available).toBe(true);
    expect(info.reason).toBe('ok');
  });

  it('prints a PASTEABLE command when it knows the extension id', () => {
    // "<this extension id>" is a puzzle; the real id is an instruction.
    const copy = appleUnavailableCopy('origin-blocked', 'abcdefghijklmnop');
    expect(copy).toContain('chrome-extension://abcdefghijklmnop');
    expect(copy).not.toContain('<this extension id>');
  });

  it('picks the foundation-model entry out of a multi-model list', () => {
    const entry = appleModelEntry({
      data: [{ id: 'some-other' }, { id: 'apple-foundationmodel', context_window: 4096 }],
    });
    expect(entry?.id).toBe('apple-foundationmodel');
  });

  it('leaves input headroom for the answer rather than spending the whole window', () => {
    // The window has to hold the document AND the reply; spending it all on
    // input guarantees a truncated answer.
    expect(appleMaxInputChars(4096)).toBeLessThan(4096 * 4);
    expect(appleMaxInputChars(4096)).toBeGreaterThan(0);
  });
});

describe('apple engine — construction and wire shape', () => {
  it('does not exist when the service is absent', () => {
    expect(appleEngineFrom(APPLE_SERVICE_ABSENT)).toBeNull();
  });

  it('sends ONLY the parameters apfel accepts', async () => {
    // Measured against apfel 1.8.4: temperature/max_tokens/top_p -> 200,
    // frequency_penalty -> 400. apfel REJECTS unknown params rather than
    // ignoring them, so a stray field fails the whole request.
    const body = appleRequestBody('apple-foundationmodel', 'summarize this', GIST_GENERATION);
    expect(Object.keys(body).sort()).toEqual(
      ['max_tokens', 'messages', 'model', 'temperature', 'top_p'].sort(),
    );
    expect(body['frequency_penalty']).toBeUndefined();
    expect(body['repetition_penalty']).toBeUndefined();
    expect(body['no_repeat_ngram_size']).toBeUndefined();
  });

  it('sends a chat MESSAGE, not a bare string', () => {
    // An instruction-tuned model handed a raw string continues it instead of
    // answering — the 2026-07-27 degenerate-gist root cause.
    const body = appleRequestBody('m', 'PROMPT', GIST_GENERATION);
    expect(body['messages']).toEqual([{ role: 'user', content: 'PROMPT' }]);
  });

  it('sends NO Authorization header — there is no key and no account', async () => {
    let seenInit: RequestInit | null = null;
    const fetchImpl = vi.fn((_u: string, init: RequestInit) => {
      seenInit = init;
      return Promise.resolve(
        okResponse({ choices: [{ message: { content: 'A factual summary of the page.' } }] }),
      );
    });
    const engine = appleEngineFrom(UP, fetchImpl);
    await engine?.generate('doc', GIST_GENERATION);
    const headers = (seenInit as unknown as RequestInit | null)?.headers as
      | Record<string, string>
      | undefined;
    expect(headers).toBeDefined();
    expect(Object.keys(headers ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('only ever talks to loopback', () => {
    expect(appleChatCompletionsUrl('http://localhost:11434/v1')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
    expect(appleChatCompletionsUrl('http://localhost:11434/v1/')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
  });

  it('returns the assistant text on success', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(okResponse({ choices: [{ message: { content: 'Netflix uses MediaConnect.' } }] })),
    );
    const engine = appleEngineFrom(UP, fetchImpl);
    expect(await engine?.generate('doc', GIST_GENERATION)).toBe('Netflix uses MediaConnect.');
  });

  it('is identified as its own on-device kind, never as remote', () => {
    // Filing Apple under 'remote' would inherit that lane's "text left the
    // device" framing and understate the privacy property.
    expect(appleEngineFrom(UP)?.kind).toBe('apple');
    expect(appleEngineFrom(UP)?.identity?.kind).toBe('apple');
  });
});

describe('apple engine — the language disagreement', () => {
  it('recognizes the unsupported-language 400 as its own recoverable kind', async () => {
    // Apple ADVERTISES zh in its model notes and then refuses it. Measured:
    //   {"error":{"message":"Unsupported language: An unsupported language or
    //     locale was used","type":"invalid_request_error"}}
    const payload = {
      error: { message: 'Unsupported language: An unsupported language or locale was used' },
    };
    expect(isUnsupportedLanguageError(payload)).toBe(true);

    const fetchImpl = vi.fn(() => Promise.resolve(errResponse(400, payload)));
    const engine = appleEngineFrom(UP, fetchImpl);
    const err = await engine?.generate('中文内容', GIST_GENERATION).catch((e: unknown) => e);
    expect(appleFailureKindOf(err)).toBe('unsupported-language');
  });

  it('does not mistake an ordinary 400 for a language problem', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(errResponse(400, { error: { message: 'bad parameter: frequency_penalty' } })),
    );
    const engine = appleEngineFrom(UP, fetchImpl);
    const err = await engine?.generate('doc', GIST_GENERATION).catch((e: unknown) => e);
    expect(appleFailureKindOf(err)).toBe('bad-response');
  });

  it('reports a vanished service distinctly from a bad reply', async () => {
    const gone = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const engineGone = appleEngineFrom(UP, gone);
    const err = await engineGone?.generate('doc', GIST_GENERATION).catch((e: unknown) => e);
    expect(appleFailureKindOf(err)).toBe('service-gone');
  });

  it('English only — the advertised language list is NOT the routing rule', () => {
    expect(appleCanServe('en')).toBe(true);
    expect(appleCanServe('zh')).toBe(false);
    expect(appleCanServe('mixed-en-zh')).toBe(false);
  });
});

describe('apple engine — routing precedence', () => {
  const base: EngineAvailability = {
    nanoReady: false,
    webGpuLoaded: false,
    webGpuSupported: true,
  };

  it('outranks WebGPU for English', () => {
    expect(
      routeEnrichmentEngine('en', { ...base, appleReady: true, webGpuLoaded: true }),
    ).toEqual({ engine: 'apple' });
  });

  it('still loses to Nano, which needs nothing running at all', () => {
    expect(
      routeEnrichmentEngine('en', { ...base, nanoReady: true, appleReady: true }),
    ).toEqual({ engine: 'nano' });
  });

  it('NEVER takes Chinese — WebGPU stays the only lane that can', () => {
    expect(
      routeEnrichmentEngine('zh', { ...base, appleReady: true, webGpuLoaded: true }),
    ).toEqual({ engine: 'webgpu' });
  });

  it('names the language as the reason when Apple is up but cannot serve it', () => {
    // Otherwise the user sees a ready engine refuse to run and gets no reason.
    expect(
      routeEnrichmentEngine('zh', { ...base, appleReady: true, webGpuLoaded: false }),
    ).toEqual({ engine: null, reason: 'language-needs-local-model' });
  });

  it('still outranks the remote lane — on-device before off-device, always', () => {
    expect(
      routeEnrichmentEngine('en', { ...base, appleReady: true, remoteReady: true }),
    ).toEqual({ engine: 'apple' });
  });

  it('is simply absent when the service is not running', () => {
    expect(routeEnrichmentEngine('en', { ...base, webGpuLoaded: true })).toEqual({
      engine: 'webgpu',
    });
  });
});

describe('apple engine — probe caching', () => {
  it('does not re-probe within the TTL, and does when forced', async () => {
    let calls = 0;
    setAppleProbeForTest(() => {
      calls += 1;
      return Promise.resolve(UP);
    });
    await appleServiceStatus(false, 1_000);
    await appleServiceStatus(false, 2_000);
    expect(calls).toBe(1);
    await appleServiceStatus(true, 2_100);
    expect(calls).toBe(2);
  });

  it('re-probes after the TTL — the service can be stopped at any moment', async () => {
    let calls = 0;
    setAppleProbeForTest(() => {
      calls += 1;
      return Promise.resolve(UP);
    });
    await appleServiceStatus(false, 1_000);
    await appleServiceStatus(false, 1_000 + 60_000);
    expect(calls).toBe(2);
  });
});

describe('apple engine — limits', () => {
  it('marks probed limits as measured and absent ones as declared', () => {
    expect(appleLimits(UP).inputSource).toBe('measured');
    expect(appleLimits(APPLE_SERVICE_ABSENT).inputSource).toBe('declared');
  });

  it('scales the input cap with the window the service reported', () => {
    const small = appleLimits({ ...UP, contextTokens: 4096 }).maxInputChars;
    const large = appleLimits({ ...UP, contextTokens: 8192 }).maxInputChars;
    expect(large).toBeGreaterThan(small);
  });

  it('leaves room for the chunk width the gist pipeline actually uses', () => {
    // CHUNK_MAX_CHARS is 3600; an Apple cap below that would silently re-narrow
    // chunks and cost extra generations — the exact bug caught in the WebGPU
    // lane on 2026-07-28.
    expect(appleLimits(UP).maxInputChars).toBeGreaterThanOrEqual(3600);
  });
});

describe('apple reply parsing', () => {
  it('returns null for a shape it does not recognize rather than guessing', () => {
    expect(appleReplyText(null)).toBeNull();
    expect(appleReplyText({})).toBeNull();
    expect(appleReplyText({ choices: [] })).toBeNull();
    expect(appleReplyText({ choices: [{ message: {} }] })).toBeNull();
  });
});
