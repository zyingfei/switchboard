import { fnv1a32Hex } from '../../graph/fnv1a';

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
  create: (options?: {
    monitor?: (m: {
      addEventListener: (type: 'downloadprogress', cb: (e: { loaded: number }) => void) => void;
    }) => void;
    expectedInputs?: readonly { type: 'text'; languages: readonly string[] }[];
    expectedOutputs?: readonly { type: 'text'; languages: readonly string[] }[];
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

// The vault is bilingual (English + Chinese threads); declaring both as
// expected input AND output languages lets Chrome fetch any language pack it
// needs and keeps output quality honest for zh content. Older Chromes that
// reject the language options fall back to a plain create().
export const SESSION_LANGUAGES: readonly string[] = ['en', 'zh'];

export const createBilingualSession = async (lm: BuiltinLanguageModel): Promise<NanoSession> => {
  try {
    return await lm.create({
      expectedInputs: [{ type: 'text', languages: SESSION_LANGUAGES }],
      expectedOutputs: [{ type: 'text', languages: SESSION_LANGUAGES }],
    });
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
export const GIST_PROMPT_PREFIX = [
  'You summarize documents for a personal research organizer.',
  'Write a factual 2 to 3 sentence summary of the content below, then list',
  'the key entities (people, products, technologies, questions) it covers.',
  'Write in the SAME language the content is mostly written in',
  '(English content → English summary, 中文内容 → 中文摘要).',
  'Use ONLY facts present in the text. No opinions, no meta-commentary about',
  'the document itself, no quotes of these instructions.',
  'If the text is too thin to summarize faithfully, reply exactly: SKIP',
  '',
  'Content:',
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
 * content (< MIN_CONTENT_CHARS after trim), an explicit SKIP, an empty reply,
 * or any error — the caller treats null as "no title, don't persist". The
 * returned title is trimmed and capped to MAX_TITLE_CHARS.
 */
export const synthesizeTitle = async (
  lm: BuiltinLanguageModel,
  content: string,
): Promise<string | null> => {
  if (content.trim().length < MIN_CONTENT_CHARS) return null;
  const sample = sliceForSynthesis(content);
  let session: NanoSession;
  try {
    session = await createBilingualSession(lm);
  } catch {
    return null;
  }
  try {
    const raw = (await session.prompt(`${TITLE_PROMPT_PREFIX}\n${sample}`)).trim();
    if (raw.length === 0) return null;
    if (raw === 'SKIP') return null;
    return raw.slice(0, MAX_TITLE_CHARS);
  } catch {
    return null;
  } finally {
    session.destroy();
  }
};
