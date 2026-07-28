import { describe, expect, it, vi } from 'vitest';

import { CHUNK_MAX_CHARS, MAX_PROCESSED_CHUNKS, planChunks } from '../../src/sidepanel/nano/chunking';
import {
  CHUNK_GIST_MAX_NEW_TOKENS,
  GIST_MAX_NEW_TOKENS,
} from '../../src/sidepanel/nano/generationOptions';
import { synthesizeGist } from '../../src/sidepanel/nano/gistSynthesis';
import {
  CHUNK_GIST_PROMPT_PREFIX,
  GIST_PROMPT_PREFIX,
  GIST_SYNTHESIS_PROMPT_PREFIX,
} from '../../src/sidepanel/nano/titleSynthesis';

const CHUNK_SENTENCE = 'This section explains how CloudTrail delivers events to a central bucket.';
const FINAL_GIST =
  'CloudTrail delivers organization-wide events to a central bucket, and Athena queries ' +
  'them through partition projection. Key entities: CloudTrail, S3, Athena.';

const LIVE_DEGENERATE = '2 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6';

const shortDoc =
  'CloudTrail writes organization events into one central bucket. Athena queries that ' +
  'bucket with a partition projection table so scans stay cheap even for a full year.';

const paragraph = (n: number): string =>
  `Section ${String(n)}. ${'content words fill this paragraph body with prose. '.repeat(20)}`;
const longDoc = (count: number): string =>
  Array.from({ length: count }, (_, i) => paragraph(i)).join('\n\n');

/** A scripted engine: each call returns the next reply, and records the prompt. */
const scriptedEngine = (replies: readonly string[] | ((prompt: string) => string)) => {
  const calls: { prompt: string; opts: { maxNewTokens: number } }[] = [];
  let i = 0;
  const generate = vi.fn(async (prompt: string, opts: { maxNewTokens: number }) => {
    calls.push({ prompt, opts });
    if (typeof replies === 'function') return replies(prompt);
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return reply ?? '';
  });
  return { engine: { generate }, calls, generate };
};

describe('synthesizeGist — single pass', () => {
  it('gates thin content before ever asking the model', async () => {
    const { engine, generate } = scriptedEngine([FINAL_GIST]);
    const outcome = await synthesizeGist(engine, 'tiny');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.kind).toBe('thin');
    expect(generate).not.toHaveBeenCalled();
  });

  it('runs ONE pass with the gist prompt and gist budget for a short document', async () => {
    const { engine, calls } = scriptedEngine([FINAL_GIST]);
    const outcome = await synthesizeGist(engine, shortDoc);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok ? outcome.gist : '').toBe(FINAL_GIST);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt.startsWith(GIST_PROMPT_PREFIX)).toBe(true);
    expect(calls[0]?.opts.maxNewTokens).toBe(GIST_MAX_NEW_TOKENS);
    expect(outcome.meta.passes).toBe(1);
    expect(outcome.meta.totalChunks).toBe(1);
    expect(outcome.meta.droppedChunks).toBe(0);
  });

  it('reports an explicit SKIP as an abstention, not a failure', async () => {
    const { engine } = scriptedEngine(['SKIP']);
    const outcome = await synthesizeGist(engine, shortDoc);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.kind).toBe('abstained');
  });

  it('REJECTS the live degenerate output instead of returning it', async () => {
    const { engine } = scriptedEngine([LIVE_DEGENERATE]);
    const outcome = await synthesizeGist(engine, shortDoc);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.kind).toBe('rejected');
    expect(outcome.ok || outcome.kind !== 'rejected' ? null : outcome.reason).toBe('repetitive');
  });
});

// synthesizeGist chunks at min(CHUNK_MAX_CHARS, limits.maxInputChars), so a
// test that plans with the bare default while the engine's cap is tighter
// counts a different number of chunks than the code does — which is exactly
// how this test broke when the WebGPU cap moved. These limits are deliberately
// permissive on input so CHUNK_MAX_CHARS is the binding width and
// planChunks(doc) here is the SAME plan the code builds. What the test is
// really asserting — one call per chunk plus exactly one synthesis — is a
// property of the pipeline, not of any engine's table.
const PLAN_MATCHING_LIMITS = {
  kind: 'webgpu',
  maxInputChars: CHUNK_MAX_CHARS,
  maxOutputTokens: GIST_MAX_NEW_TOKENS,
  maxOutputChars: 2000,
  inputSource: 'declared',
  note: 'test seam — pins chunk width to CHUNK_MAX_CHARS',
} as const;

describe('synthesizeGist — chunk then synthesize', () => {
  it('gists each chunk, then runs exactly ONE final synthesis pass', async () => {
    const doc = longDoc(4);
    const plan = planChunks(doc);
    expect(plan.singlePass).toBe(false);
    const { engine, calls } = scriptedEngine((prompt) =>
      prompt.startsWith(GIST_SYNTHESIS_PROMPT_PREFIX) ? FINAL_GIST : CHUNK_SENTENCE,
    );
    const outcome = await synthesizeGist(engine, doc, PLAN_MATCHING_LIMITS);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok ? outcome.gist : '').toBe(FINAL_GIST);
    // One call per used chunk + one synthesis call. No more — the depth cap.
    expect(calls).toHaveLength(plan.usedChunks + 1);
    const chunkCalls = calls.filter((c) => c.prompt.startsWith(CHUNK_GIST_PROMPT_PREFIX));
    const finalCalls = calls.filter((c) => c.prompt.startsWith(GIST_SYNTHESIS_PROMPT_PREFIX));
    expect(chunkCalls).toHaveLength(plan.usedChunks);
    expect(finalCalls).toHaveLength(1);
    expect(chunkCalls[0]?.opts.maxNewTokens).toBe(CHUNK_GIST_MAX_NEW_TOKENS);
    expect(finalCalls[0]?.opts.maxNewTokens).toBe(GIST_MAX_NEW_TOKENS);
    expect(outcome.meta.passes).toBe(2);
    expect(outcome.meta.keptChunkGists).toBe(plan.usedChunks);
  });

  it('never exceeds the chunk cap and reports what it dropped', async () => {
    const doc = longDoc(40);
    const { engine, calls } = scriptedEngine((prompt) =>
      prompt.startsWith(GIST_SYNTHESIS_PROMPT_PREFIX) ? FINAL_GIST : CHUNK_SENTENCE,
    );
    const outcome = await synthesizeGist(engine, doc);
    expect(outcome.ok).toBe(true);
    expect(outcome.meta.usedChunks).toBe(MAX_PROCESSED_CHUNKS);
    expect(outcome.meta.totalChunks).toBeGreaterThan(MAX_PROCESSED_CHUNKS);
    expect(outcome.meta.droppedChunks).toBe(outcome.meta.totalChunks - outcome.meta.usedChunks);
    expect(calls).toHaveLength(MAX_PROCESSED_CHUNKS + 1);
  });

  it('drops a degenerate chunk gist but still synthesizes from the good ones', async () => {
    const doc = longDoc(4);
    let chunkIndex = 0;
    const { engine } = scriptedEngine((prompt) => {
      if (prompt.startsWith(GIST_SYNTHESIS_PROMPT_PREFIX)) return FINAL_GIST;
      chunkIndex += 1;
      return chunkIndex === 1 ? LIVE_DEGENERATE : CHUNK_SENTENCE;
    });
    const outcome = await synthesizeGist(engine, doc);
    expect(outcome.ok).toBe(true);
    expect(outcome.meta.keptChunkGists).toBe(outcome.meta.usedChunks - 1);
  });

  it('rejects the run when EVERY chunk gist is degenerate', async () => {
    const { engine } = scriptedEngine(() => LIVE_DEGENERATE);
    const outcome = await synthesizeGist(engine, longDoc(4));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.kind).toBe('rejected');
    expect(outcome.ok || outcome.kind !== 'rejected' ? null : outcome.reason).toBe('repetitive');
  });

  it('rejects a degenerate FINAL synthesis even when the chunk gists were fine', async () => {
    const { engine } = scriptedEngine((prompt) =>
      prompt.startsWith(GIST_SYNTHESIS_PROMPT_PREFIX) ? LIVE_DEGENERATE : CHUNK_SENTENCE,
    );
    const outcome = await synthesizeGist(engine, longDoc(4));
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.kind).toBe('rejected');
  });

  it('feeds the final pass the chunk NOTES, never the raw page text', async () => {
    const doc = longDoc(4);
    const { engine, calls } = scriptedEngine((prompt) =>
      prompt.startsWith(GIST_SYNTHESIS_PROMPT_PREFIX) ? FINAL_GIST : CHUNK_SENTENCE,
    );
    await synthesizeGist(engine, doc);
    const final = calls.find((c) => c.prompt.startsWith(GIST_SYNTHESIS_PROMPT_PREFIX));
    expect(final?.prompt).toContain(CHUNK_SENTENCE);
    expect(final?.prompt).not.toContain('content words fill this paragraph body');
  });
});
