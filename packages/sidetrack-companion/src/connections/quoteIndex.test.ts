import { describe, expect, it } from 'vitest';

import { findThreadQuotes, type ThreadText } from './quoteIndex.js';

// 50-char block — 11 chars longer than SHINGLE_LEN so we get >=12
// overlapping 40-char shingles at the same offset, well above the
// MIN_CONTIG_RUN=4 threshold.
const QUOTED_BLOCK = 'function calculateTaxOwed(income, year) { return';
// Sanity: above is 50 chars; first 40 of it form one shingle, etc.

describe('connections — findThreadQuotes', () => {
  it('emits one quote edge for a ≥40-char substring shared across two threads', () => {
    const inputs: ThreadText[] = [
      { threadId: 'thread_a', text: `here is the helper:\n${QUOTED_BLOCK} 0;\n}` },
      { threadId: 'thread_b', text: `please review:\n${QUOTED_BLOCK} 0;\n}` },
    ];
    const matches = findThreadQuotes(inputs);
    // Both threads contain each other's substring — emit both
    // directional edges. (Determinism rule from the plan.)
    expect(matches.length).toBe(2);
    const pairs = matches.map((m) => [m.fromThreadId, m.toThreadId]).sort();
    expect(pairs).toEqual([
      ['thread_a', 'thread_b'],
      ['thread_b', 'thread_a'],
    ]);
    expect(matches[0]?.recordIdHashPrefix.length).toBe(12);
  });

  it('does NOT emit when the shared text is below the 40-char shingle threshold', () => {
    // 39 chars — one less than SHINGLE_LEN — produces zero shingles.
    const SHORT = 'function calculateTaxOwed(income, year';
    expect(SHORT.length).toBe(38);
    const inputs: ThreadText[] = [
      { threadId: 'thread_a', text: `prefix ${SHORT} suffix` },
      { threadId: 'thread_b', text: `other ${SHORT} other` },
    ];
    expect(findThreadQuotes(inputs)).toEqual([]);
  });

  it('whitespace-collapses normalize "a   b\\nc" → "a b c"', () => {
    // Build matching content with different whitespace forms.
    const padded = `${QUOTED_BLOCK}\n\nextra padding so we have enough chars to shingle`;
    const collapsed = `${QUOTED_BLOCK}     \t   extra padding so we have enough chars to shingle`;
    const inputs: ThreadText[] = [
      { threadId: 'thread_a', text: padded },
      { threadId: 'thread_b', text: collapsed },
    ];
    const matches = findThreadQuotes(inputs);
    expect(matches.length).toBe(2);
  });

  it('hash-collision guard: a single matching shingle is not enough — needs ≥4 contiguous', () => {
    // 40-char shared substring → only 1 shingle at offset 0. Not enough.
    const SHORT_MATCH = '0123456789abcdef0123456789abcdef01234567';
    expect(SHORT_MATCH.length).toBe(40);
    const inputs: ThreadText[] = [
      { threadId: 'thread_a', text: `head ${SHORT_MATCH} tail-a` },
      { threadId: 'thread_b', text: `prefix ${SHORT_MATCH} suffix-b` },
    ];
    // Surrounding chars differ → the shared content shingles at p=5 in A
    // and p=7 in B both produce hash H, but only ONE shingle matches at
    // offset δ=2. With MIN_CONTIG_RUN=4 we need at least 4 consecutive
    // matches.
    expect(findThreadQuotes(inputs)).toEqual([]);
  });

  it('deterministic on input order', () => {
    const a: ThreadText = { threadId: 'thread_a', text: `Q: ${QUOTED_BLOCK} 0; }` };
    const b: ThreadText = { threadId: 'thread_b', text: `R: ${QUOTED_BLOCK} 0; }` };
    const c: ThreadText = { threadId: 'thread_c', text: `Z: ${QUOTED_BLOCK} 0; }` };
    const fwd = JSON.stringify(findThreadQuotes([a, b, c]));
    const rev = JSON.stringify(findThreadQuotes([c, b, a]));
    const mix = JSON.stringify(findThreadQuotes([b, c, a]));
    expect(rev).toBe(fwd);
    expect(mix).toBe(fwd);
  });

  it('does NOT emit a quote edge when the only shared substring is a URL', () => {
    // Two threads paste the same long URL but otherwise have unique
    // surrounding text. Pre-strip removes the URL so the shingles
    // that match are zero — quote edge does not fire.
    const SHARED_URL = 'https://news.ycombinator.com/item?id=42_pgmerge';
    expect(SHARED_URL.length).toBeGreaterThan(40);
    const inputs: ThreadText[] = [
      {
        threadId: 'thread_pg',
        text: `please look at ${SHARED_URL} and explain the MERGE pitfall to me clearly.`,
      },
      {
        threadId: 'thread_sb',
        text: `unrelated context: ${SHARED_URL} but the discussion is about reducer pass 2 design.`,
      },
    ];
    expect(findThreadQuotes(inputs)).toEqual([]);
  });

  it('caps emitted edges at 1024 with stable truncation', () => {
    // Build 50 threads sharing the same QUOTED_BLOCK → 50*49 = 2450 ordered pairs.
    const inputs: ThreadText[] = [];
    for (let i = 0; i < 50; i += 1) {
      const id = `thread_${String(i).padStart(3, '0')}`;
      inputs.push({ threadId: id, text: `${id}: ${QUOTED_BLOCK} 0; }` });
    }
    const matches = findThreadQuotes(inputs);
    expect(matches.length).toBe(1024);
    // Stable truncation — first match is the lex-smallest (from, to) pair.
    expect(matches[0]?.fromThreadId).toBe('thread_000');
  });
});
