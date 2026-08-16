import { afterEach, describe, expect, it } from 'bun:test';

import {
  APPLE_MODEL_ID,
  appleFmStatus,
  appleFmUnavailableCopy,
  appleMaxInputChars,
  appleModelEntry,
  generateWithAppleFm,
  isFatalAppleFmError,
  probeAppleFm,
  resetAppleFmAfterFatalError,
  resetAppleFmProbeCacheForTest,
  setAppleFmProbeForTest,
  type AppleServiceInfo,
} from './appleFmEngine.js';

// A companion-side port of nano/appleService.ts's protocol — see the
// module's header for why this is a port and not a shared import. These
// tests never make a real network call: `probeAppleFm`/`generateWithAppleFm`
// always take an injected `fetchImpl`, exactly the seam the extension's own
// appleService.test.ts uses to stay hermetic ("a UNIT TEST'S RESULT
// DEPENDS ON WHETHER A DAEMON HAPPENS TO BE RUNNING", 2026-07-28).

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('appleModelEntry', () => {
  it('finds the foundationmodel entry and its context window', () => {
    const entry = appleModelEntry({
      data: [
        { id: 'llama-3', context_window: 8192 },
        { id: 'apple-foundationmodel', context_window: 16384 },
      ],
    });
    expect(entry).toEqual({ id: 'apple-foundationmodel', contextTokens: 16384 });
  });

  it('falls back to the documented context window when unreported', () => {
    const entry = appleModelEntry({ data: [{ id: 'apple-foundationmodel' }] });
    expect(entry?.contextTokens).toBe(4096);
  });

  it('returns null for a service with no foundation model (Ollama etc.)', () => {
    expect(appleModelEntry({ data: [{ id: 'llama-3' }] })).toBeNull();
  });

  it('returns null for a malformed body', () => {
    expect(appleModelEntry(null)).toBeNull();
    expect(appleModelEntry({})).toBeNull();
    expect(appleModelEntry({ data: 'nope' })).toBeNull();
  });
});

describe('probeAppleFm — the two-phase probe (KNOWN TRAP: GET-200/POST-403)', () => {
  it('reports ok when both the liveness GET and the generation POST succeed', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push(`${init.method} ${url}`);
      if (init.method === 'GET') {
        return jsonResponse(200, { data: [{ id: APPLE_MODEL_ID, context_window: 8192 }] });
      }
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    };
    const info = await probeAppleFm('http://localhost:11434/v1', fetchImpl);
    expect(info).toEqual({
      available: true,
      contextTokens: 8192,
      modelId: APPLE_MODEL_ID,
      reason: 'ok',
    });
    expect(calls).toEqual([
      'GET http://localhost:11434/v1/models',
      'POST http://localhost:11434/v1/chat/completions',
    ]);
  });

  it('THE TRAP: a GET that returns 200 does not prove the POST path is open', async () => {
    // This is the exact live failure the header documents: apfel enforces an
    // origin allowlist, so a probe that only checked the GET would report
    // 'available' and then fail every real generation. The fix is testing
    // the thing the probe CLAIMS — a real generation POST, on its own
    // (longer) budget.
    const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
      if (init.method === 'GET') {
        return jsonResponse(200, { data: [{ id: APPLE_MODEL_ID, context_window: 8192 }] });
      }
      return new Response('forbidden', { status: 403 });
    };
    const info = await probeAppleFm('http://localhost:11434/v1', fetchImpl);
    expect(info.available).toBe(false);
    expect(info.reason).toBe('origin-blocked');
  });

  it('reports not-running when the connection is refused', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    };
    const info = await probeAppleFm('http://localhost:11434/v1', fetchImpl);
    expect(info).toEqual({
      available: false,
      contextTokens: 4096,
      modelId: APPLE_MODEL_ID,
      reason: 'not-running',
    });
  });

  it('reports wrong-service when the port answers but is not apfel (e.g. Ollama)', async () => {
    const fetchImpl = async (): Promise<Response> =>
      jsonResponse(200, { data: [{ id: 'llama-3' }] });
    const info = await probeAppleFm('http://localhost:11434/v1', fetchImpl);
    expect(info.reason).toBe('wrong-service');
    expect(info.available).toBe(false);
  });

  it('reports probe-failed when the generation POST 500s', async () => {
    const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
      if (init.method === 'GET') {
        return jsonResponse(200, { data: [{ id: APPLE_MODEL_ID, context_window: 4096 }] });
      }
      return new Response('boom', { status: 500 });
    };
    const info = await probeAppleFm('http://localhost:11434/v1', fetchImpl);
    expect(info.reason).toBe('probe-failed');
  });
});

describe('appleFmStatus — cached probe', () => {
  afterEach(() => {
    setAppleFmProbeForTest(null);
    resetAppleFmProbeCacheForTest();
  });

  it('serves from the override without ever touching a real network call', async () => {
    let calls = 0;
    const info: AppleServiceInfo = {
      available: true,
      contextTokens: 4096,
      modelId: APPLE_MODEL_ID,
      reason: 'ok',
    };
    setAppleFmProbeForTest(async () => {
      calls += 1;
      return info;
    });
    expect(await appleFmStatus()).toEqual(info);
    expect(await appleFmStatus()).toEqual(info); // cached — no second call
    expect(calls).toBe(1);
    expect(await appleFmStatus(true)).toEqual(info); // force bypasses cache
    expect(calls).toBe(2);
  });
});

describe('generateWithAppleFm', () => {
  it('returns the cleaned assistant content on success', async () => {
    const fetchImpl = async (): Promise<Response> =>
      jsonResponse(200, {
        choices: [{ message: { content: '  a workstream about kv-cache research  ' } }],
      });
    const text = await generateWithAppleFm({
      prompt: 'describe this',
      maxOutputTokens: 40,
      fetchImpl,
    });
    expect(text).toBe('a workstream about kv-cache research');
  });

  it('returns null (never throws) when the engine 500s', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('boom', { status: 500 });
    const text = await generateWithAppleFm({ prompt: 'x', maxOutputTokens: 10, fetchImpl });
    expect(text).toBeNull();
  });

  it('returns null when the connection drops mid-call', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('socket hang up');
    };
    const text = await generateWithAppleFm({ prompt: 'x', maxOutputTokens: 10, fetchImpl });
    expect(text).toBeNull();
  });
});

describe('isFatalAppleFmError / resetAppleFmAfterFatalError', () => {
  afterEach(() => {
    setAppleFmProbeForTest(null);
    resetAppleFmProbeCacheForTest();
  });

  it('classifies a session-poisoning error as fatal', () => {
    expect(isFatalAppleFmError(new Error('socket hang up'))).toBe(true);
    expect(isFatalAppleFmError(new Error('connection refused'))).toBe(true);
    expect(isFatalAppleFmError(new Error('model unloaded'))).toBe(true);
  });

  it('does NOT classify an ordinary content-shaped failure as fatal', () => {
    expect(isFatalAppleFmError(new Error('Unsupported language'))).toBe(false);
  });

  it('a fatal generation error drops the cached probe, forcing re-verification', async () => {
    let calls = 0;
    setAppleFmProbeForTest(async () => {
      calls += 1;
      return { available: true, contextTokens: 4096, modelId: APPLE_MODEL_ID, reason: 'ok' };
    });
    await appleFmStatus();
    expect(calls).toBe(1);
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('socket hang up');
    };
    const text = await generateWithAppleFm({ prompt: 'x', maxOutputTokens: 10, fetchImpl });
    expect(text).toBeNull();
    // The cache is gone — the next status() re-probes rather than trusting a
    // stale 'available'.
    await appleFmStatus();
    expect(calls).toBe(2);
    resetAppleFmAfterFatalError(); // idempotent, safe to call directly too
  });
});

describe('appleMaxInputChars / appleFmUnavailableCopy', () => {
  it('derives input chars from the live context window with headroom', () => {
    expect(appleMaxInputChars(4096)).toBe(Math.floor(4096 * 4 * 0.6));
  });

  it('names every reason with a non-empty remedy except ok', () => {
    expect(appleFmUnavailableCopy('ok')).toBe('');
    for (const reason of [
      'not-running',
      'wrong-service',
      'origin-blocked',
      'probe-failed',
    ] as const) {
      expect(appleFmUnavailableCopy(reason).length).toBeGreaterThan(0);
    }
  });
});
