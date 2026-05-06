import { describe, expect, it } from 'vitest';

import { AnchorBuilderError, buildAnchorFromTerm } from './anchorBuilder.js';

describe('buildAnchorFromTerm', () => {
  it('returns 32-char prefix + suffix windows around the first occurrence', () => {
    const turnText =
      'Browser graphics stack: WebGPU gives apps lower-level GPU access without native installs.';
    const anchor = buildAnchorFromTerm({ turnText, term: 'WebGPU' });
    expect(anchor).toMatchObject({
      textQuote: {
        exact: 'WebGPU',
        prefix: 'Browser graphics stack: ',
        suffix: ' gives apps lower-level GPU acce',
      },
      textPosition: { start: -1, end: -1 },
      cssSelector: '',
    });
    expect(anchor.textQuote.suffix.length).toBe(32);
  });

  it('selects a later occurrence when ordinal:N is set', () => {
    const turnText =
      'WebGPU is the first WebGPU mention. Then the second WebGPU shows up at the end.';
    const first = buildAnchorFromTerm({ turnText, term: 'WebGPU' });
    expect(turnText.slice(0, turnText.indexOf('WebGPU') + 6)).toBe('WebGPU');
    const third = buildAnchorFromTerm({
      turnText,
      term: 'WebGPU',
      selectionHint: 'ordinal:3',
    });
    expect(third.textQuote.suffix.length).toBeGreaterThan(0);
    expect(first.textQuote.prefix).toBe('');
    expect(third.textQuote.prefix).toContain('the second ');
  });

  it('rejects an out-of-range ordinal', () => {
    expect(() =>
      buildAnchorFromTerm({
        turnText: 'WebGPU appears only once.',
        term: 'WebGPU',
        selectionHint: 'ordinal:5',
      }),
    ).toThrow(AnchorBuilderError);
  });

  it('selects the occurrence whose preceding context ends with the hint fragment', () => {
    const turnText =
      'Section 1 — Architecture: WebGPU. Section 2 — Performance: WebGPU. Section 3 — Security: WebGPU.';
    const anchor = buildAnchorFromTerm({
      turnText,
      term: 'WebGPU',
      selectionHint: 'Performance:',
    });
    expect(anchor.textQuote.prefix).toContain('Performance:');
  });

  it('throws hint-no-match when the preceding fragment is absent', () => {
    expect(() =>
      buildAnchorFromTerm({
        turnText: 'Just one WebGPU mention.',
        term: 'WebGPU',
        selectionHint: 'totally different fragment',
      }),
    ).toThrow(AnchorBuilderError);
  });

  it('throws term-not-found when the keyword is absent', () => {
    expect(() =>
      buildAnchorFromTerm({
        turnText: 'Body without the keyword.',
        term: 'WebGPU',
      }),
    ).toThrow(AnchorBuilderError);
  });

  it('rejects short terms without a hint', () => {
    expect(() =>
      buildAnchorFromTerm({
        turnText: 'AI is referenced in this turn body.',
        term: 'AI',
      }),
    ).toThrow(AnchorBuilderError);
  });

  it('accepts short terms when a preceding-fragment hint is provided', () => {
    // selectionHint matches the preceding context of the THIRD occurrence
    // ("…the topic is "). Without the hint, the matcher would (a) reject
    // for being shorter than the safety floor, and (b) pick the first
    // occurrence anyway.
    const anchor = buildAnchorFromTerm({
      turnText:
        'AI in research and AI in production diverge. The topic is AI safety today.',
      term: 'AI',
      selectionHint: 'topic is',
    });
    expect(anchor.textQuote.prefix).toContain('topic is');
  });

  it('preserves multibyte characters in the windows', () => {
    const turnText =
      'café architecture stack: WebGPU shines for résumé-fast operations.';
    const anchor = buildAnchorFromTerm({ turnText, term: 'WebGPU' });
    expect(anchor.textQuote.prefix).toContain('café');
    expect(anchor.textQuote.suffix).toContain('résumé');
  });
});
