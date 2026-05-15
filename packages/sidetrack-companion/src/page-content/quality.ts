import { ruleGrayZoneScorer, type GrayZoneScorer } from './qualityScorer.js';
import type {
  PageContentCoverageState,
  PageContentQuality,
  PageContentQualitySignals,
} from './types.js';

/**
 * Classifies extracted page content.
 *
 * Tiers, in order:
 *  1. HARD FLOOR — deterministic must-reject (`metadata_only_error`).
 *  2. HIGH — deterministic must-accept.
 *  3. GRAY ZONE — `medium` vs `low`, delegated to `grayZoneScorer`.
 *
 * The hard floor and the high tier are intentionally NOT learnable:
 * they are safety/quality invariants and stay byte-stable.
 *
 * `grayZoneScorer` defaults to {@link ruleGrayZoneScorer}, which
 * reproduces the original medium/low predicate exactly, so the default
 * (no-model) classification is byte-identical to the prior behavior.
 * A learned model is used only when the caller explicitly passes a
 * scorer built from a loaded model (see `grayZoneScorerFor`).
 */
export const classifyPageContentQuality = (
  signals: PageContentQualitySignals,
  grayZoneScorer: GrayZoneScorer = ruleGrayZoneScorer,
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

  if (grayZoneScorer(signals) === 'medium') {
    return { state: 'indexed', quality: 'medium' };
  }

  return { state: 'indexed_low_quality', quality: 'low' };
};
