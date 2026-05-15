import type {
  PageContentCoverageState,
  PageContentQuality,
  PageContentQualitySignals,
} from './types.js';

export const classifyPageContentQuality = (
  signals: PageContentQualitySignals,
): {
  readonly state: Extract<
    PageContentCoverageState,
    'indexed' | 'indexed_low_quality' | 'metadata_only_error'
  >;
  readonly quality?: PageContentQuality;
  readonly error?: string;
} => {
  if (
    signals.extractedWordCount < 30 ||
    signals.contentToDomRatio < 0.05 ||
    signals.boilerplateFraction > 0.8
  ) {
    return {
      state: 'metadata_only_error',
      error: 'extraction_quality_below_floor',
    };
  }

  if (
    signals.extractedWordCount >= 300 &&
    signals.contentToDomRatio >= 0.4 &&
    (signals.extractionStrategy === 'reader-mode' ||
      signals.extractionStrategy === 'manual-selection')
  ) {
    return { state: 'indexed', quality: 'high' };
  }

  if (
    signals.extractedWordCount >= 100 &&
    (signals.contentToDomRatio >= 0.2 || signals.boilerplateFraction <= 0.35)
  ) {
    return { state: 'indexed', quality: 'medium' };
  }

  return { state: 'indexed_low_quality', quality: 'low' };
};
