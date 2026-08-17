import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_SENTENCE_SPLIT_MAX,
  resolveSentenceMaxChars,
  resolveSentenceSplitMax,
  splitIntoSentences,
  splitPageIntoSentences,
} from './sentenceSplit.js';

describe('splitIntoSentences — determinism + en/zh boundary handling', () => {
  it('splits English text on . ! ? followed by whitespace/EOF', () => {
    const out = splitIntoSentences('DuckDB is fast. It runs OLAP queries! Does it scale?');
    expect(out).toEqual([
      'DuckDB is fast.',
      'It runs OLAP queries!',
      'Does it scale?',
    ]);
  });

  it('does not fragment on a period NOT followed by whitespace (numbers, abbreviations)', () => {
    const out = splitIntoSentences('Pi is 3.14 roughly. See docs at U.S. sites for more.');
    // "3.14" must not fragment; "U.S." mid-sentence has a space after each
    // period so IS a legal boundary under this simple splitter's rule — the
    // splitter is deliberately not abbreviation-aware, only "no split without
    // a following space/EOF".
    expect(out[0]).toBe('Pi is 3.14 roughly.');
    expect(out.join(' ')).not.toContain('  '); // no accidental double-space artifacts
  });

  it('splits CJK text on 。！？ with no trailing space required', () => {
    const out = splitIntoSentences('这是第一句话。这是第二句话！这是第三句话？');
    expect(out).toEqual(['这是第一句话。', '这是第二句话！', '这是第三句话？']);
  });

  it('splits on newlines as paragraph/line boundaries', () => {
    const out = splitIntoSentences('First line here\nSecond line here\nThird line here');
    expect(out).toEqual(['First line here', 'Second line here', 'Third line here']);
  });

  it('is deterministic — repeated calls over the same text agree exactly', () => {
    const text = 'Alpha beta gamma. Delta epsilon zeta! Eta theta iota?';
    const first = splitIntoSentences(text);
    const second = splitIntoSentences(text);
    expect(second).toEqual(first);
  });

  it('drops sub-minimum-length fragments (stray punctuation) as noise', () => {
    const out = splitIntoSentences('Ok. . Real sentence here that is long enough.');
    expect(out.every((s) => s.length >= 3)).toBe(true);
    expect(out.some((s) => s === '.')).toBe(false);
  });

  it('caps at `max` sentences', () => {
    const text = 'One sentence. Two sentence. Three sentence. Four sentence. Five sentence.';
    const out = splitIntoSentences(text, { max: 2 });
    expect(out.length).toBe(2);
  });

  it('caps at DEFAULT_SENTENCE_SPLIT_MAX (6) with no explicit max', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Sentence number ${String(i)} here.`).join(' ');
    const out = splitIntoSentences(text);
    expect(out.length).toBeLessThanOrEqual(DEFAULT_SENTENCE_SPLIT_MAX);
  });

  it('truncates an oversized single sentence rather than dropping it', () => {
    const longSentence = `${'word '.repeat(200)}.`.trim();
    const out = splitIntoSentences(longSentence, { maxCharsPerSentence: 50 });
    expect(out.length).toBe(1);
    expect(out[0]!.length).toBeLessThanOrEqual(50);
  });

  it('empty/whitespace-only input yields []', () => {
    expect(splitIntoSentences('')).toEqual([]);
    expect(splitIntoSentences('   \n  ')).toEqual([]);
  });
});

describe('resolveSentenceSplitMax / resolveSentenceMaxChars — env knob fallback', () => {
  it('falls back to the default on garbage/absent env values', () => {
    const original = process.env['SIDETRACK_SENTENCE_SPLIT_MAX'];
    try {
      delete process.env['SIDETRACK_SENTENCE_SPLIT_MAX'];
      expect(resolveSentenceSplitMax()).toBe(DEFAULT_SENTENCE_SPLIT_MAX);
      process.env['SIDETRACK_SENTENCE_SPLIT_MAX'] = 'not-a-number';
      expect(resolveSentenceSplitMax()).toBe(DEFAULT_SENTENCE_SPLIT_MAX);
      process.env['SIDETRACK_SENTENCE_SPLIT_MAX'] = '0';
      expect(resolveSentenceSplitMax()).toBe(DEFAULT_SENTENCE_SPLIT_MAX);
      process.env['SIDETRACK_SENTENCE_SPLIT_MAX'] = '3';
      expect(resolveSentenceSplitMax()).toBe(3);
    } finally {
      if (original === undefined) delete process.env['SIDETRACK_SENTENCE_SPLIT_MAX'];
      else process.env['SIDETRACK_SENTENCE_SPLIT_MAX'] = original;
    }
  });

  it('resolveSentenceMaxChars falls back to the default on garbage', () => {
    const original = process.env['SIDETRACK_SENTENCE_MAX_CHARS'];
    try {
      process.env['SIDETRACK_SENTENCE_MAX_CHARS'] = '-5';
      expect(resolveSentenceMaxChars()).toBeGreaterThan(0);
    } finally {
      if (original === undefined) delete process.env['SIDETRACK_SENTENCE_MAX_CHARS'];
      else process.env['SIDETRACK_SENTENCE_MAX_CHARS'] = original;
    }
  });
});

describe('splitPageIntoSentences — title-as-own-sentence composition', () => {
  it('puts the title first as ONE sentence, unsplit, then the gist sentences', () => {
    const out = splitPageIntoSentences(
      'DuckDB Performance Tuning Guide',
      'DuckDB is a fast in-process OLAP database. It supports vectorized execution.',
    );
    expect(out[0]).toEqual({ source: 'title', text: 'DuckDB Performance Tuning Guide' });
    expect(out.slice(1).every((s) => s.source === 'gist')).toBe(true);
    expect(out.length).toBe(3);
  });

  it('a null/empty title contributes nothing — gist sentences only', () => {
    const out = splitPageIntoSentences(null, 'One gist sentence here. Another one here too.');
    expect(out.every((s) => s.source === 'gist')).toBe(true);
    expect(out.length).toBe(2);
  });

  it('a null/empty gist contributes nothing — title only', () => {
    const out = splitPageIntoSentences('Just A Title', null);
    expect(out).toEqual([{ source: 'title', text: 'Just A Title' }]);
  });

  it('neither title nor gist yields []', () => {
    expect(splitPageIntoSentences(null, null)).toEqual([]);
    expect(splitPageIntoSentences('', '')).toEqual([]);
  });

  it('title + gist together are bounded at `max` total, title always wins the first slot', () => {
    const gist = 'A. B. C. D. E. F. G.'.split(' ').map((_, i) => `Sentence ${String(i)}.`).join(' ');
    const out = splitPageIntoSentences('A Title', gist, { max: 3 });
    expect(out.length).toBe(3);
    expect(out[0]!.source).toBe('title');
  });

  it('is deterministic for the same (title, gist) pair', () => {
    const a = splitPageIntoSentences('Title X', 'Gist one. Gist two.');
    const b = splitPageIntoSentences('Title X', 'Gist one. Gist two.');
    expect(b).toEqual(a);
  });

  it('CJK gist splits correctly alongside a title', () => {
    const out = splitPageIntoSentences('中文标题', '这是摘要第一句。这是摘要第二句。');
    expect(out[0]).toEqual({ source: 'title', text: '中文标题' });
    expect(out.length).toBe(3);
  });
});
