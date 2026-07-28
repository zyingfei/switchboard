// INPUT AND OUTPUT LIMITS — defined once, enforced, and SHOWN.
//
// The limits used to be implicit and scattered: a 2200-char slice constant in
// titleSynthesis, a 1800-char chunk width in chunking, a 140-token budget in
// generationOptions, and nothing at all for "how much of this document will the
// model actually see". A user watching a 40k-char page produce a two-sentence
// gist had no way to know that most of the page was never read.
//
// So: one table, three rules.
//
//   DEFINE  — every engine has an input cap (characters) and an output cap
//             (tokens where the API has a token budget, characters always).
//             Local-model caps come from the model registry, because they are a
//             property of the MODEL, not of the backend (a 4B model needs a
//             smaller slice than a 1B one for the same latency).
//   ENFORCE — input over the cap is reduced through the EXISTING chunking path
//             (planChunks + evenly-spaced selection), never by a silent
//             `.slice()`. Head-only truncation would summarize a document's
//             introduction and call it the document.
//   SHOW    — `formatEngineLimits` renders "limits: 2k in / 140 tok out" for the
//             Health AI row and the Now card, and every reduction is reported in
//             the result meta so the UI can say "6/14 sections · 5.4k/42k chars".
//
// HOW EACH CAP WAS DERIVED (stated, because a magic number nobody can defend
// gets "tuned" by the next person who hits a wall):
//
//   nano    — REAL QUOTA when the browser exposes it. A Prompt-API session
//             carries `inputQuota` (tokens) and `measureInputUsage(text)`; both
//             are read defensively (they do not exist on every Chrome) and the
//             quota is converted to characters using a MEASURED chars-per-token
//             ratio when measureInputUsage is available, a 4:1 assumption
//             otherwise, with 10% headroom for the prompt prefix. When nothing
//             is exposed we fall back to a documented constant.
//   webgpu  — LATENCY-derived, from the model registry. See
//             WEBGPU_1B_MAX_INPUT_CHARS: the 2026-07-27 tuning run fed 2000-char
//             inputs and took ~13s per gist on an M-series GPU.
//   remote  — CONTEXT-derived and deliberately conservative: assume the
//             smallest context an OpenAI-compatible endpoint commonly ships
//             (8k tokens), reserve the output budget, and stay well under it.
//
// Pure except for the Nano quota probe, which is memoized and never throws.

import {
  APPLE_CONTEXT_HEADROOM,
  APPLE_FALLBACK_CONTEXT_TOKENS,
  APPLE_SERVICE_ABSENT,
  appleMaxInputChars,
  type AppleServiceInfo,
} from './appleService';
import { planChunks } from './chunking';
import { GIST_MAX_NEW_TOKENS, GIST_OUTPUT_MAX_CHARS } from './generationOptions';
import {
  localModelSpec,
  type EngineKind,
  type LocalModelSpec,
} from './modelRegistry';
import type { BuiltinLanguageModel } from './titleSynthesis';

// ---------------------------------------------------------------------------
// The shape.
// ---------------------------------------------------------------------------

export interface EngineLimits {
  readonly kind: EngineKind;
  /** Maximum characters handed to the model in ONE generate() call. */
  readonly maxInputChars: number;
  /** Output token budget, or null when the API exposes none (Chrome's Prompt API). */
  readonly maxOutputTokens: number | null;
  /** Hard character cap applied to the cleaned output. Always present. */
  readonly maxOutputChars: number;
  /** Whether maxInputChars came from the runtime or from a documented constant. */
  readonly inputSource: 'measured' | 'declared';
  /** One sentence explaining where the input cap came from. */
  readonly note: string;
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

/**
 * Fallback input cap for Chrome's built-in model when the session exposes no
 * quota. 4000 chars ≈ 1000 tokens at the 4:1 ratio below — inside the smallest
 * per-session input quota Chrome has shipped for Gemini Nano (1024 tokens).
 * Deliberately conservative: overshooting the quota makes the session throw,
 * undershooting only costs coverage, and coverage is reported.
 */
export const NANO_FALLBACK_MAX_INPUT_CHARS = 4000;
/** Assumed characters per token when measureInputUsage() is unavailable. */
export const NANO_CHARS_PER_TOKEN = 4;
/** Reserve 10% of the quota for the prompt prefix and the chat scaffolding. */
export const NANO_QUOTA_HEADROOM = 0.9;
/** The probe string handed to measureInputUsage() to calibrate chars-per-token. */
export const NANO_PROBE_TEXT =
  'The quick brown fox jumps over the lazy dog while the organization trail writes events into a central bucket.';

/**
 * Remote input cap. 8k-token context (the smallest commonly shipped by an
 * OpenAI-compatible endpoint) minus the output budget leaves ~7.5k tokens;
 * at ~4 chars/token that is ~30k chars, and we stop well short at 24k so an
 * endpoint with a tighter window still answers instead of 400-ing.
 */
export const REMOTE_MAX_INPUT_CHARS = 24_000;

// ---------------------------------------------------------------------------
// The table.
// ---------------------------------------------------------------------------

export const nanoDeclaredLimits: EngineLimits = {
  kind: 'nano',
  maxInputChars: NANO_FALLBACK_MAX_INPUT_CHARS,
  // The Prompt API has no max_new_tokens — output length is not controllable,
  // only capped after the fact. Saying "null" is more honest than printing a
  // number the API never receives.
  maxOutputTokens: null,
  maxOutputChars: GIST_OUTPUT_MAX_CHARS,
  inputSource: 'declared',
  note: 'Chrome exposed no session quota — using the documented 4000-char fallback (~1000 tokens).',
};

export const remoteLimits: EngineLimits = {
  kind: 'remote',
  maxInputChars: REMOTE_MAX_INPUT_CHARS,
  maxOutputTokens: GIST_MAX_NEW_TOKENS,
  maxOutputChars: GIST_OUTPUT_MAX_CHARS,
  inputSource: 'declared',
  note: 'Context-derived and conservative: an 8k-token window minus the output budget, at ~4 chars/token.',
};

/** Limits for one local model — read straight off its registry entry. */
export const localModelLimits = (spec: LocalModelSpec): EngineLimits => ({
  kind: 'webgpu',
  maxInputChars: spec.maxInputChars,
  maxOutputTokens: spec.maxNewTokens,
  maxOutputChars: spec.maxOutputChars,
  inputSource: 'declared',
  note: spec.limitsNote,
});

/**
 * Limits for an engine kind, WITHOUT any probing. `modelId` selects the local
 * model's row; ignored for the other kinds. Pure — safe in render.
 */
export const limitsFor = (kind: EngineKind, modelId?: string | null): EngineLimits => {
  if (kind === 'webgpu') return localModelLimits(localModelSpec(modelId));
  if (kind === 'remote') return remoteLimits;
  // Without a live probe the Apple window is not known, so this returns the
  // DOCUMENTED macOS 26 fallback. The engine itself always carries probed
  // limits (appleLimits(info)); this branch only serves pure render paths.
  if (kind === 'apple') return appleLimits(APPLE_SERVICE_ABSENT);
  return cachedNanoLimits();
};

/**
 * Limits for the Apple on-device engine, derived from the window the local
 * service actually REPORTED rather than from a constant. macOS 26 reports 4096
 * tokens and macOS 27 reports 8192, so a hardcoded number would silently throw
 * away half the window on a newer OS — which is why `inputSource` is
 * 'measured' whenever the probe succeeded and 'declared' when it did not.
 *
 * `maxOutputTokens` is OUR gist budget, not a service limit: apfel accepts
 * `max_tokens`, so unlike Nano we can genuinely bound the output and say so.
 */
export const appleLimits = (info: AppleServiceInfo): EngineLimits => ({
  kind: 'apple',
  maxInputChars: appleMaxInputChars(info.contextTokens),
  maxOutputTokens: GIST_MAX_NEW_TOKENS,
  maxOutputChars: GIST_OUTPUT_MAX_CHARS,
  inputSource: info.available ? 'measured' : 'declared',
  note: info.available
    ? `Apple's on-device model reported a ${String(info.contextTokens)}-token window; ${String(Math.round(APPLE_CONTEXT_HEADROOM * 100))}% is left for input so the answer still fits.`
    : `No local Apple AI service answered — using the documented ${String(APPLE_FALLBACK_CONTEXT_TOKENS)}-token macOS 26 window.`,
});

// ---------------------------------------------------------------------------
// The Nano quota probe — the one place that asks the runtime for a real number.
// ---------------------------------------------------------------------------

/**
 * A Prompt-API session as it MIGHT look. Neither field is in the TS DOM lib and
 * neither is guaranteed by any Chrome version, so both are optional-unknown and
 * every read is guarded. Do not tighten these types — the whole point is that
 * we do not assume the surface exists.
 */
interface MaybeQuotaSession {
  readonly inputQuota?: unknown;
  readonly measureInputUsage?: unknown;
  readonly destroy: () => void;
}

let nanoLimitsCache: EngineLimits | null = null;

/** Test-only: forget the probed quota so each case starts from the same state. */
export const __resetEngineLimitsForTest = (): void => {
  nanoLimitsCache = null;
};

/** The measured quota if we have one, else the documented fallback. Sync, pure. */
export const cachedNanoLimits = (): EngineLimits => nanoLimitsCache ?? nanoDeclaredLimits;

/**
 * Read a LIVE Prompt-API session's real input quota. Every access is guarded:
 * `inputQuota` and `measureInputUsage` are not in the TS DOM lib, are not on
 * every Chrome, and are not promised by any spec we control. Anything missing or
 * nonsensical → null, and the caller keeps the documented constant.
 */
const limitsFromSession = async (session: MaybeQuotaSession): Promise<EngineLimits | null> => {
  const quota = session.inputQuota;
  if (typeof quota !== 'number' || !Number.isFinite(quota) || quota <= 0) return null;
  let charsPerToken = NANO_CHARS_PER_TOKEN;
  let calibrated = false;
  const measure = session.measureInputUsage;
  if (typeof measure === 'function') {
    const used: unknown = await (measure as (text: string) => Promise<unknown>)(NANO_PROBE_TEXT);
    if (typeof used === 'number' && Number.isFinite(used) && used > 0) {
      charsPerToken = NANO_PROBE_TEXT.length / used;
      calibrated = true;
    }
  }
  return {
    ...nanoDeclaredLimits,
    maxInputChars: Math.max(1, Math.floor(quota * charsPerToken * NANO_QUOTA_HEADROOM)),
    inputSource: 'measured',
    note: calibrated
      ? `Real session quota: ${String(quota)} tokens, measured at ${charsPerToken.toFixed(1)} chars/token, 10% reserved for the prompt.`
      : `Real session quota: ${String(quota)} tokens at an assumed ${String(NANO_CHARS_PER_TOKEN)} chars/token, 10% reserved for the prompt.`,
  };
};

/**
 * Learn the real quota from a session the caller was creating ANYWAY (the nano
 * engine's generate()). This is the cheap path and the default one: a dedicated
 * probe session would be a second create() per resolve, which on the built-in
 * API is not free. Memoized after the first success, never throws, and returns
 * whatever the cache holds so the caller can use the result immediately.
 */
export const observeNanoSessionLimits = async (session: unknown): Promise<EngineLimits> => {
  if (nanoLimitsCache !== null) return nanoLimitsCache;
  try {
    const measured = await limitsFromSession(session as MaybeQuotaSession);
    if (measured !== null) nanoLimitsCache = measured;
  } catch {
    // Quota surface absent or throwing — keep the documented fallback.
  }
  return cachedNanoLimits();
};

/**
 * EXPLICIT probe: create a throwaway session purely to read the quota. Costs one
 * session, so it is called only from user-initiated surfaces that need the real
 * number before any generation has happened (the engine comparison, which prints
 * each engine's limits). Never downloads: the caller checks availability first,
 * and 'available' means the component is already resident.
 */
export const probeNanoLimits = async (
  lm: BuiltinLanguageModel | undefined,
): Promise<EngineLimits> => {
  if (nanoLimitsCache !== null) return nanoLimitsCache;
  if (lm === undefined) return nanoDeclaredLimits;
  try {
    if ((await lm.availability()) !== 'available') return nanoDeclaredLimits;
    const session = (await lm.create()) as unknown as MaybeQuotaSession;
    try {
      return await observeNanoSessionLimits(session);
    } finally {
      session.destroy();
    }
  } catch {
    return nanoDeclaredLimits;
  }
};

// ---------------------------------------------------------------------------
// ENFORCEMENT — reduction goes through the chunking path, never a bare slice.
// ---------------------------------------------------------------------------

/** How many evenly-spaced samples a too-long input is reduced to. */
export const INPUT_SAMPLE_CHUNKS = 3;
/** Marker between samples, so the model sees a gap rather than a false splice. */
export const INPUT_SAMPLE_JOIN = '\n…\n';
/** Never build a sample narrower than this — below it a chunk says nothing. */
export const MIN_SAMPLE_CHARS = 200;

export interface PreparedInput {
  /** The text actually handed to the model. Never longer than maxInputChars. */
  readonly text: string;
  readonly inputChars: number;
  readonly processedChars: number;
  /** True when the cap bit — the caller MUST report this, never hide it. */
  readonly reduced: boolean;
  readonly maxInputChars: number;
  readonly totalChunks: number;
  readonly usedChunks: number;
}

/**
 * Fit `document` under `maxInputChars`.
 *
 * Under the cap: passes through untouched. Over the cap: planChunks() splits it
 * on paragraph/sentence boundaries at a width of cap/3 and
 * selectEvenlySpaced() picks the first, middle and last chunk — the SAME
 * chunking path the gist pipeline uses, which is why the result covers the whole
 * document instead of its opening. Pure and deterministic.
 */
export const prepareInput = (document: string, maxInputChars: number): PreparedInput => {
  const inputChars = document.length;
  if (inputChars <= maxInputChars) {
    return {
      text: document,
      inputChars,
      processedChars: inputChars,
      reduced: false,
      maxInputChars,
      totalChunks: 1,
      usedChunks: 1,
    };
  }
  const joinOverhead = INPUT_SAMPLE_JOIN.length * (INPUT_SAMPLE_CHUNKS - 1);
  const width = Math.max(
    MIN_SAMPLE_CHARS,
    Math.floor((maxInputChars - joinOverhead) / INPUT_SAMPLE_CHUNKS),
  );
  const plan = planChunks(document, { maxChars: width, maxChunks: INPUT_SAMPLE_CHUNKS });
  const text = plan.chunks.map((c) => c.text).join(INPUT_SAMPLE_JOIN);
  return {
    text,
    inputChars,
    processedChars: text.length,
    reduced: text.length < inputChars,
    maxInputChars,
    totalChunks: plan.totalChunks,
    usedChunks: plan.usedChunks,
  };
};

// ---------------------------------------------------------------------------
// DISPLAY.
// ---------------------------------------------------------------------------

/** 2000 → "2k", 1800 → "1.8k", 140 → "140". Compact enough for a status line. */
export const compactCount = (n: number): string => {
  if (n < 1000) return String(n);
  const thousands = n / 1000;
  return Number.isInteger(thousands) || thousands >= 10
    ? `${String(Math.round(thousands))}k`
    : `${thousands.toFixed(1)}k`;
};

/** "limits: 2k in / 140 tok out" — the compact line both rows render. */
export const formatEngineLimits = (limits: EngineLimits): string => {
  const out =
    limits.maxOutputTokens === null
      ? `${compactCount(limits.maxOutputChars)} chars`
      : `${String(limits.maxOutputTokens)} tok`;
  return `limits: ${compactCount(limits.maxInputChars)} in / ${out} out`;
};

/** "5.4k/42k chars" — the reduction, in the same vocabulary as "6/14 sections". */
export const formatReduction = (processedChars: number, inputChars: number): string =>
  `${compactCount(processedChars)}/${compactCount(inputChars)} chars`;
