// Decoding parameters for on-device generation — the direct fix for the
// 2026-07-27 live failure, where a gist on a normal web page ran 61.5s and came
// back as
//
//     2 224 6 224 6 224 6 224 6 224 6 …
//
// forever. That is textbook neural-text degeneration (Holtzman et al., "The
// Curious Case of Neural Text Degeneration"): the decoder entered a repeating
// cycle and, because generation was GREEDY (`do_sample: false`, no repetition
// control, `max_new_tokens: 220`), the argmax at each step is deterministic, so
// once the cycle is entered there is NO exit until the token budget runs out.
// A 1B q4 model is exactly the size class where this happens routinely.
//
// WHY THE CHOSEN COMBINATION (low-temperature sampling + BOTH penalties):
//
//   * Greedy alone   — has no escape from a cycle. This is what we shipped.
//   * Sampling alone — an escape exists, but at T=1 a 1B model wanders off the
//                      source text; a gist must stay factual.
//   * Penalties alone on a greedy decoder — `no_repeat_ngram_size` HARD-bans a
//                      repeated n-gram, which does break the "224 6 224 6"
//                      loop, but with a deterministic decoder the model is then
//                      forced into whatever the second-best continuation is,
//                      which on a degenerate run is often another loop one
//                      n-gram wider.
//
// So: sample, but coldly. T=0.3 with top_p=0.9 keeps the output essentially as
// faithful as greedy for a factual summary while giving the decoder a real
// probability mass to escape a cycle, and the two penalties make the cycle
// expensive (repetition_penalty) and then impossible (no_repeat_ngram_size).
// max_new_tokens comes down from 220 to 120 — a 2-3 sentence gist plus an
// entity list does not need more, and the smaller budget also halves the
// worst-case latency that produced the 61.5s run.
//
// These are DEFAULTS, applied to every generate() call that does not override
// them, because an unsafe decoder must not be reachable by forgetting a field.
//
// ENGINE COVERAGE — what actually applies where:
//
//   WebGPU (transformers.js) — all of it. The text-generation pipeline accepts
//     do_sample / temperature / top_p / top_k / repetition_penalty /
//     no_repeat_ngram_size / max_new_tokens.
//   Nano (Chrome built-in Prompt API) — only `temperature` and `topK`, and only
//     at session `create()` time (they must be passed together, and are bounded
//     by `LanguageModel.params()`). There is NO repetition_penalty, NO
//     no_repeat_ngram_size and NO max_new_tokens on that API. For Nano the
//     backstop is validateGeneration(): degenerate output is caught after the
//     fact and never persisted.
//   Summarizer API — not used by this extension (we drive the Prompt API
//     directly, because the Summarizer exposes no decoding controls at all).

/**
 * Decoding options for one generation. Every field except `maxNewTokens` is
 * optional and falls back to the anti-degeneracy defaults below — a caller that
 * passes only `{ maxNewTokens }` still gets repetition control.
 */
export interface GenerationOptions {
  /** Token budget for the generated continuation (WebGPU only; Nano ignores). */
  readonly maxNewTokens: number;
  /** Hard character cap applied to the cleaned output. */
  readonly maxChars?: number;
  readonly repetitionPenalty?: number;
  readonly noRepeatNgramSize?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
}

/** The same shape with every field resolved — what the engines actually use. */
export interface ResolvedGenerationOptions {
  readonly maxNewTokens: number;
  readonly maxChars: number;
  readonly repetitionPenalty: number;
  readonly noRepeatNgramSize: number;
  readonly temperature: number;
  readonly topP: number;
  readonly topK: number;
}

// --- Named constants (no magic numbers at the call sites) -------------------

/** Penalize already-emitted tokens. 1.0 = off; >1.3 starts distorting facts. */
export const REPETITION_PENALTY = 1.15;
/** Hard-ban any 3-token sequence from occurring twice — kills "224 6 224 6". */
export const NO_REPEAT_NGRAM_SIZE = 3;
/** Cold sampling: an escape from a decode cycle without creative drift. */
export const GENERATION_TEMPERATURE = 0.3;
export const GENERATION_TOP_P = 0.9;
export const GENERATION_TOP_K = 40;

/** 2-3 sentences + an entity list. Was 220 — that budget bought 61.5s of loop. */
export const GIST_MAX_NEW_TOKENS = 120;
/** One sentence per document section in the chunk pass. */
export const CHUNK_GIST_MAX_NEW_TOKENS = 64;
/** 4-10 words. */
export const TITLE_MAX_NEW_TOKENS = 32;

/** Contract caps, mirrored here so the engine can enforce them on output. */
export const TITLE_OUTPUT_MAX_CHARS = 200;
export const GIST_OUTPUT_MAX_CHARS = 2000;
export const CHUNK_GIST_OUTPUT_MAX_CHARS = 400;

const DEFAULTS = {
  maxChars: TITLE_OUTPUT_MAX_CHARS,
  repetitionPenalty: REPETITION_PENALTY,
  noRepeatNgramSize: NO_REPEAT_NGRAM_SIZE,
  temperature: GENERATION_TEMPERATURE,
  topP: GENERATION_TOP_P,
  topK: GENERATION_TOP_K,
} as const;

/** Fill every unset field from the anti-degeneracy defaults. Pure. */
export const resolveGenerationOptions = (opts: GenerationOptions): ResolvedGenerationOptions => ({
  maxNewTokens: opts.maxNewTokens,
  maxChars: opts.maxChars ?? DEFAULTS.maxChars,
  repetitionPenalty: opts.repetitionPenalty ?? DEFAULTS.repetitionPenalty,
  noRepeatNgramSize: opts.noRepeatNgramSize ?? DEFAULTS.noRepeatNgramSize,
  temperature: opts.temperature ?? DEFAULTS.temperature,
  topP: opts.topP ?? DEFAULTS.topP,
  topK: opts.topK ?? DEFAULTS.topK,
});

// --- Presets ----------------------------------------------------------------

export const TITLE_GENERATION: GenerationOptions = {
  maxNewTokens: TITLE_MAX_NEW_TOKENS,
  maxChars: TITLE_OUTPUT_MAX_CHARS,
};

export const GIST_GENERATION: GenerationOptions = {
  maxNewTokens: GIST_MAX_NEW_TOKENS,
  maxChars: GIST_OUTPUT_MAX_CHARS,
};

export const CHUNK_GIST_GENERATION: GenerationOptions = {
  maxNewTokens: CHUNK_GIST_MAX_NEW_TOKENS,
  maxChars: CHUNK_GIST_OUTPUT_MAX_CHARS,
};

// --- Per-engine translation -------------------------------------------------

/**
 * The transformers.js text-generation call arguments. Pure so the exact decoding
 * config is assertable in a unit test rather than trusted.
 */
export const transformersGenerationArgs = (opts: GenerationOptions): Record<string, unknown> => {
  const o = resolveGenerationOptions(opts);
  return {
    max_new_tokens: o.maxNewTokens,
    // Cold sampling — see the module header for why not greedy.
    do_sample: true,
    temperature: o.temperature,
    top_p: o.topP,
    top_k: o.topK,
    repetition_penalty: o.repetitionPenalty,
    no_repeat_ngram_size: o.noRepeatNgramSize,
    return_full_text: false,
  };
};

/** What `LanguageModel.params()` reports, all fields best-effort. */
export interface NanoModelParams {
  readonly defaultTopK?: number;
  readonly maxTopK?: number;
  readonly defaultTemperature?: number;
  readonly maxTemperature?: number;
}

export interface NanoSamplingParams {
  readonly temperature: number;
  readonly topK: number;
}

/**
 * Chrome bounds the Prompt API's sampling knobs (maxTopK has historically been
 * as low as 8) and REJECTS create() when a value is out of range. Clamp to the
 * reported bounds — or to conservative fallbacks when params() is absent — so a
 * sampling request degrades instead of throwing. Pure.
 */
export const NANO_FALLBACK_MAX_TOP_K = 8;
export const NANO_FALLBACK_MAX_TEMPERATURE = 2;

export const clampNanoSampling = (
  opts: GenerationOptions,
  params: NanoModelParams | null,
): NanoSamplingParams => {
  const o = resolveGenerationOptions(opts);
  const maxTopK =
    typeof params?.maxTopK === 'number' && params.maxTopK > 0
      ? params.maxTopK
      : NANO_FALLBACK_MAX_TOP_K;
  const maxTemperature =
    typeof params?.maxTemperature === 'number' && params.maxTemperature > 0
      ? params.maxTemperature
      : NANO_FALLBACK_MAX_TEMPERATURE;
  return {
    temperature: Math.min(Math.max(o.temperature, 0), maxTemperature),
    topK: Math.min(Math.max(Math.round(o.topK), 1), Math.floor(maxTopK)),
  };
};
