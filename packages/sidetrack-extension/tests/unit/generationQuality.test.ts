import { describe, expect, it } from 'vitest';

import {
  CHUNK_MAX_CHARS,
  MAX_PROCESSED_CHUNKS,
  planChunks,
  selectEvenlySpaced,
} from '../../src/sidepanel/nano/chunking';
import {
  CHUNK_GIST_GENERATION,
  GENERATION_TEMPERATURE,
  GENERATION_TOP_P,
  GIST_GENERATION,
  GIST_MAX_NEW_TOKENS,
  NO_REPEAT_NGRAM_SIZE,
  REPETITION_PENALTY,
  TITLE_GENERATION,
  clampNanoSampling,
  resolveGenerationOptions,
  transformersGenerationArgs,
} from '../../src/sidepanel/nano/generationOptions';
import {
  charLoopScore,
  formatScores,
  groundedness,
  letterRatio,
  repetitionScore,
  scoreGeneration,
  tokenizeForScoring,
  uniqueTokenRatio,
} from '../../src/sidepanel/nano/scoreGeneration';
import {
  validateGeneration,
  type GenerationRejectionReason,
  type GenerationVerdict,
} from '../../src/sidepanel/nano/validateGeneration';

// ---------------------------------------------------------------------------
// THE LIVE FAILURE, verbatim.
//
// 2026-07-27: a gist on an ordinary web page ran 61.5 seconds and produced this
// shape, repeating until the token budget ran out. It was saved to the
// companion and now feeds retrieval. Every rule in this file exists because
// nothing looked at this string.
// ---------------------------------------------------------------------------

const LIVE_DEGENERATE_GIST = `2 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6 224 6`;

const GOOD_GIST =
  'CloudTrail writes organization-wide API activity into one central S3 bucket, ' +
  'and Athena queries it through a partition projection table so scans stay cheap. ' +
  'Key entities: AWS CloudTrail, Amazon S3, Amazon Athena, partition projection.';

const SOURCE_TEXT =
  'User: how do I analyze CloudTrail logs across many AWS accounts? The organization ' +
  'trail writes into one central S3 bucket and Athena queries it with a partition ' +
  'projection table, which keeps scan cost low even for a year of activity.';

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

describe('scoreGeneration — deterministic quality signals', () => {
  it('scores the LIVE degenerate gist terribly on every signal that matters', () => {
    const s = scoreGeneration(LIVE_DEGENERATE_GIST, SOURCE_TEXT);
    // Word 3-grams cycle through a handful of variants → near-total repetition.
    expect(s.repetitionScore).toBeGreaterThan(0.9);
    // Digits and spaces only: not one letter.
    expect(s.letterRatio).toBe(0);
    // Three distinct tokens over a long stream.
    expect(s.uniqueTokenRatio).toBeLessThan(0.1);
    // The pattern has period 6 ("224 6 "), so the 8-char windows cycle through
    // exactly 6 variants — each takes ~1/6 of them, above the 0.15 ceiling.
    expect(s.charLoopScore).toBeGreaterThan(0.15);
    // No content word of the source survives.
    expect(s.groundedness).toBe(0);
  });

  it('scores a real gist well on the same signals', () => {
    const s = scoreGeneration(GOOD_GIST, SOURCE_TEXT);
    expect(s.repetitionScore).toBeLessThan(0.1);
    expect(s.letterRatio).toBeGreaterThan(0.8);
    expect(s.uniqueTokenRatio).toBeGreaterThan(0.6);
    expect(s.charLoopScore).toBeLessThan(0.1);
    expect(s.lengthOk).toBe(true);
    // Heuristic vocabulary overlap — a grounded summary reuses source words.
    expect(s.groundedness).toBeGreaterThan(0.5);
  });

  it('separates the two by an order of magnitude on repetition and letters', () => {
    const bad = scoreGeneration(LIVE_DEGENERATE_GIST, SOURCE_TEXT);
    const good = scoreGeneration(GOOD_GIST, SOURCE_TEXT);
    expect(bad.repetitionScore).toBeGreaterThan(good.repetitionScore * 5 + 0.5);
    expect(good.letterRatio).toBeGreaterThan(bad.letterRatio + 0.8);
  });

  it('catches a single-character run that has no token boundaries at all', () => {
    // repetitionScore cannot see this (one token); charLoopScore must.
    const run = 'z'.repeat(500);
    expect(repetitionScore(tokenizeForScoring(run))).toBe(0);
    expect(charLoopScore(run)).toBeGreaterThan(0.9);
  });

  it('tokenizes Han per character so a Chinese loop cannot score perfect', () => {
    expect(tokenizeForScoring('审计日志')).toEqual(['审', '计', '日', '志']);
    const zhLoop = '日志日志'.repeat(30);
    expect(uniqueTokenRatio(tokenizeForScoring(zhLoop))).toBeLessThan(0.1);
    expect(repetitionScore(tokenizeForScoring(zhLoop))).toBeGreaterThan(0.9);
  });

  it('keeps intra-word joiners but not boundary punctuation', () => {
    expect(tokenizeForScoring('cross-account access, Python 3.12.')).toEqual([
      'cross-account',
      'access',
      'python',
      '3.12',
    ]);
  });

  it('letterRatio ignores whitespace and counts Han as letters', () => {
    expect(letterRatio('abc')).toBe(1);
    expect(letterRatio('1 2 3')).toBe(0);
    expect(letterRatio('审计日志')).toBe(1);
    expect(letterRatio('')).toBe(0);
  });

  it('groundedness is source-vocabulary overlap of content words, not entailment', () => {
    expect(groundedness('CloudTrail Athena bucket', 'cloudtrail athena bucket table')).toBe(1);
    expect(groundedness('quantum flavour narwhal', 'cloudtrail athena bucket')).toBe(0);
    // Short words are not content words — "the a of" measures nothing.
    expect(groundedness('the a of', 'cloudtrail')).toBe(0);
  });

  it('formats every signal on one line for the eval row', () => {
    const line = formatScores(scoreGeneration(GOOD_GIST, SOURCE_TEXT));
    for (const key of ['rep', 'loop', 'letters', 'uniq', 'ground', 'len ok']) {
      expect(line).toContain(key);
    }
  });
});

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

describe('validateGeneration — nothing unvalidated reaches the companion', () => {
  const asGist = (text: string) => validateGeneration(text, { kind: 'gist', language: 'en' });
  const asTitle = (text: string) => validateGeneration(text, { kind: 'title', language: 'en' });
  /** The typed reason, or null when the verdict was accept. */
  const reasonOf = (v: GenerationVerdict): GenerationRejectionReason | null =>
    v.ok ? null : v.reason;

  it('REJECTS the live degenerate gist as a repetition loop', () => {
    const verdict = asGist(LIVE_DEGENERATE_GIST);
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toBe('repetitive');
  });

  it('would also have caught the live failure on diversity and character class', () => {
    // Belt-and-braces: with the repetition rules removed the same string still
    // fails, so the rejection does not hinge on one threshold.
    const s = scoreGeneration(LIVE_DEGENERATE_GIST, SOURCE_TEXT);
    expect(s.uniqueTokenRatio).toBeLessThan(0.3);
    expect(s.letterRatio).toBeLessThan(0.5);
  });

  it('accepts a real gist and returns the trimmed text', () => {
    const verdict = asGist(`  ${GOOD_GIST}  `);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok ? verdict.text : '').toBe(GOOD_GIST);
  });

  it('rejects a repeated phrase loop (word-level, not character-level)', () => {
    const looped = 'the model is stuck. '.repeat(20);
    const verdict = asGist(looped);
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toBe('repetitive');
  });

  it('rejects digit-heavy output even when it is not repetitive', () => {
    // Distinct numbers, so the repetition rules stay silent — the character
    // class rule is what has to fire.
    const digits = Array.from({ length: 40 }, (_, i) => String(1000 + i * 7)).join(' ');
    const verdict = asGist(digits);
    expect(verdict.ok).toBe(false);
    expect(reasonOf(verdict)).toBe('low-letter-ratio');
  });

  it('rejects an English gist for Chinese source, and vice versa', () => {
    const zhGist = '这篇文档讲述了如何跨多个账户分析审计日志，并使用分区投影表降低扫描成本。';
    const enForZh = validateGeneration(GOOD_GIST, { kind: 'gist', language: 'zh' });
    const zhForEn = validateGeneration(zhGist, { kind: 'gist', language: 'en' });
    expect(reasonOf(enForZh)).toBe('wrong-language');
    expect(reasonOf(zhForEn)).toBe('wrong-language');
    // …and each is accepted for its own language.
    expect(validateGeneration(zhGist, { kind: 'gist', language: 'zh' }).ok).toBe(true);
    expect(asGist(GOOD_GIST).ok).toBe(true);
  });

  it('never rejects on language for a bilingual source', () => {
    expect(validateGeneration(GOOD_GIST, { kind: 'gist', language: 'mixed-en-zh' }).ok).toBe(true);
  });

  it('rejects empty, single-token and over-long output', () => {
    expect(reasonOf(asGist('   '))).toBe('empty');
    expect(reasonOf(asTitle('word'))).toBe('single-token');
    const tooLong = `${GOOD_GIST} `.repeat(200);
    expect(reasonOf(asGist(tooLong))).toBe('too-long');
  });

  it('rejects markup and control characters', () => {
    const html = '<div class="x">CloudTrail summary of the page contents</div>';
    expect(reasonOf(asGist(html))).toBe('markup');
    const withControl = `${GOOD_GIST}${String.fromCharCode(7)}`;
    expect(reasonOf(asGist(withControl))).toBe('control-chars');
    // A lone generic is NOT markup — "List<String>" must survive.
    expect(asGist(`A List<String> helper for ${GOOD_GIST}`).ok).toBe(true);
  });

  it('requires a title to be one line', () => {
    const twoLines = 'CloudTrail log analysis\nsecond line here';
    expect(reasonOf(asTitle(twoLines))).toBe('multi-line');
    expect(asTitle('CloudTrail log analysis pipeline design').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

const paragraph = (n: number, chars: number): string =>
  `Section ${String(n)}. ${'content words fill this paragraph body. '.repeat(
    Math.ceil(chars / 39),
  )}`.slice(0, chars);

describe('planChunks', () => {
  it('passes a short document through as ONE chunk (the single-pass path)', () => {
    const plan = planChunks('a short page about CloudTrail and Athena queries');
    expect(plan.singlePass).toBe(true);
    expect(plan.totalChunks).toBe(1);
    expect(plan.usedChunks).toBe(1);
    expect(plan.droppedChunks).toBe(0);
    expect(plan.chunks[0]?.text).toContain('CloudTrail');
  });

  it('reports an empty plan for empty input rather than inventing a chunk', () => {
    const plan = planChunks('   \n\n   ');
    expect(plan.chunks).toHaveLength(0);
    expect(plan.totalChunks).toBe(0);
    expect(plan.singlePass).toBe(true);
  });

  it('splits on blank lines, never exceeding the max, keeping paragraphs whole', () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => paragraph(i, 700));
    const plan = planChunks(paragraphs.join('\n\n'));
    expect(plan.totalChunks).toBeGreaterThan(1);
    for (const c of plan.chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    // No paragraph was cut in half: every "Section N." marker survives intact
    // somewhere in the plan (all 8 fit under the 6-chunk cap here).
    const joined = plan.chunks.map((c) => c.text).join('\n');
    for (let i = 0; i < 8; i += 1) expect(joined).toContain(`Section ${String(i)}.`);
  });

  it('assigns STABLE indices matching position in the full chunk list', () => {
    const plan = planChunks(Array.from({ length: 40 }, (_, i) => paragraph(i, 900)).join('\n\n'));
    expect(plan.chunks.map((c) => c.index)).toEqual(
      [...plan.chunks.map((c) => c.index)].sort((a, b) => a - b),
    );
    for (const c of plan.chunks) {
      expect(c.index).toBeGreaterThanOrEqual(0);
      expect(c.index).toBeLessThan(plan.totalChunks);
    }
  });

  it('caps the processed chunks and REPORTS the drops — never silent truncation', () => {
    const plan = planChunks(Array.from({ length: 40 }, (_, i) => paragraph(i, 900)).join('\n\n'));
    expect(plan.totalChunks).toBeGreaterThan(MAX_PROCESSED_CHUNKS);
    expect(plan.usedChunks).toBe(MAX_PROCESSED_CHUNKS);
    expect(plan.droppedChunks).toBe(plan.totalChunks - MAX_PROCESSED_CHUNKS);
    expect(plan.singlePass).toBe(false);
  });

  it('keeps an evenly spaced sample under the cap, including the last chunk', () => {
    const plan = planChunks(Array.from({ length: 40 }, (_, i) => paragraph(i, 900)).join('\n\n'));
    expect(plan.chunks[0]?.index).toBe(0);
    expect(plan.chunks[plan.chunks.length - 1]?.index).toBe(plan.totalChunks - 1);
  });

  it('breaks a single over-long paragraph at sentence boundaries', () => {
    const monster = `${'One sentence of moderate length about logs. '.repeat(200)}`;
    const plan = planChunks(monster);
    for (const c of plan.chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    // The break points are sentence ends, so no chunk starts mid-sentence.
    for (const c of plan.chunks) expect(c.text.trimStart().startsWith('One sentence')).toBe(true);
  });

  it('hard-slices text with no boundaries at all rather than emitting a giant chunk', () => {
    const plan = planChunks('x'.repeat(CHUNK_MAX_CHARS * 3));
    expect(plan.totalChunks).toBeGreaterThan(1);
    for (const c of plan.chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
  });

  it('selectEvenlySpaced spans the range and never exceeds k', () => {
    expect(selectEvenlySpaced(3, 6)).toEqual([0, 1, 2]);
    expect(selectEvenlySpaced(11, 6)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(selectEvenlySpaced(0, 6)).toEqual([]);
    expect(selectEvenlySpaced(9, 1)).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// Generation options
// ---------------------------------------------------------------------------

describe('generation options — the anti-degeneracy params are actually passed', () => {
  it('resolves anti-degeneracy defaults for a caller that passes only a budget', () => {
    const o = resolveGenerationOptions({ maxNewTokens: 24 });
    expect(o.repetitionPenalty).toBe(REPETITION_PENALTY);
    expect(o.noRepeatNgramSize).toBe(NO_REPEAT_NGRAM_SIZE);
    expect(o.temperature).toBe(GENERATION_TEMPERATURE);
    expect(o.topP).toBe(GENERATION_TOP_P);
  });

  it('builds transformers.js args with sampling AND both penalties', () => {
    const args = transformersGenerationArgs(GIST_GENERATION);
    expect(args.max_new_tokens).toBe(GIST_MAX_NEW_TOKENS);
    // The live failure ran greedy; greedy has no escape from a decode cycle.
    expect(args.do_sample).toBe(true);
    expect(args.temperature).toBe(GENERATION_TEMPERATURE);
    expect(args.top_p).toBe(GENERATION_TOP_P);
    expect(args.repetition_penalty).toBe(REPETITION_PENALTY);
    expect(args.no_repeat_ngram_size).toBe(NO_REPEAT_NGRAM_SIZE);
    expect(args.return_full_text).toBe(false);
  });

  it('keeps the gist budget far below the 220 tokens that produced the 61.5s loop', () => {
    expect(GIST_MAX_NEW_TOKENS).toBeLessThan(220);
    expect(resolveGenerationOptions(CHUNK_GIST_GENERATION).maxNewTokens).toBeLessThan(
      GIST_MAX_NEW_TOKENS,
    );
  });

  it('lets a gist keep 2000 chars while a title still caps at 200', () => {
    expect(resolveGenerationOptions(GIST_GENERATION).maxChars).toBe(2000);
    expect(resolveGenerationOptions(TITLE_GENERATION).maxChars).toBe(200);
  });

  it('clamps Nano sampling to the device bounds (Chrome rejects out-of-range)', () => {
    expect(clampNanoSampling(GIST_GENERATION, { maxTopK: 8, maxTemperature: 2 })).toEqual({
      temperature: GENERATION_TEMPERATURE,
      topK: 8,
    });
    // No params() exposed → conservative fallbacks, never a throw.
    expect(clampNanoSampling(GIST_GENERATION, null).topK).toBeLessThanOrEqual(8);
    expect(
      clampNanoSampling({ maxNewTokens: 8, temperature: 5 }, { maxTemperature: 1 }).temperature,
    ).toBe(1);
  });
});
