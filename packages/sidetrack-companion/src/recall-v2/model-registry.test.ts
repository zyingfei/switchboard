import { describe, expect, it } from 'vitest';

import {
  __resetUnknownModelWarnCache,
  profileFor,
  semanticContributionMultiplier,
} from './model-registry.js';

describe('model-registry', () => {
  it('returns e5-small profile for known model id (strips revision suffix)', () => {
    const p = profileFor('Xenova/multilingual-e5-small#rev=abcdef#prefix-query-v1');
    expect(p.modelId).toBe('Xenova/multilingual-e5-small');
    expect(p.semGapNoiseFloor).toBe(0.03);
    expect(p.semGapFullSignal).toBe(0.07);
    expect(p.semAbsoluteSignalFloor).toBe(0.6);
    expect(p.calibratedAt).not.toBe('default-unsafe');
  });

  it('returns safe default for unknown model + warns once', () => {
    __resetUnknownModelWarnCache();
    const p = profileFor('made/up-embedder');
    expect(p.calibratedAt).toBe('default-unsafe');
    expect(p.semAbsoluteSignalFloor).toBe(0);
  });

  describe('semanticContributionMultiplier', () => {
    const e5 = profileFor('Xenova/multilingual-e5-small');

    it('passes through for small pools (n < 5)', () => {
      // Flat noise distribution but count = 3 — small pool bypass
      expect(semanticContributionMultiplier(e5, 0.45, 0.45, 0.45, 3)).toBe(1);
    });

    it('passes through when minCosine >= absolute signal floor', () => {
      // Tight cluster but all cosines above 0.6 — bypass via signal floor
      expect(semanticContributionMultiplier(e5, 0.99, 0.99, 0.98, 6)).toBe(1);
    });

    it('mutes flat-noise streams (gap < noise floor)', () => {
      // Cosines clustered near production noise floor; gap = 0.01 << 0.03
      expect(semanticContributionMultiplier(e5, 0.43, 0.42, 0.41, 20)).toBe(0);
    });

    it('full strength when gap >= full-signal threshold', () => {
      // Gap = 0.10 well above the 0.07 full-signal threshold
      expect(semanticContributionMultiplier(e5, 0.54, 0.44, 0.40, 20)).toBe(1);
    });

    it('linear ramp between noise-floor and full-signal', () => {
      // Gap = 0.05; expected normalized = (0.05 - 0.03) / (0.07 - 0.03) = 0.5
      const m = semanticContributionMultiplier(e5, 0.50, 0.45, 0.40, 20);
      expect(m).toBeGreaterThanOrEqual(0.45);
      expect(m).toBeLessThanOrEqual(0.55);
    });

    it('safe-default model always returns 1 (gate disabled)', () => {
      __resetUnknownModelWarnCache();
      const unknown = profileFor('made/up-embedder-2');
      // Even with completely flat distribution, unknown model passes
      expect(semanticContributionMultiplier(unknown, 0.5, 0.5, 0.5, 20)).toBe(1);
    });
  });
});
