import type { Booster } from '@wlearn/lightgbm';
import { describe, expect, it } from 'vitest';

import {
  encodeQualityScorerFeatureMatrix,
  grayZoneScorerFor,
  loadQualityScorerModel,
  predictGrayZoneQuality,
  QUALITY_SCORER_FEATURE_KEYS,
  QUALITY_SCORER_FEATURE_SCHEMA_VERSION,
  QUALITY_SCORER_MODEL_VERSION,
  qualityScorerFeatures,
  ruleGrayZoneScorer,
  type QualityScorerModel,
  type QualityScorerRevision,
} from './qualityScorer.js';
import {
  trainQualityScorerRevision,
  type QualityScorerLabeledExample,
} from './qualityScorerTrain.js';
import type { PageContentQualitySignals } from './types.js';

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
 * A fake booster whose `predict` returns a caller-controlled score.
 * Only `predict` is exercised by the scorer; the other Booster members
 * are never touched, so a focused stub is sufficient and honest.
 */
const fakeModel = (scoreFor: (matrix: Float32Array) => number): QualityScorerModel => {
  const booster = {
    predict: (data: Float32Array) => Float64Array.of(scoreFor(data)),
  } as unknown as Booster;
  let disposed = false;
  return {
    modelVersion: QUALITY_SCORER_MODEL_VERSION,
    featureSchemaVersion: QUALITY_SCORER_FEATURE_SCHEMA_VERSION,
    booster,
    dispose: () => {
      disposed = true;
      void disposed;
    },
  };
};

describe('qualityScorerFeatures', () => {
  it('projects signals deterministically with one-hot strategy flags', () => {
    expect(
      qualityScorerFeatures(
        signals({
          extractedWordCount: 120,
          contentToDomRatio: 0.3,
          boilerplateFraction: 0.4,
          extractionStrategy: 'reader-mode',
        }),
      ),
    ).toEqual({
      extracted_word_count: 120,
      content_to_dom_ratio: 0.3,
      boilerplate_fraction: 0.4,
      strategy_is_reader_mode: 1,
      strategy_is_manual_selection: 0,
      strategy_is_visible_dom: 0,
    });
  });

  it('coerces non-finite numeric signals to 0', () => {
    expect(
      qualityScorerFeatures(
        signals({
          extractedWordCount: Number.NaN,
          contentToDomRatio: Number.POSITIVE_INFINITY,
          boilerplateFraction: Number.NaN,
          extractionStrategy: 'manual-selection',
        }),
      ),
    ).toEqual({
      extracted_word_count: 0,
      content_to_dom_ratio: 0,
      boilerplate_fraction: 0,
      strategy_is_reader_mode: 0,
      strategy_is_manual_selection: 1,
      strategy_is_visible_dom: 0,
    });
  });
});

describe('encodeQualityScorerFeatureMatrix', () => {
  it('lays features out in declared key order, row-major', () => {
    const matrix = encodeQualityScorerFeatureMatrix([
      qualityScorerFeatures(
        signals({
          extractedWordCount: 100,
          contentToDomRatio: 0.2,
          boilerplateFraction: 0.3,
          extractionStrategy: 'visible-dom',
        }),
      ),
    ]);
    expect(matrix.length).toBe(QUALITY_SCORER_FEATURE_KEYS.length);
    // Float32 storage loses decimal precision; assert close, not exact.
    const expected = [100, 0.2, 0.3, 0, 0, 1];
    expected.forEach((value, index) => {
      expect(matrix[index]).toBeCloseTo(value, 5);
    });
  });
});

describe('ruleGrayZoneScorer (deterministic default)', () => {
  it('reproduces the legacy medium/low predicate exactly', () => {
    const legacyMedium = (s: PageContentQualitySignals): boolean =>
      s.extractedWordCount >= 100 && (s.contentToDomRatio >= 0.2 || s.boilerplateFraction <= 0.35);

    for (const wordCount of [0, 99, 100, 300]) {
      for (const ratio of [0, 0.19, 0.2, 0.5]) {
        for (const boilerplate of [0, 0.35, 0.36, 0.9]) {
          const s = signals({
            extractedWordCount: wordCount,
            contentToDomRatio: ratio,
            boilerplateFraction: boilerplate,
          });
          expect(ruleGrayZoneScorer(s)).toBe(legacyMedium(s) ? 'medium' : 'low');
        }
      }
    }
  });
});

describe('grayZoneScorerFor — model availability gate', () => {
  it('returns the deterministic rule when no model is provided', () => {
    expect(grayZoneScorerFor()).toBe(ruleGrayZoneScorer);
    expect(grayZoneScorerFor(undefined)).toBe(ruleGrayZoneScorer);
  });

  it('returns a model-backed scorer when a model is provided', () => {
    const scorer = grayZoneScorerFor(fakeModel(() => 0.99));
    expect(scorer).not.toBe(ruleGrayZoneScorer);
    expect(
      scorer(signals({ extractedWordCount: 10, contentToDomRatio: 0, boilerplateFraction: 1 })),
    ).toBe('medium');
  });
});

describe('predictGrayZoneQuality', () => {
  const grayPage = signals({
    extractedWordCount: 90,
    contentToDomRatio: 0.1,
    boilerplateFraction: 0.6,
  });

  it('classifies as medium at or above the decision threshold', () => {
    expect(
      predictGrayZoneQuality(
        grayPage,
        fakeModel(() => 0.5),
      ),
    ).toBe('medium');
    expect(
      predictGrayZoneQuality(
        grayPage,
        fakeModel(() => 0.91),
      ),
    ).toBe('medium');
  });

  it('classifies as low below the decision threshold', () => {
    expect(
      predictGrayZoneQuality(
        grayPage,
        fakeModel(() => 0.49),
      ),
    ).toBe('low');
  });

  it('feeds the encoded feature matrix to the booster', () => {
    let seen: Float32Array | undefined;
    predictGrayZoneQuality(
      grayPage,
      fakeModel((matrix) => {
        seen = matrix;
        return 1;
      }),
    );
    expect(seen).toBeInstanceOf(Float32Array);
    const matrix = seen ?? new Float32Array();
    [90, 0.1, 0.6, 0, 0, 1].forEach((value, index) => {
      expect(matrix[index]).toBeCloseTo(value, 5);
    });
  });

  it('falls back to the deterministic rule on a non-finite model score', () => {
    // grayPage is `low` under the rule (wordCount 90 < 100).
    expect(
      predictGrayZoneQuality(
        grayPage,
        fakeModel(() => Number.NaN),
      ),
    ).toBe('low');
    const ruleMediumPage = signals({
      extractedWordCount: 200,
      contentToDomRatio: 0.5,
      boilerplateFraction: 0.1,
    });
    expect(
      predictGrayZoneQuality(
        ruleMediumPage,
        fakeModel(() => Number.POSITIVE_INFINITY),
      ),
    ).toBe('medium');
  });
});

describe('trainQualityScorerRevision (offline LightGBM entry)', () => {
  const example = (
    label: 'medium' | 'low',
    wordCount: number,
    ratio: number,
    boilerplate: number,
  ): QualityScorerLabeledExample => ({
    label,
    signals: signals({
      extractedWordCount: wordCount,
      contentToDomRatio: ratio,
      boilerplateFraction: boilerplate,
    }),
  });

  const trainingSet = (): readonly QualityScorerLabeledExample[] => {
    const rows: QualityScorerLabeledExample[] = [];
    for (let i = 0; i < 24; i += 1) {
      rows.push(example('medium', 200 + i, 0.45 + i / 400, 0.1));
      rows.push(example('low', 40 + i, 0.06 + i / 800, 0.7));
    }
    return rows;
  };

  it('rejects training without both medium and low labels', async () => {
    await expect(trainQualityScorerRevision([example('medium', 200, 0.5, 0.1)])).rejects.toThrow(
      /at least one medium and one low/,
    );
  });

  it('produces a deterministic revision id for identical inputs', async () => {
    const rows = trainingSet();
    const first = await trainQualityScorerRevision(rows, { seed: 7, numRound: 16 });
    const second = await trainQualityScorerRevision(rows, { seed: 7, numRound: 16 });
    expect(first.trainingDatasetHash).toBe(second.trainingDatasetHash);
    expect(first.revisionId).toBe(second.revisionId);
    expect(first.modelVersion).toBe(QUALITY_SCORER_MODEL_VERSION);
    expect(first.featureSchemaVersion).toBe(QUALITY_SCORER_FEATURE_SCHEMA_VERSION);
  });

  it('trains a model that separates clear medium from clear low after load', async () => {
    const revision = await trainQualityScorerRevision(trainingSet(), {
      seed: 11,
      numRound: 40,
    });
    const model = await loadQualityScorerModel(revision);
    try {
      const clearMedium = signals({
        extractedWordCount: 240,
        contentToDomRatio: 0.55,
        boilerplateFraction: 0.1,
      });
      const clearLow = signals({
        extractedWordCount: 45,
        contentToDomRatio: 0.06,
        boilerplateFraction: 0.7,
      });
      expect(predictGrayZoneQuality(clearMedium, model)).toBe('medium');
      expect(predictGrayZoneQuality(clearLow, model)).toBe('low');
    } finally {
      model.dispose();
    }
  });

  it('rejects loading a model whose feature schema does not match', async () => {
    const revision = await trainQualityScorerRevision(trainingSet(), {
      seed: 13,
      numRound: 8,
    });
    const mismatched: QualityScorerRevision = {
      ...revision,
      featureSchemaVersion: QUALITY_SCORER_FEATURE_SCHEMA_VERSION + 1,
    };
    await expect(loadQualityScorerModel(mismatched)).rejects.toThrow(
      /feature schema .* does not match/,
    );
  });
});
