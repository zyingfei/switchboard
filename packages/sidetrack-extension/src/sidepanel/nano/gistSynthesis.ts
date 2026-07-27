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

import { planChunks, type ChunkPlan } from './chunking';
import { CHUNK_GIST_GENERATION, GIST_GENERATION } from './generationOptions';
import { detectContentLanguage } from './language';
import {
  CHUNK_GIST_PROMPT_PREFIX,
  GIST_PROMPT_PREFIX,
  GIST_SYNTHESIS_PROMPT_PREFIX,
  MAX_GIST_CHARS,
  MIN_CONTENT_CHARS,
  sliceForSynthesis,
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

const metaOf = (plan: ChunkPlan, keptChunkGists: number, passes: 1 | 2): GistMeta => ({
  totalChunks: plan.totalChunks,
  usedChunks: plan.usedChunks,
  droppedChunks: plan.droppedChunks,
  keptChunkGists,
  passes,
});

const EMPTY_META: GistMeta = {
  totalChunks: 0,
  usedChunks: 0,
  droppedChunks: 0,
  keptChunkGists: 0,
  passes: 1,
};

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
export const synthesizeGist = async (
  engine: Pick<GenerationEngine, 'generate'>,
  content: string,
): Promise<GistOutcome> => {
  if (content.trim().length < MIN_CONTENT_CHARS) {
    return { ok: false, kind: 'thin', meta: EMPTY_META };
  }
  // The gist must come back in the language the SOURCE is written in; the
  // validator enforces it on every pass.
  const language = detectContentLanguage(content);
  const plan = planChunks(content);
  if (plan.chunks.length === 0) {
    return { ok: false, kind: 'thin', meta: metaOf(plan, 0, 1) };
  }

  // --- Single pass: the document fits in one chunk. ------------------------
  if (plan.singlePass) {
    const only = plan.chunks[0];
    const raw = await engine.generate(
      `${GIST_PROMPT_PREFIX}\n${only === undefined ? '' : only.text}`,
      GIST_GENERATION,
    );
    const meta = metaOf(plan, 0, 1);
    if (isAbstention(raw)) return { ok: false, kind: 'abstained', meta };
    const verdict = validateGeneration(raw.slice(0, MAX_GIST_CHARS), { kind: 'gist', language });
    if (!verdict.ok) return { ok: false, kind: 'rejected', reason: verdict.reason, meta };
    return { ok: true, gist: verdict.text, meta };
  }

  // --- Chunk pass: one validated sentence per chunk. -----------------------
  const notes: string[] = [];
  let firstRejection: GenerationRejectionReason | null = null;
  for (const chunk of plan.chunks) {
    const raw = await engine.generate(
      `${CHUNK_GIST_PROMPT_PREFIX}\n${chunk.text}`,
      CHUNK_GIST_GENERATION,
    );
    if (isAbstention(raw)) continue;
    const verdict = validateGeneration(raw, { kind: 'chunk-gist', language });
    if (!verdict.ok) {
      firstRejection ??= verdict.reason;
      continue;
    }
    notes.push(verdict.text);
  }
  if (notes.length === 0) {
    const meta = metaOf(plan, 0, 2);
    return firstRejection === null
      ? { ok: false, kind: 'abstained', meta }
      : { ok: false, kind: 'rejected', reason: firstRejection, meta };
  }

  // --- Final pass: ONE synthesis over the notes. Depth stops here. ---------
  // The input is only ever the chunk sentences. If they somehow exceed a single
  // prompt budget we SLICE them (the existing head/middle/tail reducer) rather
  // than chunking again — that is what caps recursion at one extra level.
  const meta = metaOf(plan, notes.length, 2);
  const joined = sliceForSynthesis(notes.map((n) => `- ${n}`).join('\n'));
  const raw = await engine.generate(`${GIST_SYNTHESIS_PROMPT_PREFIX}\n${joined}`, GIST_GENERATION);
  if (isAbstention(raw)) return { ok: false, kind: 'abstained', meta };
  const verdict = validateGeneration(raw.slice(0, MAX_GIST_CHARS), { kind: 'gist', language });
  if (!verdict.ok) return { ok: false, kind: 'rejected', reason: verdict.reason, meta };
  return { ok: true, gist: verdict.text, meta };
};
