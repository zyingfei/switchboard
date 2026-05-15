import { describe, expect, it } from 'vitest';

import reasonsFixture from '../__fixtures__/reasons-all.json';
import { REASON_CODES, type Reason } from './reasons';

const assertNever = (value: never): never => {
  throw new Error(`unhandled reason: ${JSON.stringify(value)}`);
};

const codeFor = (reason: Reason): Reason['code'] => {
  switch (reason.code) {
    case 'SAME_THREAD':
    case 'SAME_TOPIC':
    case 'COSINE_ABOVE_THRESHOLD':
    case 'OPENER_CHAIN':
    case 'PREVIOUS_VISIT_IN_TAB_SESSION':
    case 'TRANSITION_TYPE':
    case 'TRANSITION_QUALIFIER':
    case 'COPIED_FROM':
    case 'PASTED_INTO':
    case 'OBSERVED_ON_OTHER_REPLICA':
    case 'RANKER_SCORE':
    case 'LEXICAL_OVERLAP':
    case 'LINK_OUT_FROM':
    case 'LINK_IN_TO':
    case 'PAGE_CONTENT_COVERAGE':
      return reason.code;
    default:
      return assertNever(reason);
  }
};

describe('Reason union', () => {
  it('covers every documented reason code exhaustively', () => {
    const fixtureReasons = reasonsFixture as readonly (Reason & { readonly expected: string })[];

    expect(fixtureReasons.map(codeFor).sort()).toEqual([...REASON_CODES].sort());
  });
});
