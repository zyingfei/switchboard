import { describe, expect, it } from 'vitest';

import { buildAnchorFromTerm } from './anchorBuilder.js';

const requireOk = (
  result: ReturnType<typeof buildAnchorFromTerm>,
): Extract<ReturnType<typeof buildAnchorFromTerm>, { ok: true }> => {
  if (!result.ok) {
    throw new Error(`expected ok result, got ${result.reason}: ${result.message}`);
  }
  return result;
};

describe('buildAnchorFromTerm', () => {
  it('returns 32-char prefix + suffix windows around the first occurrence', () => {
    const turnText =
      'Browser graphics stack: WebGPU gives apps lower-level GPU access without native installs.';
    const result = requireOk(buildAnchorFromTerm({ turnText, term: 'WebGPU' }));
    expect(result.anchor).toMatchObject({
      textQuote: {
        exact: 'WebGPU',
        prefix: 'Browser graphics stack: ',
        suffix: ' gives apps lower-level GPU acce',
      },
      textPosition: { start: -1, end: -1 },
      cssSelector: '',
    });
    expect(result.anchor.textQuote.suffix.length).toBe(32);
    expect(result.occurrenceCount).toBe(1);
  });

  it('selects a later occurrence when ordinal:N is set', () => {
    const turnText =
      'WebGPU is the first WebGPU mention. Then the second WebGPU shows up at the end.';
    const third = requireOk(
      buildAnchorFromTerm({
        turnText,
        term: 'WebGPU',
        selectionHint: 'ordinal:3',
      }),
    );
    expect(third.anchor.textQuote.suffix.length).toBeGreaterThan(0);
    expect(third.anchor.textQuote.prefix).toContain('the second ');
    expect(third.occurrenceCount).toBe(3);
  });

  it('returns ambiguous_term_requires_selection_hint by default for repeated terms', () => {
    const result = buildAnchorFromTerm({
      turnText: 'WebGPU and WebGPU and one more WebGPU mention.',
      term: 'WebGPU',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('ambiguous_term_requires_selection_hint');
      expect(result.occurrenceCount).toBe(3);
      expect(result.suggestedSelectionHints).toBeDefined();
      expect(result.suggestedSelectionHints?.[0]).toBe('ordinal:1');
    }
  });

  it('honours repeatedTerm:first when the caller opts in', () => {
    const result = requireOk(
      buildAnchorFromTerm({
        turnText: 'WebGPU and WebGPU again.',
        term: 'WebGPU',
        policy: { repeatedTerm: 'first' },
      }),
    );
    expect(result.anchor.textQuote.prefix).toBe('');
  });

  it('returns invalid_ordinal for an out-of-range ordinal', () => {
    const result = buildAnchorFromTerm({
      turnText: 'WebGPU appears only once.',
      term: 'WebGPU',
      selectionHint: 'ordinal:5',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_ordinal');
    }
  });

  it('selects the occurrence whose preceding context ends with the hint fragment', () => {
    const turnText =
      'Section 1 — Architecture: WebGPU. Section 2 — Performance: WebGPU. Section 3 — Security: WebGPU.';
    const result = requireOk(
      buildAnchorFromTerm({
        turnText,
        term: 'WebGPU',
        selectionHint: 'Performance:',
      }),
    );
    expect(result.anchor.textQuote.prefix).toContain('Performance:');
  });

  it('returns selection_hint_no_match when the preceding fragment is absent', () => {
    const result = buildAnchorFromTerm({
      turnText: 'Just one WebGPU mention.',
      term: 'WebGPU',
      selectionHint: 'totally different fragment',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('selection_hint_no_match');
    }
  });

  it('returns term_not_found when the keyword is absent', () => {
    const result = buildAnchorFromTerm({
      turnText: 'Body without the keyword.',
      term: 'WebGPU',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('term_not_found');
    }
  });

  it('rejects short terms without a hint', () => {
    const result = buildAnchorFromTerm({
      turnText: 'AI is referenced in this turn body.',
      term: 'AI',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('short_term_requires_selection_hint');
    }
  });

  it('accepts short terms when a preceding-fragment hint is provided', () => {
    const result = requireOk(
      buildAnchorFromTerm({
        turnText:
          'AI in research and AI in production diverge. The topic is AI safety today.',
        term: 'AI',
        selectionHint: 'topic is',
      }),
    );
    expect(result.anchor.textQuote.prefix).toContain('topic is');
  });

  it('preserves multibyte characters in the windows', () => {
    const turnText =
      'café architecture stack: WebGPU shines for résumé-fast operations.';
    const result = requireOk(buildAnchorFromTerm({ turnText, term: 'WebGPU' }));
    expect(result.anchor.textQuote.prefix).toContain('café');
    expect(result.anchor.textQuote.suffix).toContain('résumé');
  });

  it('exposes a list of suggested selection hints when ambiguous', () => {
    const result = buildAnchorFromTerm({
      turnText: 'leaf node, then the leaf in the index, then the leaf again.',
      term: 'leaf',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.suggestedSelectionHints).toBeDefined();
      expect(result.suggestedSelectionHints?.length ?? 0).toBeGreaterThan(0);
      // ordinal hints come first, preceding fragments after.
      expect(result.suggestedSelectionHints?.[0]).toBe('ordinal:1');
    }
  });
});
