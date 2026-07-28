import { describe, expect, it, vi } from 'vitest';

import { CHUNK_MAX_CHARS, CHUNK_MIN_CHARS, planChunks } from '../../src/sidepanel/nano/chunking';
import { CHUNK_GIST_MAX_NEW_TOKENS } from '../../src/sidepanel/nano/generationOptions';
import { synthesizeGist } from '../../src/sidepanel/nano/gistSynthesis';
import { limitsFor } from '../../src/sidepanel/nano/engineLimits';
import { WEBGPU_1B_MAX_INPUT_CHARS } from '../../src/sidepanel/nano/modelRegistry';
import { CHUNK_GIST_PROMPT_PREFIX } from '../../src/sidepanel/nano/titleSynthesis';

// LATENCY BUDGET — the measured facts, pinned.
//
// Gist latency on WebGPU is ~3.9ms per input token and ~37.5ms per OUTPUT
// token, so what a gist costs is essentially HOW MANY GENERATIONS a document
// needs times how long each one talks. Measured 2026-07-28 over 3 real vault
// documents x 2 repetitions on gemma-3-1b q4:
//
//   1800-char chunks, 64-token notes   5.7 gens   26.4s   groundedness 0.49
//   1800-char chunks, 40-token notes   5.7 gens   20.2s   groundedness 0.49
//   3600-char chunks, 40-token notes   3.3 gens   17.3s   groundedness 0.47
//
// These tests exist because BOTH of those levers are one silent edit away from
// being undone, and neither failure would look like a bug — the gist would
// still be correct, just slower, which is precisely the kind of regression
// that survives review.

describe('gist latency budget — the chunk width actually reaches the engine', () => {
  it('the WebGPU input cap does not silently narrow chunks below CHUNK_MAX_CHARS', () => {
    // THE BUG THIS CATCHES, which happened for real: synthesizeGist chunks at
    // min(CHUNK_MAX_CHARS, limits.maxInputChars). Raising CHUNK_MAX_CHARS while
    // leaving the model's per-call cap at 2000 changed NOTHING at runtime — the
    // engine cap kept binding, the pipeline kept paying 5.7 generations, and
    // every unit test still passed because they plan chunks with the bare
    // default. The two numbers have to move together or the wider one is
    // decoration.
    expect(WEBGPU_1B_MAX_INPUT_CHARS).toBeGreaterThanOrEqual(CHUNK_MAX_CHARS);
    expect(limitsFor('webgpu').maxInputChars).toBeGreaterThanOrEqual(CHUNK_MAX_CHARS);
  });

  it('keeps the chunk width inside the range measured clean on WebGPU', () => {
    // 6000-char chunks went superlinear (78s for work a linear model puts at
    // 13s) and then crashed the backend outright:
    //   "failed to call OrtRun() ... webgpu/buffer_manager.cc Download(...)"
    // 3600 was clean across 8 runs. This is a MEASURED ceiling, not a context
    // limit — the model's window is 8k tokens and far from binding.
    expect(CHUNK_MAX_CHARS).toBeLessThanOrEqual(3600);
    // ...and wide enough to be worth it: below ~2400 the extra generations cost
    // more than the narrower prefill saves.
    expect(CHUNK_MAX_CHARS).toBeGreaterThanOrEqual(2400);
    expect(CHUNK_MIN_CHARS).toBeLessThan(CHUNK_MAX_CHARS);
  });

  it('bounds chunk-note length in the PROMPT, not only in max_new_tokens', async () => {
    // Order matters and the comment alone will not keep it. With only "ONE
    // factual sentence" the notes averaged 38 tokens against a 64-token cap —
    // the model was nowhere near its cap, so lowering the cap alone would have
    // truncated sentences instead of shortening them. The word bound is what
    // moved the pipeline from 338 output tokens to 206.
    expect(CHUNK_GIST_PROMPT_PREFIX).toMatch(/at most \d+ words/u);
    expect(CHUNK_GIST_MAX_NEW_TOKENS).toBeLessThanOrEqual(40);

    // And the cap is the one the chunk pass actually sends.
    const doc = Array.from(
      { length: 4 },
      (_, i) => `Section ${String(i)}. ${'content words fill this paragraph body. '.repeat(60)}`,
    ).join('\n\n');
    const calls: { prompt: string; maxNewTokens: number }[] = [];
    const engine = {
      generate: vi.fn(async (prompt: string, opts: { maxNewTokens: number }) => {
        calls.push({ prompt, maxNewTokens: opts.maxNewTokens });
        // Made of the fixture document's own words: the groundedness rule
        // rejects a summary that shares no content vocabulary with its source,
        // and an arbitrary stub reply is exactly that.
        return prompt.startsWith(CHUNK_GIST_PROMPT_PREFIX)
          ? 'This section contains content words filling the paragraph body.'
          : 'The document sections contain content words filling each paragraph body.';
      }),
    };
    const outcome = await synthesizeGist(engine, doc);
    expect(outcome.ok).toBe(true);
    const chunkCalls = calls.filter((c) => c.prompt.startsWith(CHUNK_GIST_PROMPT_PREFIX));
    expect(chunkCalls.length).toBeGreaterThan(0);
    for (const c of chunkCalls) expect(c.maxNewTokens).toBe(CHUNK_GIST_MAX_NEW_TOKENS);
  });

  it('a typical page costs FEWER generations than it did at the old width', () => {
    // A ~6000-char page is the size the measurement used. At the old
    // 1800/2000-char width that planned 4-5 chunks (so 5-6 generations); at the
    // current width it must plan at most 2 (3 generations). Asserting the plan
    // rather than a wall-clock number keeps this deterministic in CI while
    // still pinning the thing that drives wall-clock.
    const page = Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${String(i)}. ${'real prose content in this section. '.repeat(13)}`,
    ).join('\n\n');
    expect(page.length).toBeGreaterThan(5500);
    expect(page.length).toBeLessThan(6600);
    const plan = planChunks(page);
    expect(plan.totalChunks).toBeLessThanOrEqual(2);
  });
});
