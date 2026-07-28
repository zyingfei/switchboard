// Gist synthesis — chunk-then-synthesize, validated, engine-agnostic.
//
// The old path was: take the whole page, reduce it to ONE head/middle/tail
// slice, ask a 1B q4 model for "2-3 sentences + entities", trim, check it isn't
// empty or the literal "SKIP", POST it. On 2026-07-27 that pipeline saved
// "2 224 6 224 6 224 6 …" to the companion after 61.5 seconds.
//
// This module replaces it with:
//
//   1. planChunks()  — paragraph-aligned chunks of ~1200-1800 chars, capped at
//                      MAX_PROCESSED_CHUNKS with the drop count REPORTED.
//   2. single pass   — a document that fits in one chunk is summarized directly
//                      (exactly the old behavior, minus the lossy slicing).
//   3. chunk pass    — otherwise one factual SENTENCE per chunk.
//   4. final pass    — ONE synthesis over the concatenated chunk sentences.
//                      Depth is capped here: the final pass never re-chunks, it
//                      slices if the notes somehow exceed a chunk. No recursion.
//
// Every model output — each chunk sentence AND the final gist — goes through
// validateGeneration() before it is used or returned. A chunk sentence that
// fails is DROPPED (one bad section must not lose the document); a final gist
// that fails is REJECTED with its typed reason and nothing is saved.
//
// No React, no fetch, no chrome.* — pure orchestration over an injected engine
// so it is unit-testable with a stub.

import {
  CHUNK_MAX_CHARS,
  chunkWidthForLanguage,
  planChunks,
  type ChunkPlan,
} from './chunking';
import {
  limitsFor,
  prepareInput,
  type EngineLimits,
} from './engineLimits';
import {
  CHUNK_GIST_GENERATION,
  CHUNK_GIST_OUTPUT_MAX_CHARS,
  GIST_GENERATION,
  type GenerationOptions,
} from './generationOptions';
import { detectContentLanguage, type ContentLanguage } from './language';
import {
  CHUNK_GIST_PROMPT_PREFIX,
  GIST_PROMPT_PREFIX,
  GIST_SYNTHESIS_PROMPT_PREFIX,
  MAX_GIST_CHARS,
  MIN_CONTENT_CHARS,
  sliceForSynthesis,
  stripGistPreamble,
} from './titleSynthesis';
import { validateGeneration, type GenerationRejectionReason } from './validateGeneration';
import type { GenerationEngine } from './engine';

/** What the run actually did — surfaced in the UI, never hidden. */
export interface GistMeta {
  /** Chunks the document splits into. */
  readonly totalChunks: number;
  /** Chunks this run summarized. */
  readonly usedChunks: number;
  /** totalChunks - usedChunks, dropped by the per-run cap. */
  readonly droppedChunks: number;
  /** Chunk sentences that passed validation and fed the final pass. */
  readonly keptChunkGists: number;
  /** 1 = single-pass; 2 = chunk pass + final synthesis pass. Never more. */
  readonly passes: 1 | 2;
  /** Characters in the source document, before any cap applied. */
  readonly inputChars: number;
  /** Characters actually handed to the model across the run. */
  readonly processedChars: number;
  /** True when the engine's input cap reduced the document. NEVER hidden. */
  readonly inputReduced: boolean;
  /** The per-call input cap that applied (engineLimits.ts). */
  readonly maxInputChars: number;
}

export type GistOutcome =
  | { readonly ok: true; readonly gist: string; readonly meta: GistMeta }
  /** Source content below MIN_CONTENT_CHARS — never asked the model. */
  | { readonly ok: false; readonly kind: 'thin'; readonly meta: GistMeta }
  /** The model explicitly declined (SKIP) or returned nothing at all. */
  | { readonly ok: false; readonly kind: 'abstained'; readonly meta: GistMeta }
  /** The model produced text, and the text is unusable. */
  | {
      readonly ok: false;
      readonly kind: 'rejected';
      readonly reason: GenerationRejectionReason;
      readonly meta: GistMeta;
    };

const metaOf = (
  plan: ChunkPlan,
  keptChunkGists: number,
  passes: 1 | 2,
  inputChars: number,
  maxInputChars: number,
): GistMeta => {
  // What the model actually SAW: the sum of the chunks this run processed. The
  // difference from the document length is the reduction — reported, never
  // implied by a shorter-than-expected gist.
  const processedChars = plan.chunks.reduce((sum, c) => sum + c.text.length, 0);
  return {
    totalChunks: plan.totalChunks,
    usedChunks: plan.usedChunks,
    droppedChunks: plan.droppedChunks,
    keptChunkGists,
    passes,
    inputChars,
    processedChars,
    inputReduced: processedChars < inputChars,
    maxInputChars,
  };
};

const emptyMeta = (inputChars: number, maxInputChars: number): GistMeta => ({
  totalChunks: 0,
  usedChunks: 0,
  droppedChunks: 0,
  keptChunkGists: 0,
  passes: 1,
  inputChars,
  processedChars: 0,
  inputReduced: false,
  maxInputChars,
});

/** A model reply that means "I have nothing" rather than "here is my answer". */
const isAbstention = (raw: string): boolean => {
  const t = raw.trim();
  return t.length === 0 || t === 'SKIP';
};

/**
 * Generate a gist from raw content through a ready engine.
 *
 * Returns a typed outcome — the caller renders the reason and, on anything but
 * `ok`, saves NOTHING. Engine errors are not caught here: they are the caller's
 * existing 'engine' failure path.
 */

// ---- fast-success / fast-fail generation --------------------------------
//
// One attempt is not enough and ten is too many. A 1B model on a hard
// document fails in ways that are often NOT deterministic — the same input
// resampled usually comes back clean. So: generate, validate, and on
// rejection retry ONCE with a deterministic decode (greedy), which is a
// genuinely different draw rather than the same dice rolled again.
//
// FAST SUCCESS: the first attempt that validates is returned immediately —
// no extra model calls, no scoring pass, nothing speculative.
// FAST FAIL: an abstention (SKIP) is final and never retried — the model
// saying "this text cannot be summarized" is an answer, not a failure. Only
// a VALIDATION rejection earns the second attempt, and only one.
//
// Retry cost is bounded and visible: at most 2 calls per gist, and the
// caller sees which attempt won via `attempts` in the meta.
// The retry is a genuinely DIFFERENT draw, not the same dice re-rolled: near
// -zero temperature makes the second attempt effectively deterministic, so a
// rejection caused by an unlucky sample does not simply recur.
const RETRY_GENERATION: GenerationOptions = { ...GIST_GENERATION, temperature: 0.05, topP: 1 };

interface AttemptOutcome {
  readonly text: string | null;
  readonly reason: GenerationRejectionReason | null;
  readonly abstained: boolean;
  readonly attempts: number;
}

const generateValidated = async (
  engine: Pick<GenerationEngine, 'generate'>,
  prompt: string,
  language: ContentLanguage,
  kind: 'gist' | 'chunk-gist',
  primary: GenerationOptions,
  retry: GenerationOptions | null,
  maxChars: number,
  /**
   * The INSTRUCTION text only — never the source — for echo detection.
   *
   * looksLikePromptEcho flags an output that shares >30% of its 3-grams with
   * whatever string it is given. Handing it the full prompt means comparing the
   * summary against the DOCUMENT, and a faithful summary reuses the document's
   * wording by definition. The rule's own message says what it is for: "the
   * model repeated the instructions instead of summarizing".
   *
   * This bit for real on the synthesis pass, where the "source" is the chunk
   * notes — text the final gist exists to restate — so a correct gist was
   * rejected as an echo of itself.
   */
  instructions: string,
  /**
   * The source this generation must be made OF — the chunk for a chunk-gist,
   * the notes for the synthesis, the document for a single pass. Enables the
   * groundedness rule, the only one that catches a fluent invented summary.
   */
  source: string,
): Promise<AttemptOutcome> => {
  let firstReason: GenerationRejectionReason | null = null;
  const passes = retry === null ? [primary] : [primary, retry];
  for (let i = 0; i < passes.length; i += 1) {
    const options = passes[i];
    if (options === undefined) continue;
    const raw = await engine.generate(prompt, options);
    // SKIP is a decision, not a defect — stop immediately.
    if (isAbstention(raw)) return { text: null, reason: null, abstained: true, attempts: i + 1 };
    const cleaned = stripGistPreamble(raw).slice(0, maxChars);
    const verdict = validateGeneration(cleaned, { kind, language, prompt: instructions, source });
    if (verdict.ok) return { text: verdict.text, reason: null, abstained: false, attempts: i + 1 };
    firstReason ??= verdict.reason;
  }
  return { text: null, reason: firstReason, abstained: false, attempts: passes.length };
};

export const synthesizeGist = async (
  engine: Pick<GenerationEngine, 'generate'> & Partial<Pick<GenerationEngine, 'kind' | 'limits'>>,
  content: string,
  limitsOverride?: EngineLimits,
): Promise<GistOutcome> => {
  // The engine's own limits win; a bare stub falls back to its kind's table,
  // and a kindless stub to the permissive local default. An explicit override
  // is the test seam AND the way a caller pins limits it already resolved.
  const limits: EngineLimits =
    limitsOverride ?? engine.limits ?? limitsFor(engine.kind ?? 'webgpu');
  const inputChars = content.length;
  if (content.trim().length < MIN_CONTENT_CHARS) {
    return { ok: false, kind: 'thin', meta: emptyMeta(inputChars, limits.maxInputChars) };
  }
  // The gist must come back in the language the SOURCE is written in; the
  // validator enforces it on every pass.
  const language = detectContentLanguage(content);
  // ENFORCE the per-call input cap by NARROWING THE CHUNK WIDTH — the same
  // paragraph-aligned chunking the pipeline already uses. An engine with a cap
  // below the standard chunk therefore gets more, smaller chunks rather than
  // one silently truncated one.
  //
  // The width is also LANGUAGE-AWARE (chunking.ts). CHUNK_MAX_CHARS is a
  // character budget tuned on English at ~4 chars/token; Chinese runs ~1
  // char/token, so the same character count is four times the tokens and
  // crashed the WebGPU backend on the first Chinese document every time. The
  // language width converts a token budget into characters, so English is
  // unchanged and Chinese is narrowed to something that actually runs.
  const chunkWidth = Math.min(
    CHUNK_MAX_CHARS,
    limits.maxInputChars,
    chunkWidthForLanguage(language),
  );
  const plan = planChunks(content, { maxChars: chunkWidth });
  if (plan.chunks.length === 0) {
    return { ok: false, kind: 'thin', meta: metaOf(plan, 0, 1, inputChars, limits.maxInputChars) };
  }

  // --- Single pass: the document fits in one chunk. ------------------------
  if (plan.singlePass) {
    const only = plan.chunks[0];
    const meta = metaOf(plan, 0, 1, inputChars, limits.maxInputChars);
    const outcome = await generateValidated(
      engine,
      `${GIST_PROMPT_PREFIX}\n${only === undefined ? '' : only.text}`,
      language,
      'gist',
      GIST_GENERATION,
      RETRY_GENERATION,
      MAX_GIST_CHARS,
      GIST_PROMPT_PREFIX,
      only === undefined ? '' : only.text,
    );
    if (outcome.abstained) return { ok: false, kind: 'abstained', meta };
    if (outcome.text === null) {
      return { ok: false, kind: 'rejected', reason: outcome.reason ?? 'empty', meta };
    }
    return { ok: true, gist: outcome.text, meta };
  }

  // --- Chunk pass: one validated sentence per chunk. -----------------------
  // Through generateValidated so each note is STRIPPED before it is validated
  // and before it is handed to the synthesis. A note that still says
  // "Summary: ..." becomes part of the final pass's input and invites the model
  // to echo the shape straight back out.
  //
  // retry = null on purpose: a bad chunk note is DROPPED, not retried. One bad
  // section must not lose the document, and retrying every chunk would double
  // the cost of the most expensive pass for the least valuable output.
  const notes: string[] = [];
  let firstRejection: GenerationRejectionReason | null = null;
  for (const chunk of plan.chunks) {
    const outcome = await generateValidated(
      engine,
      `${CHUNK_GIST_PROMPT_PREFIX}\n${chunk.text}`,
      language,
      'chunk-gist',
      CHUNK_GIST_GENERATION,
      null,
      CHUNK_GIST_OUTPUT_MAX_CHARS,
      CHUNK_GIST_PROMPT_PREFIX,
      chunk.text,
    );
    if (outcome.abstained) continue;
    if (outcome.text === null) {
      firstRejection ??= outcome.reason;
      continue;
    }
    notes.push(outcome.text);
  }
  if (notes.length === 0) {
    const meta = metaOf(plan, 0, 2, inputChars, limits.maxInputChars);
    return firstRejection === null
      ? { ok: false, kind: 'abstained', meta }
      : { ok: false, kind: 'rejected', reason: firstRejection, meta };
  }

  // --- Final pass: ONE synthesis over the notes. Depth stops here. ---------
  // The input is only ever the chunk sentences. If they somehow exceed a single
  // prompt budget we SLICE them (the existing head/middle/tail reducer) rather
  // than chunking again — that is what caps recursion at one extra level.
  const meta = metaOf(plan, notes.length, 2, inputChars, limits.maxInputChars);
  // The notes go through the existing head/middle/tail reducer AND the engine's
  // own cap — a final prompt that overruns the cap would fail the same way a
  // too-long chunk would, and prepareInput reduces through the chunking path.
  const joined = prepareInput(
    sliceForSynthesis(notes.map((n) => `- ${n}`).join('\n')),
    limits.maxInputChars,
  ).text;
  // THROUGH THE SAME HELPER AS THE SINGLE-PASS PATH. This used to be bespoke
  // inline code, and it drifted in three ways that all reached the user
  // (reported live 2026-07-28: a saved gist reading "Summary: Anthropic CEO
  // has decided..."):
  //
  //   1. NO stripGistPreamble — so "Summary: ", "Here is ...", and markdown
  //      bold survived into the saved gist. The stripper existed and was only
  //      ever wired into the single-pass path, so every MULTI-CHUNK document
  //      leaked exactly what it was written to remove.
  //   2. NO retry — the single-pass path retries once with a near-deterministic
  //      decode, so a long document got strictly fewer chances than a short one
  //      for no defensible reason.
  //   3. The WRONG prompt for echo-detection: it validated against
  //      GIST_PROMPT_PREFIX while generating from GIST_SYNTHESIS_PROMPT_PREFIX,
  //      so prompt-echo of the synthesis instructions could not be detected.
  //
  // Two code paths doing "the same thing" is how all three happened. There is
  // now one.
  const outcome = await generateValidated(
    engine,
    `${GIST_SYNTHESIS_PROMPT_PREFIX}\n${joined}`,
    language,
    'gist',
    GIST_GENERATION,
    RETRY_GENERATION,
    MAX_GIST_CHARS,
    GIST_SYNTHESIS_PROMPT_PREFIX,
    joined,
  );
  if (outcome.abstained) return { ok: false, kind: 'abstained', meta };
  if (outcome.text === null) {
    return { ok: false, kind: 'rejected', reason: outcome.reason ?? 'empty', meta };
  }
  return { ok: true, gist: outcome.text, meta };
};
