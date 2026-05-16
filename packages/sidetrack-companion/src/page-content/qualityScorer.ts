import { Booster, loadLGB } from '@wlearn/lightgbm';

import type { PageContentExtractionStrategy, PageContentQualitySignals } from './types.js';

/**
 * Learned gray-zone page-quality scorer.
 *
 * The hard floor (must-reject) and the `high` tier (must-accept) stay
 * fully deterministic in {@link ./quality.ts}. This module covers only
 * the `medium`-vs-`low` gray zone: given the same extraction signals
 * that the rule classifier inspects, it returns a `medium | low`
 * decision.
 *
 * Default behavior is byte-identical to the existing rule: when no
 * trained model is injected, {@link ruleGrayZoneScorer} reproduces the
 * exact `classifyPageContentQuality` medium/low predicate, so zero
 * regression. A model is used only when explicitly loaded and passed
 * in — there is no runtime model-discovery side effect.
 *
 * Failure behavior: a non-finite model score falls back to the
 * deterministic rule rather than throwing, so a corrupt model cannot
 * break extraction. Training lives offline in
 * {@link ./qualityScorerTrain.ts} and never runs at request time.
 */

export type GrayZoneQuality = 'medium' | 'low';

export const QUALITY_SCORER_MODEL_VERSION = 'lightgbm-pagequality-grayzone-v1' as const;
export const QUALITY_SCORER_FEATURE_SCHEMA_VERSION = 1 as const;

/**
 * Ordered, stable feature keys for the gray-zone scorer. The order is
 * load-bearing: it defines both the training matrix column order and
 * the predict-time encoding. Append-only — never reorder or remove a
 * key without bumping {@link QUALITY_SCORER_FEATURE_SCHEMA_VERSION}.
 */
export const QUALITY_SCORER_FEATURE_KEYS = [
  'extracted_word_count',
  'content_to_dom_ratio',
  'boilerplate_fraction',
  'strategy_is_reader_mode',
  'strategy_is_manual_selection',
  'strategy_is_visible_dom',
] as const;

export type QualityScorerFeatureKey = (typeof QUALITY_SCORER_FEATURE_KEYS)[number];

export type QualityScorerFeatures = Readonly<Record<QualityScorerFeatureKey, number>>;

export interface QualityScorerModel {
  readonly modelVersion: typeof QUALITY_SCORER_MODEL_VERSION;
  readonly featureSchemaVersion: typeof QUALITY_SCORER_FEATURE_SCHEMA_VERSION;
  readonly booster: Booster;
  readonly dispose: () => void;
}

/**
 * Persisted, serializable model revision. Mirrors the ranker's
 * `RankerRevision` shape so existing revision-store plumbing patterns
 * apply if this is ever wired into the vault.
 *
 * `featureSchemaVersion` is intentionally `number`, not the literal:
 * a revision deserialized from disk is a trust boundary and may carry
 * any version, so {@link loadQualityScorerModel} must validate it
 * rather than assume the compile-time literal.
 */
export interface QualityScorerRevision {
  readonly revisionId: string;
  readonly modelVersion: typeof QUALITY_SCORER_MODEL_VERSION;
  readonly featureSchemaVersion: number;
  readonly trainingDatasetHash: string;
  readonly trainedAt: number;
  readonly modelBytes: ArrayBuffer;
}

/**
 * Decision boundary for the LightGBM binary objective: a model score
 * at or above this probability classifies the page as `medium`,
 * otherwise `low`. 0.5 is the natural threshold for `binary`.
 */
export const QUALITY_SCORER_MEDIUM_THRESHOLD = 0.5;

const strategyFlag = (
  strategy: PageContentExtractionStrategy,
  match: PageContentExtractionStrategy,
): number => (strategy === match ? 1 : 0);

/**
 * Deterministic projection of extraction signals into the scorer
 * feature space. Pure and total — used by both training and predict so
 * the offline and online encodings cannot drift.
 */
export const qualityScorerFeatures = (
  signals: PageContentQualitySignals,
): QualityScorerFeatures => ({
  extracted_word_count: Number.isFinite(signals.extractedWordCount)
    ? signals.extractedWordCount
    : 0,
  content_to_dom_ratio: Number.isFinite(signals.contentToDomRatio) ? signals.contentToDomRatio : 0,
  boilerplate_fraction: Number.isFinite(signals.boilerplateFraction)
    ? signals.boilerplateFraction
    : 0,
  strategy_is_reader_mode: strategyFlag(signals.extractionStrategy, 'reader-mode'),
  strategy_is_manual_selection: strategyFlag(signals.extractionStrategy, 'manual-selection'),
  strategy_is_visible_dom: strategyFlag(signals.extractionStrategy, 'visible-dom'),
});

export const encodeQualityScorerFeatureMatrix = (
  rows: readonly QualityScorerFeatures[],
): Float32Array => {
  const matrix = new Float32Array(rows.length * QUALITY_SCORER_FEATURE_KEYS.length);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row === undefined) throw new Error('quality scorer feature row is missing');
    for (let columnIndex = 0; columnIndex < QUALITY_SCORER_FEATURE_KEYS.length; columnIndex += 1) {
      const key = QUALITY_SCORER_FEATURE_KEYS[columnIndex];
      if (key === undefined) throw new Error('quality scorer feature key is missing');
      matrix[rowIndex * QUALITY_SCORER_FEATURE_KEYS.length + columnIndex] = row[key];
    }
  }
  return matrix;
};

/**
 * A gray-zone scorer maps extraction signals to a `medium | low`
 * decision. Pure and synchronous so the hot path stays cheap.
 */
export type GrayZoneScorer = (signals: PageContentQualitySignals) => GrayZoneQuality;

/**
 * The deterministic default. Reproduces the EXACT medium/low predicate
 * from `classifyPageContentQuality` so that, with no model present,
 * the overall classifier is byte-identical to the pre-existing rule.
 *
 * Keep this in lock-step with the `medium` predicate in
 * {@link ./quality.ts}.
 */
export const ruleGrayZoneScorer: GrayZoneScorer = (signals) =>
  signals.extractedWordCount >= 100 &&
  (signals.contentToDomRatio >= 0.2 || signals.boilerplateFraction <= 0.35)
    ? 'medium'
    : 'low';

const LIGHTGBM_PREDICT_NORMAL = 0;

const arrayBufferToBytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer);

/**
 * Loads a trained gray-zone model. This is the ONLY place a model is
 * materialized; nothing calls it implicitly, so default runtime
 * behavior never touches LightGBM.
 */
export const loadQualityScorerModel = async (
  revision: QualityScorerRevision,
): Promise<QualityScorerModel> => {
  if (revision.featureSchemaVersion !== QUALITY_SCORER_FEATURE_SCHEMA_VERSION) {
    throw new Error(
      `quality scorer model feature schema ${String(
        revision.featureSchemaVersion,
      )} does not match runtime schema ${String(QUALITY_SCORER_FEATURE_SCHEMA_VERSION)}`,
    );
  }
  await loadLGB();
  const booster = Booster.loadModel(arrayBufferToBytes(revision.modelBytes));
  return {
    modelVersion: revision.modelVersion,
    // Validated equal above; narrow back to the runtime literal.
    featureSchemaVersion: QUALITY_SCORER_FEATURE_SCHEMA_VERSION,
    booster,
    dispose: () => {
      booster.dispose();
    },
  };
};

/**
 * Scores raw signals with the model and returns `medium | low`. A
 * non-finite score is treated as model unavailability and falls back
 * to {@link ruleGrayZoneScorer} — a corrupt model degrades to the
 * deterministic rule instead of breaking extraction.
 */
export const predictGrayZoneQuality = (
  signals: PageContentQualitySignals,
  model: QualityScorerModel,
): GrayZoneQuality => {
  const matrix = encodeQualityScorerFeatureMatrix([qualityScorerFeatures(signals)]);
  const score = model.booster.predict(matrix, 1, QUALITY_SCORER_FEATURE_KEYS.length, {
    predictType: LIGHTGBM_PREDICT_NORMAL,
  })[0];
  if (score === undefined || !Number.isFinite(score)) {
    return ruleGrayZoneScorer(signals);
  }
  return score >= QUALITY_SCORER_MEDIUM_THRESHOLD ? 'medium' : 'low';
};

/**
 * Builds a {@link GrayZoneScorer} from an optional model. Model
 * availability is the gate: with `undefined` (the default), the
 * returned scorer IS {@link ruleGrayZoneScorer}, guaranteeing the
 * classifier's default output is unchanged.
 */
export const grayZoneScorerFor = (model?: QualityScorerModel): GrayZoneScorer => {
  if (model === undefined) return ruleGrayZoneScorer;
  return (signals) => predictGrayZoneQuality(signals, model);
};
