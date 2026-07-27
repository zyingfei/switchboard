// child_process.fork entry — owns the local-LLM title-generation stack.
//
// STRICT off-main-loop discipline (repo runtime-agility doctrine): the
// companion's main loop MUST NEVER run inference. This entry isolates the
// whole text-generation pipeline in a separate OS process, mirroring the
// recall embedder/indexer children (recall/embedderChild.entry.ts,
// recall/indexerChild.entry.ts). The parent (localLlm.ts) writes a job JSON
// file, forks this entry with the job path as argv[0], and reads a results
// JSON file when the child exits. The parent's main thread is free the whole
// time; an onnxruntime crash / OOM / multi-GB model download here has zero
// impact on /v1/status or any other route.
//
// Contract (files, not IPC frames — the job can run for minutes, and a plain
// file handoff survives the parent's hard-timeout kill without a torn IPC
// stream):
//   argv[2]  = absolute path to the job JSON file
//   job JSON = { modelId, maxItems, items: [{ id, content }] }
//   result   = written to `${jobPath}.result.json`:
//              { results: [{ id, title: string | null, ms: number }] }
//              title === null for SKIP / thin (< MIN_CONTENT_CHARS) / error.
//
// The child loads the model ONCE, generates one title per item in sequence
// (greedy, short max_new_tokens), writes the result file, then exits. It does
// NOT talk to the event log or the vault beyond reading the job + writing the
// result — event append is the PARENT's job (single source of truth via
// appendEnrichmentEvent). Stdout/stderr go to the parent's captured log file.

import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { isOfflineMode, resolveModelsDir } from '../recall/modelCache.js';

// ---- parity prompt + slicing (duplicated from the extension) ----------
//
// PARITY: this block is a verbatim duplicate of the panel's synthesis prompt
// + slicing shape in
//   packages/sidetrack-extension/src/sidepanel/nano/titleSynthesis.ts
// The two are intentionally NOT shared (companion and extension are separate
// build targets that must not import each other), so they are duplicated and
// cross-linked. If you change the prompt text, the slice budgets, MIN_CONTENT,
// or MAX_TITLE here, change them THERE too — the parity test
// (localLlm.test.ts) asserts the two strings + slice outputs stay equal.

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
 * the threshold passes through unchanged. Pure. Parity twin of the extension's
 * sliceForSynthesis.
 */
export const sliceForSynthesis = (content: string): string => {
  if (content.length <= SLICE_THRESHOLD_CHARS) return content;
  const head = content.slice(0, HEAD_CHARS);
  const midStart = Math.floor(content.length / 2 - MIDDLE_CHARS / 2);
  const middle = content.slice(midStart, midStart + MIDDLE_CHARS);
  const tail = content.slice(content.length - TAIL_CHARS);
  return [head, middle, tail].join(SLICE_MARKER);
};

// ---- job / result contract --------------------------------------------

export interface LocalLlmJobItem {
  readonly id: string;
  readonly content: string;
}

export interface LocalLlmJob {
  readonly modelId: string;
  readonly maxItems: number;
  readonly items: readonly LocalLlmJobItem[];
}

export interface LocalLlmResultItem {
  readonly id: string;
  readonly title: string | null;
  readonly ms: number;
}

export interface LocalLlmResult {
  readonly results: readonly LocalLlmResultItem[];
}

// ---- text-generation pipeline (mirrors embedder.ts conventions) -------

// The pipeline call shape @huggingface/transformers exposes for
// text-generation with a chat input: apply_chat_template handles the
// instruction wrapping and the pipeline returns ONLY the generated assistant
// turn (return_full_text is forced false for chat inputs). We keep the type
// minimal — the exact generic surface across transformers releases is wider
// than we use.
type ChatMessage = { readonly role: 'user'; readonly content: string };
type TextGenerator = (
  messages: readonly ChatMessage[],
  options: Record<string, unknown>,
) => Promise<
  ReadonlyArray<{ readonly generated_text: string | ReadonlyArray<{ readonly content?: unknown }> }>
>;

let generatorPromise: Promise<TextGenerator> | undefined;

const loadGenerator = async (modelId: string): Promise<TextGenerator> => {
  if (generatorPromise !== undefined) return generatorPromise;
  const started = performance.now();
  const offlineAtLoad = isOfflineMode();
  const cacheDirAtLoad = resolveModelsDir();
  generatorPromise = (async () => {
    const module = await import('@huggingface/transformers');
    const env = (module as { readonly env?: Record<string, unknown> }).env;
    if (env !== undefined) {
      // Same env posture as the embedder: allow remote fetches unless offline
      // (the first run downloads ~1GB), deny local models, point transformers
      // at the Sidetrack-managed model directory so a packaged release can
      // prewarm + ship the model.
      env['allowRemoteModels'] = !offlineAtLoad;
      env['allowLocalModels'] = false;
      env['useFSCache'] = true;
      env['cacheDir'] = cacheDirAtLoad;
    }
    // dtype cascade mirroring embedder.ts: instruction-tuned ONNX models on
    // the HF hub (onnx-community/*) publish a q4 family for small footprint;
    // walk q4 → q4f16 → q8 → fp16 and let the first that loads stick. q4 is
    // ~1GB for a 1B model vs ~4GB fp16 — the whole point of picking a small
    // local model.
    const dtypeCandidates: readonly string[] = ['q4', 'q4f16', 'q8', 'fp16'];
    const errors: string[] = [];
    for (const dtype of dtypeCandidates) {
      try {
        const pipe = (await module.pipeline('text-generation', modelId, {
          device: 'cpu',
          dtype,
        } as Parameters<typeof module.pipeline>[2])) as unknown as TextGenerator;
        // eslint-disable-next-line no-console
        console.info(
          `[enrichment.localllm] loaded ${modelId} (cpu/${dtype}) in ${String(
            Math.round(performance.now() - started),
          )}ms`,
        );
        return pipe;
      } catch (error) {
        errors.push(`${dtype}: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`);
      }
    }
    generatorPromise = undefined;
    throw new Error(
      `[enrichment.localllm] could not load ${modelId} on any dtype (offline=${String(
        offlineAtLoad,
      )}, cacheDir=${cacheDirAtLoad}). Tried: ${errors.join(' | ')}`,
    );
  })();
  return generatorPromise;
};

// Pull the assistant text out of the pipeline's return value. Chat inputs
// return `generated_text` as the full chat array whose LAST element is the
// assistant turn; some builds return a plain string. Handle both.
const extractGeneratedText = (
  out: ReadonlyArray<{
    readonly generated_text: string | ReadonlyArray<{ readonly content?: unknown }>;
  }>,
): string => {
  const first = out[0];
  if (first === undefined) return '';
  const g = first.generated_text;
  if (typeof g === 'string') return g;
  // Chat-array form: the last element is the assistant turn. Index the typed
  // ReadonlyArray directly (Array.isArray would widen g to any[] and trip the
  // no-unsafe-* rules) after guarding it is not the string branch.
  const last = g[g.length - 1];
  const content = last?.content;
  return typeof content === 'string' ? content : '';
};

/**
 * Generate one title from raw content. Returns null on thin content
 * (< MIN_CONTENT_CHARS after trim), an explicit SKIP, an empty reply, or any
 * error — the parent treats null as "no title, don't persist". Mirrors the
 * extension's synthesizeTitle discipline: greedy decode, short output, trim +
 * cap. The slice + prompt are the parity twins above.
 */
export const generateTitle = async (
  generator: TextGenerator,
  content: string,
): Promise<string | null> => {
  if (content.trim().length < MIN_CONTENT_CHARS) return null;
  const sample = sliceForSynthesis(content);
  try {
    const out = await generator([{ role: 'user', content: `${TITLE_PROMPT_PREFIX}\n${sample}` }], {
      // Greedy / low-temperature: a title is a deterministic extraction, not a
      // creative generation. do_sample=false is greedy; max_new_tokens ~24 is
      // ample for a 4-10 word title and keeps latency bounded.
      max_new_tokens: 24,
      do_sample: false,
      temperature: 0,
      return_full_text: false,
    });
    const raw = extractGeneratedText(out).trim();
    if (raw.length === 0) return null;
    if (raw === 'SKIP') return null;
    return raw.slice(0, MAX_TITLE_CHARS);
  } catch {
    return null;
  }
};

// ---- entry --------------------------------------------------------------

const runJob = async (jobPath: string): Promise<void> => {
  const job = JSON.parse(await readFile(jobPath, 'utf8')) as LocalLlmJob;
  const items = job.items.slice(0, Math.max(0, job.maxItems));
  const results: LocalLlmResultItem[] = [];
  let generator: TextGenerator | null = null;
  try {
    generator = await loadGenerator(job.modelId);
  } catch (error) {
    // Model load failed for the WHOLE job — emit a null title per item so the
    // parent records the attempt (generated) but accepts nothing. Surface the
    // error to stderr for the captured log.
    process.stderr.write(
      `[enrichment.localllm] model load failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    for (const item of items) results.push({ id: item.id, title: null, ms: 0 });
    await writeFile(`${jobPath}.result.json`, JSON.stringify({ results } satisfies LocalLlmResult));
    return;
  }
  for (const item of items) {
    const started = performance.now();
    const title = await generateTitle(generator, item.content);
    results.push({ id: item.id, title, ms: Math.round(performance.now() - started) });
  }
  await writeFile(`${jobPath}.result.json`, JSON.stringify({ results } satisfies LocalLlmResult));
};

// process.argv: [node, entry, jobPath]. Only run when invoked as a forked
// entry with a job path — importing this module (tests) must NOT kick off a
// job or exit the process.
const jobPathArg = process.argv[2];
if (jobPathArg !== undefined && jobPathArg.length > 0) {
  void runJob(jobPathArg)
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `[enrichment.localllm] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
