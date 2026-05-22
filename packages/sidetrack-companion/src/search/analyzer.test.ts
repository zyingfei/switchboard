import { describe, expect, it } from 'vitest';

import { ANALYZER_VERSION, analyze } from './analyzer.js';

describe('analyzer', () => {
  describe('English + numbers', () => {
    it('lowercases and splits on whitespace + ASCII punctuation', () => {
      expect(analyze('The Quick, Brown Fox!')).toEqual(['the', 'quick', 'brown', 'fox']);
    });

    it('keeps alphanumeric tokens including digits, kebab whole + parts', () => {
      const tokens = analyze('claude-3.5 vs gpt-4o');
      // whole compound identifiers
      expect(tokens).toContain('claude-3.5');
      expect(tokens).toContain('gpt-4o');
      // split parts (digits land as their own tokens)
      expect(tokens).toContain('claude');
      expect(tokens).toContain('gpt');
      expect(tokens).toContain('3');
      expect(tokens).toContain('5');
      expect(tokens).toContain('4o');
      expect(tokens).toContain('vs');
    });

    it('keeps a standalone dotted decimal whole + parts', () => {
      // `3.5` standalone (no surrounding identifier) is itself a
      // dotted identifier — kept whole AND split.
      const tokens = analyze('3.5');
      expect(tokens).toEqual(expect.arrayContaining(['3.5', '3', '5']));
    });
  });

  describe('Dotted / kebab / snake identifiers', () => {
    it('keeps a dotted identifier whole AND emits its parts', () => {
      const tokens = analyze('sidetrack.threads.move');
      expect(tokens).toContain('sidetrack.threads.move');
      expect(tokens).toContain('sidetrack');
      expect(tokens).toContain('threads');
      expect(tokens).toContain('move');
    });

    it('keeps a kebab identifier whole AND emits its parts', () => {
      const tokens = analyze('semantic-recall-pool');
      expect(tokens).toContain('semantic-recall-pool');
      expect(tokens).toContain('semantic');
      expect(tokens).toContain('recall');
      expect(tokens).toContain('pool');
    });

    it('keeps a snake identifier whole AND emits its parts', () => {
      const tokens = analyze('feature_version_check');
      expect(tokens).toContain('feature_version_check');
      expect(tokens).toContain('feature');
      expect(tokens).toContain('version');
      expect(tokens).toContain('check');
    });

    it('strips leading/trailing punctuation but preserves interior', () => {
      const tokens = analyze('..foo.bar..');
      expect(tokens).toContain('foo.bar');
      expect(tokens).toContain('foo');
      expect(tokens).toContain('bar');
      expect(tokens).not.toContain('..foo.bar..');
    });
  });

  describe('CJK', () => {
    it('emits phrase + bigrams + unigrams for a pure-CJK token', () => {
      const tokens = analyze('分布式系统');
      // phrase
      expect(tokens).toContain('分布式系统');
      // bigrams
      expect(tokens).toContain('分布');
      expect(tokens).toContain('布式');
      expect(tokens).toContain('式系');
      expect(tokens).toContain('系统');
      // unigrams
      expect(tokens).toContain('分');
      expect(tokens).toContain('布');
      expect(tokens).toContain('式');
      expect(tokens).toContain('系');
      expect(tokens).toContain('统');
    });

    it('splits CJK punctuation (、。) so English embedded in CJK surfaces', () => {
      const tokens = analyze('Jepsen、Elle、TLA+、DST、fuzzing');
      expect(tokens).toContain('jepsen');
      expect(tokens).toContain('elle');
      expect(tokens).toContain('tla+');
      expect(tokens).toContain('dst');
      expect(tokens).toContain('fuzzing');
    });

    it('splits at the CJK ↔ Latin boundary with no separator', () => {
      const tokens = analyze('故障注入Jepsen');
      expect(tokens).toContain('故障注入');
      expect(tokens).toContain('jepsen');
    });

    it('handles a length-2 CJK token (the phrase IS the bigram)', () => {
      const tokens = analyze('测试');
      // phrase + bigram are the same string; unigrams are the parts
      expect(tokens).toContain('测试');
      expect(tokens).toContain('测');
      expect(tokens).toContain('试');
    });

    it('leaves a length-1 CJK token alone (the char IS the unigram)', () => {
      expect(analyze('测')).toEqual(['测']);
    });

    it('a query bigram present in a long CJK phrase produces a matching term', () => {
      // The whole "再抽出它的测试模型" tokenizes to one chunk-side phrase
      // (no internal punctuation). A query for "测试" must produce a
      // bigram that intersects with the chunk's bigram fan-out so
      // MiniSearch's OR query hits.
      const chunkTerms = new Set(analyze('再抽出它的测试模型'));
      const queryTerms = analyze('测试');
      expect(queryTerms.some((t) => chunkTerms.has(t))).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('returns an empty array for an empty / whitespace-only input', () => {
      expect(analyze('')).toEqual([]);
      expect(analyze('   \n\t  ')).toEqual([]);
    });

    it('drops length-zero artifacts from regex splits', () => {
      const tokens = analyze('a,,,b');
      expect(tokens).toEqual(['a', 'b']);
    });
  });

  describe('ANALYZER_VERSION', () => {
    it('exports a stable integer version', () => {
      expect(typeof ANALYZER_VERSION).toBe('number');
      expect(Number.isInteger(ANALYZER_VERSION)).toBe(true);
      expect(ANALYZER_VERSION).toBeGreaterThan(0);
    });
  });
});
