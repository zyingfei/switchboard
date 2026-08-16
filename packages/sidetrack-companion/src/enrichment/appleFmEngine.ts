// Apple Foundation Models — companion-side client, reached through the same
// local OpenAI-compatible service the extension panel already talks to
// (`apfel`, MIT, homebrew-core): `brew install apfel && apfel --serve` opens
// `http://localhost:11434/v1`.
//
// WHY A SEPARATE CLIENT INSTEAD OF IMPORTING THE EXTENSION'S. The extension
// package (`@sidetrack/extension`) and this one (`@sidetrack/companion`) are
// separate bun workspaces with no dependency edge between them (companion's
// package.json does not list the extension, and nothing in the extension's
// `nano/appleService.ts` is publishable/importable cross-package — it lives
// under the extension's own `src/sidepanel/` tree, built for the browser).
// `nano/appleService.ts` also has no browser-specific dependency itself (it is
// a plain-fetch module) — the actual blocker is the workspace boundary, not
// the code. So this module PORTS that module's wire contract verbatim: same
// base URL, same model id, same two-phase probe (liveness GET, THEN a
// generation POST on its own longer budget — the fix for the historical
// GET-200/POST-403 trap, see probeAppleFm below), same chars-per-token
// convention, same fatal-session handling philosophy. Constants and shapes
// are kept byte-for-byte identical to `sidetrack-extension/src/sidepanel/
// nano/appleService.ts` on purpose: a future real code-sharing package should
// be able to replace both call sites with zero behavior change.
//
// WHY THIS IS THE RIGHT ENGINE FOR OFFLINE, SERVER-SIDE GENERATION. Content
// enrichment (gists/synthesized titles) generates in the BROWSER (the panel
// calls Nano/Apple/WebGPU and POSTs the result to the companion) because that
// is where a live page's DOM lives. Workstream-prototype generation has no
// such requirement — it reads already-captured evidence (titles + gists) out
// of the vault, entirely offline — so it can and should run as a companion
// background job, calling `apfel` directly over loopback. The companion
// process is already the trust boundary for every other on-device write in
// this repo; a loopback POST to 11434 is no different in kind from the
// sqlite-vec extension load two files over.
//
// PROBE-WHAT-YOU-CLAIM (repeated here because it is the load-bearing rule).
// apfel enforces an origin allowlist for browser callers; a companion Bun
// process is not a browser page and sends no `Origin` header on its own
// fetches, so the origin-blocked failure mode the extension guards against
// does not apply here the same way — but the underlying lesson (a GET
// answering 200 says nothing about whether the model will actually generate)
// still does, so the two-phase probe is kept intact rather than trimmed to
// "just do the GET".

/** Where apfel serves by default. Also Ollama's default port — see below. */
export const APPLE_SERVICE_BASE_URL = 'http://localhost:11434/v1';

/** apfel's model identifier for the on-device Apple model. */
export const APPLE_MODEL_ID = 'apple-foundationmodel';

/**
 * Apple's on-device context window, in tokens, as reported by macOS 26. Used
 * only as the FALLBACK — the probe reads the live `context_window` off
 * /v1/models, because a newer OS can report a larger window and a hardcoded
 * constant would silently throw away the difference.
 */
export const APPLE_FALLBACK_CONTEXT_TOKENS = 4096;

/** Assumed characters per token for ENGLISH input — same 4:1 convention the
 *  extension's Nano/Apple paths use. NEVER apply this to Chinese text — see
 *  prototypeEvidence.ts's CJK-aware budget, which this constant deliberately
 *  does not attempt to generalize (Apple FM never receives zh input; the
 *  language gate in prototypeGeneration.ts keeps it that way). */
export const APPLE_CHARS_PER_TOKEN = 4;

/**
 * Reserve of the context window left for prompt scaffolding + the generated
 * answer. The window holds BOTH the evidence and the reply, so spending all
 * of it on input guarantees a truncated (or budget-rejected) generation.
 */
export const APPLE_CONTEXT_HEADROOM = 0.6;

/** Liveness timeout for the GET — a local port answers in <1ms or is not
 *  there at all. */
export const APPLE_PROBE_TIMEOUT_MS = 1500;

/**
 * Timeout for the GENERATION probe / a real generation call. A COLD Apple
 * Foundation Models session is spun up by the OS and measured (2026-07-28,
 * extension probe) at ~7s; 15s is generous on purpose — this call happens at
 * most once per offline generation tick, never on a request path.
 */
export const APPLE_GENERATION_TIMEOUT_MS = 15_000;

export interface AppleServiceInfo {
  /** True when a service answered /v1/models AND advertises the Apple model
   *  AND accepted a real generation POST. */
  readonly available: boolean;
  /** Live context window in tokens, or the documented fallback. */
  readonly contextTokens: number;
  /** Model id to send, taken from the service when it names one. */
  readonly modelId: string;
  readonly reason: 'ok' | 'not-running' | 'wrong-service' | 'origin-blocked' | 'probe-failed';
}

export const APPLE_SERVICE_ABSENT: AppleServiceInfo = {
  available: false,
  contextTokens: APPLE_FALLBACK_CONTEXT_TOKENS,
  modelId: APPLE_MODEL_ID,
  reason: 'not-running',
};

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const globalFetch: FetchLike = (input, init) =>
  (globalThis as { fetch: (i: string, o: RequestInit) => Promise<Response> }).fetch(input, init);

/** `{ data: [{ id, context_window }] }` → the Apple entry, or null. */
export const appleModelEntry = (body: unknown): { id: string; contextTokens: number } | null => {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue;
    const id = (raw as { id?: unknown }).id;
    if (typeof id !== 'string' || !id.includes('foundationmodel')) continue;
    const win = (raw as { context_window?: unknown }).context_window;
    return {
      id,
      contextTokens:
        typeof win === 'number' && Number.isFinite(win) && win > 0
          ? Math.floor(win)
          : APPLE_FALLBACK_CONTEXT_TOKENS,
    };
  }
  return null;
};

/** Characters of ENGLISH input the engine will accept, derived from the live
 *  window rather than declared. */
export const appleMaxInputChars = (contextTokens: number): number =>
  Math.max(1, Math.floor(contextTokens * APPLE_CHARS_PER_TOKEN * APPLE_CONTEXT_HEADROOM));

/**
 * Ask localhost whether the Apple service is there AND will actually
 * generate for us. Never throws. Two checks, both necessary (see the header
 * comment): a bare 200 on /v1/models is not proof the service will generate.
 */
export const probeAppleFm = async (
  baseUrl: string = APPLE_SERVICE_BASE_URL,
  fetchImpl: FetchLike = globalFetch,
  timeoutMs: number = APPLE_PROBE_TIMEOUT_MS,
  generationTimeoutMs: number = APPLE_GENERATION_TIMEOUT_MS,
): Promise<AppleServiceInfo> => {
  const root = baseUrl.replace(/\/+$/u, '');
  const liveness = new AbortController();
  const livenessTimer = setTimeout(() => {
    liveness.abort();
  }, timeoutMs);
  let entry: { id: string; contextTokens: number } | null = null;
  try {
    const res = await fetchImpl(`${root}/models`, { method: 'GET', signal: liveness.signal });
    if (res.status === 403) return { ...APPLE_SERVICE_ABSENT, reason: 'origin-blocked' };
    if (!res.ok) return { ...APPLE_SERVICE_ABSENT, reason: 'probe-failed' };
    entry = appleModelEntry(await res.json());
    if (entry === null) return { ...APPLE_SERVICE_ABSENT, reason: 'wrong-service' };
  } catch {
    return APPLE_SERVICE_ABSENT;
  } finally {
    clearTimeout(livenessTimer);
  }

  const generation = new AbortController();
  const generationTimer = setTimeout(() => {
    generation.abort();
  }, generationTimeoutMs);
  try {
    const gen = await fetchImpl(`${root}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: entry.id,
        messages: [{ role: 'user', content: 'ok' }],
        max_tokens: 1,
      }),
      signal: generation.signal,
    });
    if (gen.status === 403) {
      return {
        ...APPLE_SERVICE_ABSENT,
        contextTokens: entry.contextTokens,
        reason: 'origin-blocked',
      };
    }
    if (!gen.ok) {
      return {
        ...APPLE_SERVICE_ABSENT,
        contextTokens: entry.contextTokens,
        reason: 'probe-failed',
      };
    }
    return { available: true, contextTokens: entry.contextTokens, modelId: entry.id, reason: 'ok' };
  } catch {
    return { ...APPLE_SERVICE_ABSENT, contextTokens: entry.contextTokens, reason: 'probe-failed' };
  } finally {
    clearTimeout(generationTimer);
  }
};

// ---- probe cache --------------------------------------------------------
//
// Offline generation runs on an hours-scale cadence, not a per-request path,
// so the cache TTL is generous relative to the extension's (which re-probes
// every enrichment). Still cached — not for latency, but so a generation tick
// that walks many dirty workstreams in one pass doesn't hammer the port once
// per workstream.

export const APPLE_PROBE_TTL_MS = 5 * 60_000;

let probeCache: { at: number; info: AppleServiceInfo } | null = null;
let probeOverride: (() => Promise<AppleServiceInfo>) | null = null;

/** Replace the probe (tests only). Pass null to restore the real one. Always
 *  clears the cache. Mirrors the extension's setAppleProbeForTest — tests
 *  must never depend on whether `apfel --serve` happens to be running on the
 *  developer's machine (caught for real, 2026-07-28, on the extension side). */
export const setAppleFmProbeForTest = (probe: (() => Promise<AppleServiceInfo>) | null): void => {
  probeOverride = probe;
  probeCache = null;
};

export const resetAppleFmProbeCacheForTest = (): void => {
  probeCache = null;
};

export const appleFmStatus = async (
  force = false,
  now: number = Date.now(),
): Promise<AppleServiceInfo> => {
  if (!force && probeCache !== null && now - probeCache.at < APPLE_PROBE_TTL_MS) {
    return probeCache.info;
  }
  const info = await (probeOverride ?? probeAppleFm)();
  probeCache = { at: now, info };
  return info;
};

// ---- generation -----------------------------------------------------------

/**
 * A FATAL backend error poisons the underlying apfel/FoundationModels session
 * for the rest of the process the same way the extension's WebGPU context can
 * die mid-run (see `nano/appleService.ts` / `nano/engine.ts`'s
 * `isFatalBackendError`). apfel wraps FoundationModels natively rather than
 * an ORT graph, so the concrete error strings differ, but the shape of the
 * risk is identical: a generation that throws with one of these signatures
 * means the NEXT generation is not trustworthy either until the probe cache
 * is dropped and re-verified. Matched narrowly, on purpose (see the
 * extension's own comment on why a false match is worse than a missed one).
 */
export const isFatalAppleFmError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /connection (refused|reset)/iu.test(message) ||
    /socket hang up/iu.test(message) ||
    /model.*(unloaded|unavailable)/iu.test(message) ||
    /internal server error/iu.test(message)
  );
};

/** Drop the probe cache after a fatal error — the next call re-verifies
 *  rather than trusting a stale "available". Not an error path of its own;
 *  it is how the next tick becomes able to recover. */
export const resetAppleFmAfterFatalError = (): void => {
  probeCache = null;
};

export interface AppleFmGenerateOptions {
  readonly prompt: string;
  /** Caps the reply length in TOKENS (never characters — see the CJK budget
   *  note in prototypeEvidence.ts; Apple FM only ever receives English input
   *  in this codebase, but the reply cap is still token-denominated because
   *  that is what the wire API accepts). */
  readonly maxOutputTokens: number;
  readonly baseUrl?: string;
  readonly modelId?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * Generate one completion. Returns the cleaned text, or null when the engine
 * refused/failed/timed out — NEVER throws into the caller, matching the
 * "generation must be skipped gracefully" contract (a failed generation is a
 * health note, not a crash). Fatal-shaped errors drop the probe cache so the
 * next tick re-verifies instead of retrying a dead session.
 */
export const generateWithAppleFm = async (opts: AppleFmGenerateOptions): Promise<string | null> => {
  const root = (opts.baseUrl ?? APPLE_SERVICE_BASE_URL).replace(/\/+$/u, '');
  const fetchImpl = opts.fetchImpl ?? globalFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? APPLE_GENERATION_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${root}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.modelId ?? APPLE_MODEL_ID,
        messages: [{ role: 'user', content: opts.prompt }],
        max_tokens: Math.max(1, Math.floor(opts.maxOutputTokens)),
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      choices?: readonly { message?: { content?: unknown } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    return typeof content === 'string' && content.trim().length > 0 ? content.trim() : null;
  } catch (err) {
    if (isFatalAppleFmError(err)) resetAppleFmAfterFatalError();
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export const appleFmUnavailableCopy = (reason: AppleServiceInfo['reason']): string => {
  switch (reason) {
    case 'ok':
      return '';
    case 'not-running':
      return 'no local Apple AI service on port 11434 — install with `brew install apfel`, then run `apfel --serve`';
    case 'wrong-service':
      return 'something is serving port 11434, but it does not offer Apple’s on-device model';
    case 'origin-blocked':
      return 'the local Apple AI service is refusing this process — check `apfel --serve`’s allowed-origins configuration';
    case 'probe-failed':
      return 'the local Apple AI service answered, but could not generate';
  }
};
