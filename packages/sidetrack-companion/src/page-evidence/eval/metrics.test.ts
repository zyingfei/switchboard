import { describe, expect, it } from 'vitest';

import { mrr, noiseRateAtThreshold, precisionAtK, recallAtK } from './metrics.js';

describe('page-evidence similarity eval metrics', () => {
  const gold = [
    { fromCanonicalUrl: 'a', toCanonicalUrl: 'b', label: 'related' as const },
    { fromCanonicalUrl: 'a', toCanonicalUrl: 'c', label: 'unrelated' as const },
    { fromCanonicalUrl: 'd', toCanonicalUrl: 'e', label: 'related' as const },
  ];

  const results = [
    { fromCanonicalUrl: 'a', toCanonicalUrl: 'b', score: 0.9 },
    { fromCanonicalUrl: 'a', toCanonicalUrl: 'c', score: 0.8 },
    { fromCanonicalUrl: 'd', toCanonicalUrl: 'x', score: 0.7 },
    { fromCanonicalUrl: 'd', toCanonicalUrl: 'e', score: 0.6 },
  ];

  it('computes recall, precision, MRR, and threshold noise deterministically', () => {
    expect(recallAtK(results, gold, 1)).toBe(0.75);
    expect(precisionAtK(results, gold, 1)).toBe(0.5);
    expect(mrr(results, gold)).toBe(0.875);
    expect(noiseRateAtThreshold(results, gold, 0.8)).toBe(0.5);
  });
});
