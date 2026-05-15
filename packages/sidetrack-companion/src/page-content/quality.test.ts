import { describe, expect, it } from 'vitest';

import { classifyPageContentQuality } from './quality.js';
import { type GrayZoneScorer } from './qualityScorer.js';
import type { PageContentExtractionStrategy, PageContentQualitySignals } from './types.js';

const signals = (
  partial: Partial<PageContentQualitySignals> & {
    readonly extractedWordCount: number;
    readonly contentToDomRatio: number;
    readonly boilerplateFraction: number;
  },
): PageContentQualitySignals => ({
  extractionStrategy: 'visible-dom',
  ...partial,
});

/**
 * The legacy (pre-scorer) classifier, transcribed verbatim. Tests
 * assert the default classifier is byte-identical to this across a
 * grid of inputs — the zero-regression guarantee.
 */
const legacyClassify = (
  s: PageContentQualitySignals,
): { readonly state: string; readonly quality?: string; readonly error?: string } => {
  if (s.extractedWordCount < 30 || s.contentToDomRatio < 0.05 || s.boilerplateFraction > 0.8) {
    return { state: 'metadata_only_error', error: 'extraction_quality_below_floor' };
  }
  if (
    s.extractedWordCount >= 300 &&
    s.contentToDomRatio >= 0.4 &&
    (s.extractionStrategy === 'reader-mode' || s.extractionStrategy === 'manual-selection')
  ) {
    return { state: 'indexed', quality: 'high' };
  }
  if (
    s.extractedWordCount >= 100 &&
    (s.contentToDomRatio >= 0.2 || s.boilerplateFraction <= 0.35)
  ) {
    return { state: 'indexed', quality: 'medium' };
  }
  return { state: 'indexed_low_quality', quality: 'low' };
};

const STRATEGIES: readonly PageContentExtractionStrategy[] = [
  'reader-mode',
  'manual-selection',
  'visible-dom',
];

describe('classifyPageContentQuality — hard floor (deterministic must-reject)', () => {
  it('rejects on too few words regardless of other signals', () => {
    expect(
      classifyPageContentQuality(
        signals({ extractedWordCount: 29, contentToDomRatio: 0.99, boilerplateFraction: 0 }),
      ),
    ).toEqual({ state: 'metadata_only_error', error: 'extraction_quality_below_floor' });
  });

  it('rejects on too low content-to-dom ratio', () => {
    expect(
      classifyPageContentQuality(
        signals({
          extractedWordCount: 5000,
          contentToDomRatio: 0.049,
          boilerplateFraction: 0,
        }),
      ),
    ).toEqual({ state: 'metadata_only_error', error: 'extraction_quality_below_floor' });
  });

  it('rejects on excessive boilerplate', () => {
    expect(
      classifyPageContentQuality(
        signals({
          extractedWordCount: 5000,
          contentToDomRatio: 0.99,
          boilerplateFraction: 0.81,
        }),
      ),
    ).toEqual({ state: 'metadata_only_error', error: 'extraction_quality_below_floor' });
  });

  it('floor wins even if a (mis)injected scorer would say medium', () => {
    const alwaysMedium: GrayZoneScorer = () => 'medium';
    expect(
      classifyPageContentQuality(
        signals({ extractedWordCount: 10, contentToDomRatio: 0.01, boilerplateFraction: 1 }),
        alwaysMedium,
      ),
    ).toEqual({ state: 'metadata_only_error', error: 'extraction_quality_below_floor' });
  });
});

describe('classifyPageContentQuality — high tier (deterministic must-accept)', () => {
  it('accepts a long reader-mode page as high', () => {
    expect(
      classifyPageContentQuality(
        signals({
          extractedWordCount: 300,
          contentToDomRatio: 0.4,
          boilerplateFraction: 0.5,
          extractionStrategy: 'reader-mode',
        }),
      ),
    ).toEqual({ state: 'indexed', quality: 'high' });
  });

  it('accepts a long manual-selection page as high', () => {
    expect(
      classifyPageContentQuality(
        signals({
          extractedWordCount: 1000,
          contentToDomRatio: 0.9,
          boilerplateFraction: 0.7,
          extractionStrategy: 'manual-selection',
        }),
      ),
    ).toEqual({ state: 'indexed', quality: 'high' });
  });

  it('high tier wins even if a (mis)injected scorer would say low', () => {
    const alwaysLow: GrayZoneScorer = () => 'low';
    expect(
      classifyPageContentQuality(
        signals({
          extractedWordCount: 500,
          contentToDomRatio: 0.6,
          boilerplateFraction: 0.2,
          extractionStrategy: 'reader-mode',
        }),
        alwaysLow,
      ),
    ).toEqual({ state: 'indexed', quality: 'high' });
  });

  it('does NOT promote visible-dom to high even when long and dense', () => {
    expect(
      classifyPageContentQuality(
        signals({
          extractedWordCount: 5000,
          contentToDomRatio: 0.9,
          boilerplateFraction: 0,
          extractionStrategy: 'visible-dom',
        }),
      ),
    ).toEqual({ state: 'indexed', quality: 'medium' });
  });
});

describe('classifyPageContentQuality — gray zone with NO model (byte-identical to legacy rule)', () => {
  it('matches the legacy classifier across a dense input grid', () => {
    for (const wordCount of [0, 29, 30, 99, 100, 150, 299, 300, 800]) {
      for (const ratio of [0, 0.04, 0.05, 0.19, 0.2, 0.39, 0.4, 0.7]) {
        for (const boilerplate of [0, 0.3, 0.35, 0.36, 0.7, 0.8, 0.81]) {
          for (const strategy of STRATEGIES) {
            const s = signals({
              extractedWordCount: wordCount,
              contentToDomRatio: ratio,
              boilerplateFraction: boilerplate,
              extractionStrategy: strategy,
            });
            expect(classifyPageContentQuality(s)).toEqual(legacyClassify(s));
          }
        }
      }
    }
  });

  it('classifies a borderline page as medium via the ratio branch', () => {
    // High boilerplate (0.75, still under the 0.8 floor) so only the
    // ratio branch can rescue this into `medium`.
    expect(
      classifyPageContentQuality(
        signals({
          extractedWordCount: 100,
          contentToDomRatio: 0.2,
          boilerplateFraction: 0.75,
        }),
      ),
    ).toEqual({ state: 'indexed', quality: 'medium' });
  });

  it('classifies a borderline page as medium via the boilerplate branch', () => {
    expect(
      classifyPageContentQuality(
        signals({
          extractedWordCount: 120,
          contentToDomRatio: 0.1,
          boilerplateFraction: 0.35,
        }),
      ),
    ).toEqual({ state: 'indexed', quality: 'medium' });
  });

  it('classifies a weak page as low', () => {
    expect(
      classifyPageContentQuality(
        signals({
          extractedWordCount: 80,
          contentToDomRatio: 0.1,
          boilerplateFraction: 0.6,
        }),
      ),
    ).toEqual({ state: 'indexed_low_quality', quality: 'low' });
  });
});

describe('classifyPageContentQuality — gray zone WITH an injected scorer', () => {
  // A gray-zone page that the legacy rule would call `low`
  // (wordCount 80 < 100). An injected scorer must be able to flip
  // ONLY this gray-zone outcome.
  const grayLowPage = signals({
    extractedWordCount: 80,
    contentToDomRatio: 0.1,
    boilerplateFraction: 0.6,
  });

  it('uses the injected scorer for the gray zone (low -> medium)', () => {
    const learnedMedium: GrayZoneScorer = () => 'medium';
    expect(classifyPageContentQuality(grayLowPage, learnedMedium)).toEqual({
      state: 'indexed',
      quality: 'medium',
    });
  });

  it('uses the injected scorer for the gray zone (medium -> low)', () => {
    const ruleSaysMedium = signals({
      extractedWordCount: 200,
      contentToDomRatio: 0.5,
      boilerplateFraction: 0.1,
    });
    // Sanity: default rule calls this medium.
    expect(classifyPageContentQuality(ruleSaysMedium)).toEqual({
      state: 'indexed',
      quality: 'medium',
    });
    const learnedLow: GrayZoneScorer = () => 'low';
    expect(classifyPageContentQuality(ruleSaysMedium, learnedLow)).toEqual({
      state: 'indexed_low_quality',
      quality: 'low',
    });
  });

  it('passes the raw signals through to the scorer', () => {
    const seen: PageContentQualitySignals[] = [];
    const recording: GrayZoneScorer = (s) => {
      seen.push(s);
      return 'low';
    };
    classifyPageContentQuality(grayLowPage, recording);
    expect(seen).toEqual([grayLowPage]);
  });
});
