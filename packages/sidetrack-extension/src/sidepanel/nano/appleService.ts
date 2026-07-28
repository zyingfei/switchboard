// Apple Foundation Models, reached through a local OpenAI-compatible service.
//
// WHAT THIS IS. macOS 26 ships an on-device ~3B model (the one behind Apple
// Intelligence) with a native Swift API — FoundationModels — and NO browser
// API. The standard way to reach it from JS is a small local service that
// speaks OpenAI's wire format. `apfel` (MIT, homebrew-core) is that service:
//
//     brew install apfel && apfel --serve      # http://localhost:11434/v1
//
// WHY IT IS WORTH A DEDICATED ENGINE, measured 2026-07-28 on an M2 / 16GB /
// macOS 26.5.2 against the SAME three vault documents, prompts and scoring
// used to tune the WebGPU lane:
//
//     WebGPU gemma-1B q4    17.3s median   groundedness 0.47
//     Apple FM via apfel     4.1s median   groundedness 0.61
//
// 4.2x faster and better grounded, with no model download, no 14s load, and no
// browser GPU memory pressure — the weights are already resident in the OS.
//
// WHY IT IS NOT THE `remote` ENGINE. remoteEngine.ts speaks the same wire
// format, so reusing it is tempting and wrong. That lane is built as a
// CREDENTIALED OUTBOUND path: it requires an API key, masks it, never logs it,
// and the UI marks every run as leaving the device. None of that describes a
// call to a process on this machine talking to weights in this machine's OS.
// Filing Apple FM under 'remote' would understate the privacy property, which
// is the one thing this product cannot afford to be sloppy about. Different
// truth ⇒ different engine kind.
//
// NOTHING HERE AUTO-INSTALLS OR AUTO-STARTS ANYTHING. This module only asks a
// localhost port whether it is there. If apfel is not installed or not running,
// the probe fails and the engine simply does not exist — exactly how the
// WebGPU engine behaves before an explicit load.

/** Where apfel serves by default. Also Ollama's default port — see below. */
export const APPLE_SERVICE_BASE_URL = 'http://localhost:11434/v1';

/** apfel's model identifier for the on-device Apple model. */
export const APPLE_MODEL_ID = 'apple-foundationmodel';

/**
 * Apple's on-device context window, in tokens, as reported by macOS 26.
 * Used only as the FALLBACK — the probe reads the live `context_window` off
 * /v1/models, because macOS 27 reports 8192 and a hardcoded 4096 would silently
 * throw away half the window on a newer OS.
 */
export const APPLE_FALLBACK_CONTEXT_TOKENS = 4096;

/** Assumed characters per token. Same 4:1 convention the Nano path uses. */
export const APPLE_CHARS_PER_TOKEN = 4;

/**
 * Reserve of the context window left for the prompt scaffolding and the
 * generated answer. The window has to hold BOTH the document and the reply, so
 * spending all of it on input guarantees a truncated answer.
 */
export const APPLE_CONTEXT_HEADROOM = 0.6;

/** How long to wait on the probe. A local port answers in ms or is not there. */
export const APPLE_PROBE_TIMEOUT_MS = 1500;

export interface AppleServiceInfo {
  /** True when a service answered /v1/models AND advertises the Apple model. */
  readonly available: boolean;
  /** Live context window in tokens, or the documented fallback. */
  readonly contextTokens: number;
  /** Model id to send, taken from the service when it names one. */
  readonly modelId: string;
  /**
   * Why it is unavailable — surfaced verbatim so "no Apple engine" is never a
   * silent absence the user has to guess about.
   */
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
export const appleModelEntry = (
  body: unknown,
): { id: string; contextTokens: number } | null => {
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

/**
 * Characters of INPUT the Apple engine will accept, derived from the live
 * window rather than declared. Reported through EngineLimits with
 * inputSource 'measured', so the UI can say where the number came from.
 */
export const appleMaxInputChars = (contextTokens: number): number =>
  Math.max(1, Math.floor(contextTokens * APPLE_CHARS_PER_TOKEN * APPLE_CONTEXT_HEADROOM));

/**
 * Ask localhost whether the Apple service is there AND will actually generate
 * for us. Never throws.
 *
 * TWO CHECKS, BOTH NECESSARY — and the second one was learned the hard way.
 *
 * 1. GET /v1/models. The port is Ollama's default too, so a bare 200 is NOT
 *    enough: the response must advertise a foundation model. Otherwise pointing
 *    at a running Ollama would route page text to whatever model it happens to
 *    host — a different engine wearing Apple's privacy guarantees.
 *
 * 2. A one-token POST to the REAL generation endpoint. apfel enforces an origin
 *    allowlist (sensible: otherwise any website you visit could quietly drive
 *    your local model), and a browser sends `Origin` on a JSON POST but NOT on
 *    a simple GET. So the GET returns 200 from an extension page while every
 *    POST returns 403 — measured live, 2026-07-28. A probe that only did step 1
 *    would report the engine READY and then fail every single gist.
 *
 * The rule this encodes: a probe must test the thing it is claiming. Claiming
 * "can generate" while testing "is listening" is how a feature ships broken
 * with green tests.
 */
export const probeAppleService = async (
  baseUrl: string = APPLE_SERVICE_BASE_URL,
  fetchImpl: FetchLike = globalFetch,
  timeoutMs: number = APPLE_PROBE_TIMEOUT_MS,
): Promise<AppleServiceInfo> => {
  const root = baseUrl.replace(/\/+$/u, '');
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  try {
    const res = await fetchImpl(`${root}/models`, { method: 'GET', signal: controller.signal });
    if (res.status === 403) return { ...APPLE_SERVICE_ABSENT, reason: 'origin-blocked' };
    if (!res.ok) return { ...APPLE_SERVICE_ABSENT, reason: 'probe-failed' };
    const entry = appleModelEntry(await res.json());
    if (entry === null) return { ...APPLE_SERVICE_ABSENT, reason: 'wrong-service' };

    // Step 2 — the smallest real generation, purely to prove the POST path is
    // open to this origin. One token, so the cost is a session round-trip
    // (~0.6s measured) and it only runs once per probe TTL.
    const gen = await fetchImpl(`${root}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: entry.id,
        messages: [{ role: 'user', content: 'ok' }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    if (gen.status === 403) {
      return { ...APPLE_SERVICE_ABSENT, contextTokens: entry.contextTokens, reason: 'origin-blocked' };
    }
    if (!gen.ok) {
      return { ...APPLE_SERVICE_ABSENT, contextTokens: entry.contextTokens, reason: 'probe-failed' };
    }
    return {
      available: true,
      contextTokens: entry.contextTokens,
      modelId: entry.id,
      reason: 'ok',
    };
  } catch {
    // Connection refused, DNS, abort — all the same to the caller: not there.
    return APPLE_SERVICE_ABSENT;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * One short human sentence per reason — what the Health row shows verbatim.
 *
 * `extensionId` is threaded in (rather than read from chrome.* here, which
 * would make this module untestable and impure) so the origin-blocked case can
 * print a command the user can actually PASTE. A remedy containing
 * "<your extension id>" is a puzzle, not an instruction.
 */
export const appleUnavailableCopy = (
  reason: AppleServiceInfo['reason'],
  extensionId?: string,
): string => {
  switch (reason) {
    case 'ok':
      return '';
    case 'not-running':
      return 'no local Apple AI service on port 11434 — install with `brew install apfel`, then run `apfel --serve`';
    case 'wrong-service':
      return 'something is serving port 11434, but it does not offer Apple’s on-device model';
    case 'origin-blocked': {
      // The exact remedy, not a shrug. apfel allowlists origins so a random
      // website cannot quietly drive your local model — a good default that
      // simply has to be told about this extension once.
      const origin =
        extensionId === undefined || extensionId.length === 0
          ? 'chrome-extension://<this extension id>'
          : `chrome-extension://${extensionId}`;
      return `the local Apple AI service is refusing this extension — restart it with \`apfel --serve --allowed-origins ${origin}\``;
    }
    case 'probe-failed':
      return 'the local Apple AI service answered, but could not generate';
  }
};
