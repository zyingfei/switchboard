import { describe, expect, it } from 'vitest';

import { normalizeSelectionText } from '../../../src/graph/normalize-selection';

describe('normalizeSelectionText', () => {
  it('collapses whitespace', () => {
    expect(normalizeSelectionText(' hello   world \n\n next\tline ')).toBe('hello world next line');
  });

  it('strips markdown setext headers and prefixed chrome lines', () => {
    expect(normalizeSelectionText('Title Here\n====\n# nav\n> quote\n// chrome\nbody')).toBe('body');
  });

  it('drops pure timestamp lines', () => {
    expect(normalizeSelectionText('2026-05-08\nbody\n2026-05-08 10:30:00')).toBe('body');
  });

  it('preserves unicode content after normalization', () => {
    expect(normalizeSelectionText('  café   東京  ')).toBe('café 東京');
  });
});
