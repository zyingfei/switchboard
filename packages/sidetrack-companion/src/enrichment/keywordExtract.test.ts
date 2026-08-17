import { describe, expect, it } from 'bun:test';

import {
  KEYWORD_MAX_PER_GIST,
  detectGistLanguage,
  extractDeterministicKeywords,
  extractKeywords,
  extractLlmKeywords,
  normalizeKeyword,
} from './keywordExtract.js';

describe('detectGistLanguage', () => {
  it('classifies pure English as en', () => {
    expect(detectGistLanguage('This article discusses distributed systems and consensus.')).toBe(
      'en',
    );
  });

  it('classifies Han-dominant text as zh', () => {
    expect(detectGistLanguage('这篇文章讨论了分布式系统和共识算法的设计与实现细节。')).toBe('zh');
  });

  it('classifies a Han/Latin blend as mixed-en-zh', () => {
    const text =
      'This document mentions 神经网络架构 and 深度学习模型训练 alongside the English prose ' +
      'that makes up most of the sentence, which stays majority Latin overall.';
    expect(detectGistLanguage(text)).toBe('mixed-en-zh');
  });

  it('treats empty/unscripted text as en (no scripted chars to judge)', () => {
    expect(detectGistLanguage('123 456 789')).toBe('en');
  });
});

describe('normalizeKeyword', () => {
  it('lowercases, trims, and strips surrounding markup', () => {
    expect(normalizeKeyword('  **Kubernetes**  ')).toBe('kubernetes');
    expect(normalizeKeyword('"zero-day security."')).toBe('zero-day security');
    expect(normalizeKeyword('- distributed systems')).toBe('distributed systems');
  });
});

describe('extractLlmKeywords — the "Keywords:" line', () => {
  it('parses the inline comma list at the end of a gist', () => {
    const gist =
      'Anthropic released a new Claude model with improved reasoning. ' +
      'The release focuses on coding and agentic workflows.\n' +
      'Keywords: Claude, Anthropic, reasoning, coding, agentic workflows';
    const result = extractLlmKeywords(gist);
    expect(result.found).toBe(true);
    expect(result.keywords).toEqual([
      'claude',
      'anthropic',
      'reasoning',
      'coding',
      'agentic workflows',
    ]);
    expect(result.dropped).toBe(0);
  });

  it('reports found:false when there is no Keywords section', () => {
    const result = extractLlmKeywords('Just a plain summary with no structured section.');
    expect(result.found).toBe(false);
    expect(result.keywords).toEqual([]);
  });

  it('does not match "keywords" appearing mid-sentence (line-anchored)', () => {
    const gist =
      'The search engine ranks pages using keywords extracted from the query. ' +
      'No structured section follows.';
    const result = extractLlmKeywords(gist);
    expect(result.found).toBe(false);
  });

  it('treats an honest "none" as found-but-empty, not a keyword called "none"', () => {
    const gist = 'A thin page with little content.\nKeywords: None';
    const result = extractLlmKeywords(gist);
    expect(result.found).toBe(true);
    expect(result.keywords).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it('dedupes case-insensitively and caps at KEYWORD_MAX_PER_GIST, counting overflow as dropped', () => {
    const many = Array.from({ length: KEYWORD_MAX_PER_GIST + 5 }, (_, i) => `term${String(i)}`);
    const gist = `Summary text.\nKeywords: ${many.join(', ')}, term0`;
    const result = extractLlmKeywords(gist);
    expect(result.keywords.length).toBe(KEYWORD_MAX_PER_GIST);
    // term0 repeated once (dup, not counted) + 5 overflow terms (counted).
    expect(result.dropped).toBe(5);
  });

  it('rejects a candidate below the minimum length without crashing', () => {
    const gist = 'Summary text.\nKeywords: a, b, real term';
    const result = extractLlmKeywords(gist);
    expect(result.keywords).toEqual(['real term']);
    expect(result.dropped).toBe(2);
  });
});

describe('extractDeterministicKeywords — frequency + stopword, no LLM', () => {
  it('ranks the most frequent content words first, stopwords excluded', () => {
    const text =
      'Kubernetes is a container orchestration platform. Kubernetes automates ' +
      'deployment and scaling. Many teams run Kubernetes in production because ' +
      'Kubernetes handles failover automatically.';
    const result = extractDeterministicKeywords(text, 3);
    expect(result.found).toBe(true);
    expect(result.keywords[0]).toBe('kubernetes');
    expect(result.keywords).not.toContain('the');
    expect(result.keywords).not.toContain('and');
  });

  it('is deterministic — same input twice yields identical output', () => {
    const text = 'Rust ownership borrowing lifetimes memory safety Rust Rust borrowing.';
    const first = extractDeterministicKeywords(text);
    const second = extractDeterministicKeywords(text);
    expect(first.keywords).toEqual(second.keywords);
  });

  it('extracts frequency-ranked terms from Han text without a segmentation library', () => {
    // "神经网络" (neural network) repeats three times and should dominate.
    const text = '神经网络是深度学习的核心。研究人员使用神经网络解决图像识别问题。神经网络的训练需要大量数据。';
    const result = extractDeterministicKeywords(text, 5);
    expect(result.found).toBe(true);
    expect(result.keywords.length).toBeGreaterThan(0);
    expect(result.keywords).toContain('神经网络');
  });

  it('returns an empty (not thrown) result for content with no usable tokens', () => {
    const result = extractDeterministicKeywords('12 34 56 !! ?? ...');
    expect(result.found).toBe(true);
    expect(result.keywords).toEqual([]);
    expect(result.dropped).toBe(0);
  });
});

describe('extractKeywords — composed decision', () => {
  it('trusts the LLM keywords line for an English gist that has one', () => {
    const gist =
      'A summary of the release notes for a new database engine.\n' +
      'Keywords: database, indexing, query planner';
    const result = extractKeywords(gist, { language: 'en' });
    expect(result.source).toBe('llm');
    expect(result.keywords).toEqual(['database', 'indexing', 'query planner']);
  });

  it('falls through to the deterministic path for an English gist with no Keywords line', () => {
    const gist =
      'Kubernetes orchestrates containers across a cluster of machines. ' +
      'Kubernetes schedules workloads and manages networking automatically.';
    const result = extractKeywords(gist, { language: 'en' });
    expect(result.source).toBe('deterministic');
    expect(result.keywords[0]).toBe('kubernetes');
  });

  it('never trusts a Keywords line on a zh-dominant gist, even if one is present', () => {
    // Language is passed explicitly here to isolate "source selection given a
    // known language" from detectGistLanguage's own ratio heuristic (covered
    // separately above) — an appended English Keywords line dilutes the
    // whole-gist Han ratio in a way a real (longer) zh gist mostly wouldn't.
    const gist =
      '这篇文章讨论了神经网络的训练方法和优化技巧，涉及大量的数学推导和实验验证过程。\n' +
      'Keywords: neural network, training';
    const result = extractKeywords(gist, { language: 'zh' });
    expect(result.language).toBe('zh');
    expect(result.source).toBe('deterministic');
    // The (untrusted) English keywords line must not leak through.
    expect(result.keywords).not.toContain('neural network');
  });

  it('falls through to deterministic for mixed-en-zh gists', () => {
    const gist =
      'This document mentions 神经网络架构 and 深度学习模型训练 several times across the ' +
      'mostly-English prose that makes up the bulk of this particular passage.';
    const result = extractKeywords(gist);
    expect(result.language).toBe('mixed-en-zh');
    expect(result.source).toBe('deterministic');
  });

  it('falls through to deterministic when the LLM keywords line parses to nothing usable', () => {
    const gist =
      'Kubernetes orchestrates containers across a cluster of many machines today.\n' +
      'Keywords: none';
    const result = extractKeywords(gist, { language: 'en' });
    expect(result.source).toBe('deterministic');
  });

  it('is pure and deterministic across repeated calls on the same gist', () => {
    const gist =
      'Rust emphasizes memory safety without a garbage collector, using ownership ' +
      'and borrowing checked at compile time.\nKeywords: Rust, ownership, borrowing';
    const a = extractKeywords(gist, { language: 'en' });
    const b = extractKeywords(gist, { language: 'en' });
    expect(a).toEqual(b);
  });
});
