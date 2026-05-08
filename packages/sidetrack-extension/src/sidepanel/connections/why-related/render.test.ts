import { describe, expect, it } from 'vitest';

import reasonsFixture from '../__fixtures__/reasons-all.json';
import type { Reason } from './reasons';
import { renderReason } from './render';

const reasons = reasonsFixture as readonly (Reason & { readonly expected: string })[];

describe('renderReason', () => {
  it('renders every reason code exactly', () => {
    expect(reasons).toHaveLength(14);
    for (const reason of reasons) {
      expect(renderReason(reason), reason.code).toBe(reason.expected);
    }
  });

  it('is locale-stable for repeated renders', () => {
    const first = JSON.stringify(reasons.map(renderReason));
    const second = JSON.stringify(reasons.map(renderReason));

    expect(first).toBe(second);
  });
});
