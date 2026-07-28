import { describe, expect, it, vi } from 'vitest';

import { synthesizeGist } from '../../src/sidepanel/nano/gistSynthesis';
import {
  CHUNK_GIST_PROMPT_PREFIX,
  GIST_SYNTHESIS_PROMPT_PREFIX,
  stripGistPreamble,
} from '../../src/sidepanel/nano/titleSynthesis';

// REPORTED LIVE, 2026-07-28. A gist saved through the Apple engine read:
//
//   "Summary: Anthropic CEO has decided against releasing models ..."
//
// stripGistPreamble exists precisely to remove that, and it worked — it was
// only ever wired into the SINGLE-PASS path. Every multi-chunk document went
// through a second, bespoke copy of "generate then validate" that skipped the
// stripper, skipped the retry, and validated against the wrong prompt.
//
// Two code paths doing the same job is how all three drifted. These tests pin
// the behaviour at the seam a user actually sees: the returned gist.

const longDoc = Array.from(
  { length: 6 },
  (_, i) => `Section ${String(i)}. ${'substantive prose about the subject matter here. '.repeat(40)}`,
).join('\n\n');

/** An engine that prefixes every reply the way a small model habitually does. */
const preambleEngine = (chunkReply: string, finalReply: string) => {
  const calls: string[] = [];
  return {
    calls,
    engine: {
      generate: vi.fn(async (prompt: string) => {
        calls.push(prompt);
        return prompt.startsWith(GIST_SYNTHESIS_PROMPT_PREFIX) ? finalReply : chunkReply;
      }),
    },
  };
};

describe('the multi-chunk path strips preambles too', () => {
  it('removes "Summary:" from the FINAL synthesis — the reported leak', async () => {
    const { engine } = preambleEngine(
      'The section describes the subject matter in factual terms.',
      'Summary: The document explains the subject matter and names the parties involved.',
    );
    const outcome = await synthesizeGist(engine, longDoc);
    expect(outcome.ok).toBe(true);
    const gist = outcome.ok ? outcome.gist : '';
    expect(gist.startsWith('Summary:')).toBe(false);
    expect(gist).toBe('The document explains the subject matter and names the parties involved.');
  });

  it('removes "Here is ..." and markdown bold from the final gist', async () => {
    const { engine } = preambleEngine(
      'The section describes the subject matter in factual terms.',
      "Here's a summary: The **document** explains the subject matter clearly.",
    );
    const outcome = await synthesizeGist(engine, longDoc);
    expect(outcome.ok).toBe(true);
    const gist = outcome.ok ? outcome.gist : '';
    expect(gist).not.toMatch(/here'?s/iu);
    expect(gist).not.toContain('**');
  });

  it('strips the CHUNK notes too, so a preamble never reaches the synthesis input', async () => {
    // A note reading "Summary: ..." becomes part of the final prompt and invites
    // the model to echo the shape straight back out.
    const { engine, calls } = preambleEngine(
      'Summary: the section describes the subject matter in factual terms.',
      'The document explains the subject matter and names the parties involved.',
    );
    await synthesizeGist(engine, longDoc);
    const synthesisPrompt = calls.find((p) => p.startsWith(GIST_SYNTHESIS_PROMPT_PREFIX));
    expect(synthesisPrompt).toBeDefined();
    // The notes carried into the synthesis must be clean.
    const notesBlock = (synthesisPrompt ?? '').slice(GIST_SYNTHESIS_PROMPT_PREFIX.length);
    expect(notesBlock).not.toMatch(/summary:/iu);
  });

  it('the stripper itself handles the shapes seen in the wild', () => {
    expect(stripGistPreamble('Summary: A factual sentence.')).toBe('A factual sentence.');
    expect(stripGistPreamble('**Summary**: A factual sentence.')).toBe('A factual sentence.');
    expect(stripGistPreamble('## A factual sentence.')).toBe('A factual sentence.');
    // ...and leaves an already-clean gist untouched.
    expect(stripGistPreamble('A factual sentence.')).toBe('A factual sentence.');
  });

  it('does not DELETE the gist while stripping its preamble', () => {
    // The stripper's own bug, found by this suite. `[^\n.]*` was greedy to the
    // LAST period on the line, so the "Here is ..." rule matched the whole
    // string and returned "" — the gist was destroyed, then rejected as empty,
    // and the run saved nothing. Worse than the leak it was meant to fix.
    expect(stripGistPreamble('Here is a summary: A factual sentence.')).toBe(
      'A factual sentence.',
    );
    expect(stripGistPreamble("Here's a summary: The document explains it.")).toBe(
      'The document explains it.',
    );
    // A multi-sentence body must survive intact, not be truncated at its last dot.
    expect(
      stripGistPreamble('Here is a summary: First sentence. Second sentence. Third one.'),
    ).toBe('First sentence. Second sentence. Third one.');
  });
});

describe('echo detection compares against INSTRUCTIONS, not the source', () => {
  it('accepts a synthesis that legitimately restates its own notes', async () => {
    // The rule's message is "the model repeated the instructions instead of
    // summarizing". Handing the detector the full prompt made it compare the
    // gist against the NOTES — text the gist exists to restate — so a correct
    // answer was rejected as an echo of itself. Every sentence here is lifted
    // almost verbatim from the notes, which is exactly what merging looks like.
    const note = 'CloudTrail writes organization events into one central bucket for analysis.';
    const { engine } = preambleEngine(note, `${note} Athena then queries that bucket cheaply.`);
    const outcome = await synthesizeGist(engine, longDoc);
    expect(outcome.ok).toBe(true);
  });

  it('still REJECTS a gist that parrots the instruction text', async () => {
    // The protection has to survive the fix, or degenerate instruction-echo
    // walks back in.
    const { engine } = preambleEngine(
      'The section describes the subject matter in factual terms.',
      GIST_SYNTHESIS_PROMPT_PREFIX.slice(0, 200),
    );
    const outcome = await synthesizeGist(engine, longDoc);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.kind).toBe('rejected');
  });

  it('rejects a CHUNK note that parrots the chunk instructions', async () => {
    const { engine } = preambleEngine(
      CHUNK_GIST_PROMPT_PREFIX.slice(0, 160),
      'The document explains the subject matter and names the parties involved.',
    );
    const outcome = await synthesizeGist(engine, longDoc);
    // Every note was an echo, so none survived to feed the synthesis.
    expect(outcome.ok).toBe(false);
  });
});
