import { fnv1a32Hex } from '../../graph/fnv1a';
import { NANO_SESSION_LANGUAGES, detectContentLanguage, nanoCanServe } from './language';
import {
  TITLE_GENERATION,
  clampNanoSampling,
  type NanoModelParams,
  type NanoSamplingParams,
} from './generationOptions';
import { validateGeneration } from './validateGeneration';

// Title synthesis on Gemini Nano (Chrome built-in Prompt API), extracted from
// the OnDeviceAiRow eval so the observe-only eval AND the budgeted background
// enrichment worker share ONE synthesis path — same session settings, same
// prompt, same SKIP/thin discipline. The row keeps rendering before→after for
// human judgment; the worker PERSISTS the results via the companion.
//
// The Prompt API is exposed only to extension pages on Chrome 138+; every call
// is feature-detected and guarded. `create()` triggers a multi-GB download the
// first time — callers gate it behind explicit user intent / an 'available'
// availability read.

// Minimal ambient shape for the built-in Prompt API — not yet in TS's DOM lib.
export interface BuiltinLanguageModel {
  availability: () => Promise<string>;
  /**
   * Sampling bounds for this device. Optional: older Chromes do not expose it,
   * and when it is missing we clamp to conservative fallbacks instead.
   */
  params?: () => Promise<NanoModelParams | undefined>;
  create: (options?: {
    monitor?: (m: {
      addEventListener: (type: 'downloadprogress', cb: (e: { loaded: number }) => void) => void;
    }) => void;
    expectedInputs?: readonly { type: 'text'; languages: readonly string[] }[];
    expectedOutputs?: readonly { type: 'text'; languages: readonly string[] }[];
    /** Prompt-API decoding controls. Must be passed together or create throws. */
    temperature?: number;
    topK?: number;
  }) => Promise<{ destroy: () => void; prompt: (text: string) => Promise<string> }>;
}

export interface NanoSession {
  destroy: () => void;
  prompt: (text: string) => Promise<string>;
}

export const builtinLanguageModel = (): BuiltinLanguageModel | undefined => {
  const candidate = (globalThis as { LanguageModel?: unknown }).LanguageModel;
  if (candidate === undefined || candidate === null) return undefined;
  return candidate as BuiltinLanguageModel;
};

// A Nano session declares ONLY languages Chrome's built-in Prompt API actually
// supports (en, ja, es, de, fr — see language.ts). It used to declare
// ['en','zh']: the vault IS bilingual, but Chinese is not on that list, so the
// declaration was a promise the model cannot keep — fed zh it answers in the
// wrong language or refuses. Chinese now routes to the multilingual WebGPU
// engine instead (routeEnrichmentEngine), and this session declares 'en', the
// only bucket ever routed here. Older Chromes that reject the language options
// fall back to a plain create().
export const SESSION_LANGUAGES: readonly string[] = NANO_SESSION_LANGUAGES;

/**
 * Read this device's Prompt-API sampling bounds, best-effort. Never throws; a
 * browser without `params()` yields null and the caller clamps to fallbacks.
 */
export const readNanoParams = async (lm: BuiltinLanguageModel): Promise<NanoModelParams | null> => {
  try {
    return (await lm.params?.()) ?? null;
  } catch {
    return null;
  }
};

/** Resolve the sampling params to hand Nano for one generation preset. */
export const nanoSamplingFor = async (
  lm: BuiltinLanguageModel,
  opts: Parameters<typeof clampNanoSampling>[0],
): Promise<NanoSamplingParams> => clampNanoSampling(opts, await readNanoParams(lm));

/**
 * Create a Nano session, optionally with explicit decoding params.
 *
 * The Prompt API's ONLY anti-degeneracy lever is `temperature` + `topK` at
 * create() time (no repetition penalty, no n-gram ban — see
 * generationOptions.ts). Chrome REJECTS out-of-range values, so the request
 * degrades in three steps rather than failing the whole generation:
 * sampling+languages → languages → plain. Callers that pass no sampling get
 * exactly the previous behavior.
 */
export const createNanoSession = async (
  lm: BuiltinLanguageModel,
  sampling?: NanoSamplingParams,
): Promise<NanoSession> => {
  const languageOptions = {
    expectedInputs: [{ type: 'text' as const, languages: SESSION_LANGUAGES }],
    expectedOutputs: [{ type: 'text' as const, languages: SESSION_LANGUAGES }],
  };
  if (sampling !== undefined) {
    try {
      return await lm.create({
        ...languageOptions,
        temperature: sampling.temperature,
        topK: sampling.topK,
      });
    } catch {
      // Out-of-range or unsupported sampling params — keep the session, lose
      // the knobs. validateGeneration() is the backstop either way.
    }
  }
  try {
    return await lm.create(languageOptions);
  } catch {
    return await lm.create();
  }
};

// Content-only prompt: title from the text alone, same language as the
// conversation, and an explicit SKIP escape hatch for content too thin to
// title faithfully. No vocabulary lists, no URL/metadata leakage.
export const TITLE_PROMPT_PREFIX = [
  'You title documents for a personal research organizer.',
  'Write ONE descriptive title, 4 to 10 words, for the conversation below.',
  'Write the title in the SAME language the conversation is mostly written',
  'in (English conversation → English title, 中文对话 → 中文标题).',
  'Use ONLY facts present in the text. Name the specific technology,',
  'product, or question discussed. No quotes, no trailing punctuation.',
  'If the text is too thin to title faithfully, reply exactly: SKIP',
  '',
  'Conversation:',
  '---',
].join('\n');

// Content-only GIST prompt (feat/webgpu-enrichment): a short factual summary
// used by the on-demand content-enrichment action, POSTed to the companion's
// /v1/enrichment/content endpoint to enrich the recommendation corpus with a
// dense semantic gist (title lane gets a title; content lane gets this). Same
// same-language + content-only + SKIP discipline as the title prompt; the
// generated gist is capped to the contract's ≤2000 chars by the caller.
// TUNED on the real model (2026-07-27). The previous wording asked for "no
// meta-commentary" and the model ignored it: every single tuning run opened
// with "Here's a summarized overview of the provided content..." plus
// markdown headers. Naming the failure explicitly ("do NOT write a preamble",
// "begin immediately with the subject") removed it in 3/3 documents. Asking
// for plain sentences also dropped the markdown scaffolding that was ending
// up in the retrieval corpus.
export const GIST_PROMPT_PREFIX = [
  'Summarize the document below in 2 to 3 plain sentences.',
  'Begin immediately with the subject matter.',
  'Do NOT write an introduction, a preamble, or a phrase like "Here is a summary".',
  'Do NOT use markdown, headings, bullet points, or bold text.',
  'Write in the SAME language the document is mostly written in',
  '(English document → English summary, 中文内容 → 中文摘要).',
  'Use ONLY facts stated in the document. Do not invent names or products.',
  'If the document is too thin to summarize, reply exactly: SKIP',
  '',
  'Document:',
  '---',
].join('\n');

// CHUNK pass of the chunk-then-synthesize gist path (chunking.ts): one factual
// sentence about ONE section of a document. Deliberately narrower than the gist
// prompt — asking a 1B model for "2-3 sentences + entities" about a 1800-char
// fragment invites padding, and padding is where the repetition loops start.
// The "at most 20 words" bound is LOAD-BEARING for latency, and it has to live
// in the instruction rather than in max_new_tokens. Measured (2026-07-28): with
// only "ONE factual sentence" the notes averaged 38 tokens against a 64-token
// cap — the model was nowhere near its cap, so lowering the cap alone would
// merely have truncated mid-sentence. Adding the explicit bound cut the whole
// pipeline's output tokens 338 -> 206 and its median latency 26.4s -> 20.2s
// with groundedness UNCHANGED at 0.49 and 6/6 outputs still passing validation.
// These sentences are intermediate notes the user never reads; they only feed
// the final synthesis, so length beyond a sentence is pure cost.
export const CHUNK_GIST_PROMPT_PREFIX = [
  'You summarize documents for a personal research organizer.',
  'Write ONE factual sentence, at most 20 words, describing what this SECTION',
  'of a document says.',
  'Write in the SAME language the section is mostly written in',
  '(English section → English sentence, 中文段落 → 中文句子).',
  'Use ONLY facts present in the text. No preamble, no meta-commentary, no',
  'quotes of these instructions.',
  'If the section is too thin to summarize faithfully, reply exactly: SKIP',
  '',
  'Section:',
  '---',
].join('\n');

// FINAL pass of the chunk-then-synthesize gist path: merge the per-section
// sentences into the 2-3 sentence gist. Its input is only ever the chunk gists,
// never raw page text — that is what caps the recursion at one extra level.
export const GIST_SYNTHESIS_PROMPT_PREFIX = [
  'You summarize documents for a personal research organizer.',
  'Below are one-sentence notes taken from consecutive sections of ONE',
  'document, in reading order. Merge them into a factual 2 to 3 sentence',
  'summary of the whole document, then list the key entities (people,',
  'products, technologies, questions) it covers.',
  'Write in the SAME language the notes are mostly written in',
  '(English notes → English summary, 中文笔记 → 中文摘要).',
  'Use ONLY facts present in the notes. Do not mention the notes, the',
  'sections, or these instructions.',
  '',
  'Notes:',
  '---',
].join('\n');

// A synthesized gist is capped to the content contract's ≤2000 chars.
export const MAX_GIST_CHARS = 2000;

// Content thinner than this cannot be titled faithfully — matches the eval's
// gate so the worker skips the same threads the human eval marks "too thin".
export const MIN_CONTENT_CHARS = 80;

// A synthesized title is capped to the contract's ≤200 chars.
export const MAX_TITLE_CHARS = 200;

// Slicing budgets. Content this long or shorter passes through verbatim;
// longer content is sampled head + middle + tail so the title reflects the
// WHOLE conversation, not just the opening.
export const SLICE_THRESHOLD_CHARS = 2200;
const HEAD_CHARS = 1400;
const MIDDLE_CHARS = 400;
const TAIL_CHARS = 400;
const SLICE_MARKER = '\n…\n';

/**
 * Reduce long content to a representative sample for synthesis: the head
 * (~1400 chars, where the topic is stated), a middle slab (~400 chars, taken
 * around the content's midpoint), and the tail (~400 chars, where a
 * conversation often resolves) — joined with '…' markers. Content at or below
 * the threshold passes through unchanged. Pure + unit-tested.
 */
export const sliceForSynthesis = (content: string): string => {
  if (content.length <= SLICE_THRESHOLD_CHARS) return content;
  const head = content.slice(0, HEAD_CHARS);
  const midStart = Math.floor(content.length / 2 - MIDDLE_CHARS / 2);
  const middle = content.slice(midStart, midStart + MIDDLE_CHARS);
  const tail = content.slice(content.length - TAIL_CHARS);
  return [head, middle, tail].join(SLICE_MARKER);
};

/**
 * Stable hex hash of content, used to dedup submissions (skip re-synthesizing
 * content whose hash was already persisted) and as the contract's
 * `sourceContentHash`. Reuses the extension's FNV-1a hex util.
 */
export const contentHashOf = (content: string): string => fnv1a32Hex(content);

/**
 * Synthesize a title from raw content on Gemini Nano. Returns null on thin
 * content (< MIN_CONTENT_CHARS after trim), content Nano cannot serve (Chinese
 * — see language.ts; a wrong-language title is worse than no title), an
 * explicit SKIP, an empty reply, output that FAILS VALIDATION (repetition
 * loops, digit soup, markup — validateGeneration.ts), or any error. The caller
 * treats null as "no title, don't persist". The returned title is trimmed and
 * capped to MAX_TITLE_CHARS.
 *
 * Nano has no repetition penalty and no n-gram ban; the sampling params below
 * are the only decoding lever, so the validator is the real guarantee here.
 */
export const synthesizeTitle = async (
  lm: BuiltinLanguageModel,
  content: string,
): Promise<string | null> => {
  if (content.trim().length < MIN_CONTENT_CHARS) return null;
  const language = detectContentLanguage(content);
  if (!nanoCanServe(language)) return null;
  const sample = sliceForSynthesis(content);
  let session: NanoSession;
  try {
    session = await createNanoSession(lm, await nanoSamplingFor(lm, TITLE_GENERATION));
  } catch {
    return null;
  }
  try {
    const raw = (await session.prompt(`${TITLE_PROMPT_PREFIX}\n${sample}`)).trim();
    if (raw.length === 0) return null;
    if (raw === 'SKIP') return null;
    const verdict = validateGeneration(raw.slice(0, MAX_TITLE_CHARS), { kind: 'title', language });
    return verdict.ok ? verdict.text : null;
  } catch {
    return null;
  } finally {
    session.destroy();
  }
};


// Deterministic preamble/markdown stripper. Prompting alone got the model to
// 0/3 preambles in tuning, but a 1B model is not reliable across every
// document, and a leaked "Here's a summary:" pollutes retrieval text. Belt
// and braces: strip the opener and the bold/heading scaffolding after the
// fact. Pure + exported so it is unit-testable.
export const stripGistPreamble = (raw: string): string => {
  let out = raw.trim();
  // The character class EXCLUDES ':' as well as '.', which is load-bearing.
  // With `[^\n.]*` this was greedy up to the LAST period on the line, so
  //   "Here is a summary: A factual sentence."
  // matched in its entirety and stripped to "" \u2014 the stripper DELETED the gist
  // instead of its preamble, and validateGeneration then rejected the empty
  // result, so the run saved nothing at all. Stopping at the first ':' or '.'
  // bounds the match to the actual preamble.
  out = out.replace(/^\s*(?:here(?:'|\u2019)?s|here is|below is|this is)\b[^\n.:]*[:.]\s*/iu, '');
  out = out.replace(/^\s*(?:\*\*)?(?:overall\s+)?summary(?:\*\*)?\s*:?\s*/iu, '');
  out = out.replace(/^[#>\s*_-]+/u, '');
  out = out.replace(/\*\*/gu, '');
  return out.trim();
};
