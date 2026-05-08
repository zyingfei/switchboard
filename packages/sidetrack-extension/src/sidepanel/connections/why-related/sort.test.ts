import { describe, expect, it } from 'vitest';

import reasonsFixture from '../__fixtures__/reasons-all.json';
import type { Reason } from './reasons';
import { sortReasons } from './sort';

const reasons = reasonsFixture as readonly (Reason & { readonly expected: string })[];

describe('sortReasons', () => {
  it('sorts by fixed priority order', () => {
    const sorted = sortReasons([...reasons].reverse());

    expect(sorted.map((reason) => reason.code)).toEqual([
      'SAME_THREAD',
      'COPIED_FROM',
      'PASTED_INTO',
      'OPENER_CHAIN',
      'PREVIOUS_VISIT_IN_TAB_SESSION',
      'TRANSITION_QUALIFIER',
      'TRANSITION_TYPE',
      'OBSERVED_ON_OTHER_REPLICA',
      'SAME_TOPIC',
      'RANKER_SCORE',
      'COSINE_ABOVE_THRESHOLD',
      'LINK_IN_TO',
      'LINK_OUT_FROM',
      'LEXICAL_OVERLAP',
    ]);
  });

  it('breaks ties by stringified payload', () => {
    const sorted = sortReasons([
      { code: 'COSINE_ABOVE_THRESHOLD', cosine: 0.91, threshold: 0.85 },
      { code: 'COSINE_ABOVE_THRESHOLD', cosine: 0.9, threshold: 0.85 },
    ]);

    expect(sorted).toEqual([
      { code: 'COSINE_ABOVE_THRESHOLD', cosine: 0.9, threshold: 0.85 },
      { code: 'COSINE_ABOVE_THRESHOLD', cosine: 0.91, threshold: 0.85 },
    ]);
  });
});
