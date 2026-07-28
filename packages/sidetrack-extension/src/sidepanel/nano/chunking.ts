// Chunking for chunk-then-synthesize gist generation.
//
// WHAT IT REPLACES. A long page used to be reduced to ONE head/middle/tail
// slice (sliceForSynthesis: 1400 + 400 + 400 chars) and handed to the model in a
// single pass. Two things are wrong with that: the middle of a document is
// sampled at 400 chars regardless of length — a 40k-char page contributes 1% of
// itself — and the joined slabs read as three unrelated fragments, which is
// exactly the kind of incoherent prompt that pushes a small quantized model into
// a degenerate decode.
//
// THE DESIGN. Split the document on paragraph boundaries into chunks of roughly
// 1200-1800 characters, gist each chunk in one sentence, then run ONE final
// synthesis pass over the concatenated chunk gists. Recursion is capped at that
// single extra level — the final pass never re-chunks (see gistSynthesis.ts).
//
// CAPS ARE REPORTED, NEVER SILENT. A document that produces more chunks than the
// per-run cap does not get quietly truncated: the plan says how many chunks
// exist, how many were used, and how many were dropped, and the UI shows it.
// When the cap bites we keep an EVENLY SPACED sample (always including the first
// and last chunk) rather than the first N — a head-only sample would summarize
// the introduction of a long document and call it the document.
//
// Pure module: no I/O, no model, no clock.

/** One chunk with its STABLE index in the full chunk list of the document. */
export interface TextChunk {
  readonly index: number;
  readonly text: string;
}

export interface ChunkPlan {
  /** The chunks that will actually be processed (already capped/sampled). */
  readonly chunks: readonly TextChunk[];
  /** How many chunks the document splits into in total. */
  readonly totalChunks: number;
  /** How many of them this run will process. */
  readonly usedChunks: number;
  /** totalChunks - usedChunks. Reported, never hidden. */
  readonly droppedChunks: number;
  /** True when the whole document fits in one chunk — the single-pass path. */
  readonly singlePass: boolean;
}

// Upper bound on one chunk. MEASURED, not reasoned about (2026-07-28, WebGPU
// gemma-3-1b q4, 3 real vault documents x 2 repetitions):
//
//   1800 chars/chunk   5.7 generations   26.4s median   groundedness 0.49
//   3600 chars/chunk   3.3 generations   17.3s median   groundedness 0.47
//   6000 chars/chunk   1.0 generation    78.1s          groundedness 0.36
//                      ...and then a HARD CRASH on the next document:
//                      "failed to call OrtRun() ... webgpu/buffer_manager.cc
//                      Download(WGPUBuffer...)"
//
// Two things fall out of that. Wider is faster up to a point, because latency
// on this stack is ~3.9ms per input token but ~37.5ms per OUTPUT token, and a
// wider chunk removes whole generations. And past that point prefill goes
// SUPERLINEAR and then the WebGPU backend fails outright — 6000 chars cost 6x
// what a linear model predicts before it crashed. So the ceiling here is not a
// context-window limit (the model has 8k); it is a GPU buffer limit, and it is
// found by measurement.
//
// 3600 is the widest value observed clean, across 8 runs, with a 1.7x margin to
// the width that crashed. Do not raise it without re-running that sweep.
export const CHUNK_MAX_CHARS = 3600;
/** Target floor — the packer fills greedily, so chunks land near the max. */
export const CHUNK_MIN_CHARS = 2400;
/**
 * Chunks processed per gist run. 6 x ~3600 = ~21.6k chars of real coverage —
 * the width increase DOUBLED coverage at the same cap, rather than trading it
 * away for speed.
 */
export const MAX_PROCESSED_CHUNKS = 6;

// ---------------------------------------------------------------------------
// Language-aware chunk width — the fix for "Chinese pages crash the engine".
// ---------------------------------------------------------------------------
//
// THE BUG (measured 2026-07-28, live vault). CHUNK_MAX_CHARS is a CHARACTER
// budget, tuned on English. But the thing that actually blows up the WebGPU
// backend is TOKENS, and the two are not proportional across languages:
//
//     English  ~4 characters per token
//     Chinese  ~1 character per token
//
// So a 3600-character chunk is ~900 tokens of English and ~3600 tokens of
// Chinese — four times the load, straight past the context cliff. Feeding a
// real Chinese page from the vault to the shipped 3600-char chunker produced,
// on the FIRST document every time:
//
//     failed to call OrtRun() ... webgpu/buffer_manager.cc Download(...)
//
// This was not cumulative wear: running the Chinese documents FIRST crashed
// immediately, and running them last crashed too. The lane that exists
// specifically to handle Chinese — because Nano and Apple both refuse it —
// could not process Chinese at all.
//
// THE FIX. Budget in TOKENS and convert to characters per language. The
// English behaviour is unchanged by construction (900 x 4 = 3600, exactly the
// measured-clean width); Chinese lands near 1100, and 1200 was measured to
// complete all three Chinese documents cleanly where 1800 still crashed one.

/**
 * Token budget for one chunk. Derived, not invented: it is the measured-clean
 * English width (CHUNK_MAX_CHARS) divided by English's ~4 chars/token. Every
 * language's character width is this number times its own density, so the
 * cliff is respected in the unit that actually causes it.
 */
export const TARGET_CHUNK_TOKENS = 900;

/**
 * Characters per token, per content language. Approximate by nature — a real
 * tokenizer count would be exact but is not available at planning time without
 * loading the model, and being conservative costs a little coverage while being
 * wrong costs a crash that poisons the whole session.
 *
 * 'mixed-en-zh' deliberately takes the CHINESE-leaning value rather than an
 * average: a document the detector calls mixed can still be locally dense with
 * Chinese, and the failure is asymmetric — too narrow is slower, too wide is
 * fatal.
 */
export const CHARS_PER_TOKEN: Readonly<Record<'en' | 'zh' | 'mixed-en-zh', number>> = {
  en: 4,
  zh: 1.2,
  'mixed-en-zh': 2,
};

/**
 * The chunk width to use for this content language, in characters. Never wider
 * than CHUNK_MAX_CHARS — this only ever NARROWS, so no language can push the
 * planner past the width that was measured safe.
 */
export const chunkWidthForLanguage = (
  language: 'en' | 'zh' | 'mixed-en-zh',
): number =>
  Math.min(CHUNK_MAX_CHARS, Math.floor(TARGET_CHUNK_TOKENS * CHARS_PER_TOKEN[language]));

/** Separator used when several paragraphs are packed into one chunk. */
const CHUNK_JOIN = '\n\n';

// Sentence terminators used only when a single paragraph exceeds CHUNK_MAX_CHARS
// and must be broken anyway. CJK terminators included — a Chinese page is one of
// the two languages this vault actually contains.
const SENTENCE_END = new Set(['.', '!', '?', '。', '！', '？', '\n']);

/** Normalize line endings and trim. Pure. */
const normalize = (text: string): string => text.replace(/\r\n?/gu, '\n').trim();

/**
 * Break an over-long unit at sentence boundaries, keeping each sentence's own
 * terminator and trailing whitespace so nothing is lost.
 */
const splitSentences = (unit: string): readonly string[] => {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < unit.length) {
    if (!SENTENCE_END.has(unit.charAt(i))) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < unit.length && /\s/u.test(unit.charAt(j))) j += 1;
    out.push(unit.slice(start, j));
    start = j;
    i = j;
  }
  if (start < unit.length) out.push(unit.slice(start));
  return out.filter((s) => s.trim().length > 0);
};

/** Last resort for a single unbroken run longer than the max: hard slice. */
const hardSlice = (unit: string, max: number): readonly string[] => {
  const out: string[] = [];
  for (let i = 0; i < unit.length; i += max) out.push(unit.slice(i, i + max));
  return out;
};

/**
 * The document's atomic units, each guaranteed <= max chars: paragraphs where
 * possible, sentences where a paragraph is too long, a hard slice where a single
 * "sentence" is too long (minified text, a giant table row).
 */
const unitsOf = (text: string, max: number): readonly string[] => {
  const paragraphs = text
    .split(/\n[ \t]*\n+/u)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const units: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= max) {
      units.push(paragraph);
      continue;
    }
    for (const sentence of splitSentences(paragraph)) {
      const trimmed = sentence.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.length <= max) {
        units.push(trimmed);
        continue;
      }
      units.push(...hardSlice(trimmed, max));
    }
  }
  return units;
};

/**
 * Greedily pack units into chunks, never exceeding `max` and never splitting a
 * unit that already fits. Chunks therefore land close to the max (and above
 * CHUNK_MIN_CHARS) except possibly the last one, which takes what is left.
 */
const packUnits = (units: readonly string[], max: number): readonly string[] => {
  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    if (current.length === 0) {
      current = unit;
      continue;
    }
    if (current.length + CHUNK_JOIN.length + unit.length <= max) {
      current = `${current}${CHUNK_JOIN}${unit}`;
      continue;
    }
    chunks.push(current);
    current = unit;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

/**
 * Pick `k` evenly spaced indices out of `n`, always including the first and the
 * last, so a capped run still covers the whole document instead of its opening.
 */
export const selectEvenlySpaced = (n: number, k: number): readonly number[] => {
  if (n <= 0 || k <= 0) return [];
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  if (k === 1) return [0];
  const picked = new Set<number>();
  for (let i = 0; i < k; i += 1) picked.add(Math.round((i * (n - 1)) / (k - 1)));
  return [...picked].sort((a, b) => a - b);
};

export interface ChunkOptions {
  readonly maxChars?: number;
  readonly maxChunks?: number;
}

/**
 * Plan how a document is chunked for gist synthesis. Pure and deterministic.
 *
 * Empty/whitespace input yields an empty plan (no chunks, singlePass true) so
 * the caller's thin-content gate — not this module — decides what to do about
 * nothing.
 */
export const planChunks = (text: string, options: ChunkOptions = {}): ChunkPlan => {
  const max = options.maxChars ?? CHUNK_MAX_CHARS;
  const cap = options.maxChunks ?? MAX_PROCESSED_CHUNKS;
  const normalized = normalize(text);
  if (normalized.length === 0) {
    return { chunks: [], totalChunks: 0, usedChunks: 0, droppedChunks: 0, singlePass: true };
  }
  if (normalized.length <= max) {
    return {
      chunks: [{ index: 0, text: normalized }],
      totalChunks: 1,
      usedChunks: 1,
      droppedChunks: 0,
      singlePass: true,
    };
  }
  const all = packUnits(unitsOf(normalized, max), max);
  const selected = selectEvenlySpaced(all.length, cap);
  const chunks = selected.map((index) => ({ index, text: all[index] ?? '' }));
  return {
    chunks,
    totalChunks: all.length,
    usedChunks: chunks.length,
    droppedChunks: all.length - chunks.length,
    singlePass: all.length <= 1,
  };
};
