import { createHash } from 'node:crypto';

import { Booster, Dataset, loadLGB } from '@wlearn/lightgbm';

import {
  encodeQualityScorerFeatureMatrix,
  QUALITY_SCORER_FEATURE_KEYS,
  QUALITY_SCORER_FEATURE_SCHEMA_VERSION,
  QUALITY_SCORER_MODEL_VERSION,
  qualityScorerFeatures,
  type GrayZoneQuality,
  type QualityScorerRevision,
} from './qualityScorer.js';
import type { PageContentQualitySignals } from './types.js';

/**
 * Offline training entry for the gray-zone page-quality scorer.
 *
 * Mirrors the ranker's LightGBM pattern (`@wlearn/lightgbm`,
 * `Dataset` -> `Booster` -> `saveModel`, deterministic params, dataset
 * hash -> revision id). This is NOT invoked at runtime: page-content
 * classification never imports this module, and no model needs to
 * exist for the companion to run.
 *
 * Labels are caller-supplied gray-zone outcomes (`medium | low`) for
 * pages that already passed the hard floor and missed the high tier.
 */

export const DEFAULT_QUALITY_SCORER_NUM_ROUND = 60;
export const DEFAULT_QUALITY_SCORER_SEED = 20260515;

export interface QualityScorerLabeledExample {
  readonly signals: PageContentQualitySignals;
  readonly label: GrayZoneQuality;
}

export interface TrainQualityScorerOptions {
  readonly seed?: number;
  readonly numRound?: number;
  readonly trainedAt?: number;
}

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

const toOwnedArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const labelValue = (label: GrayZoneQuality): number => (label === 'medium' ? 1 : 0);

const lightGbmParamString = (
  options: Required<Pick<TrainQualityScorerOptions, 'seed' | 'numRound'>>,
): string =>
  [
    'objective=binary',
    'metric=binary_logloss',
    'verbosity=-1',
    `seed=${String(options.seed)}`,
    'deterministic=true',
    'num_threads=1',
    'force_row_wise=true',
    'min_data_in_leaf=1',
    'min_data_in_bin=1',
    'num_leaves=7',
    'learning_rate=0.1',
  ].join(' ');

const stableDatasetBody = (
  examples: readonly QualityScorerLabeledExample[],
  trainingConfig: Required<Pick<TrainQualityScorerOptions, 'seed' | 'numRound'>>,
): string =>
  JSON.stringify({
    featureSchemaVersion: QUALITY_SCORER_FEATURE_SCHEMA_VERSION,
    modelVersion: QUALITY_SCORER_MODEL_VERSION,
    trainingConfig,
    rows: examples.map((example) => ({
      label: labelValue(example.label),
      features: qualityScorerFeatures(example.signals),
    })),
  });

export const createQualityScorerRevisionId = (trainingDatasetHash: string): string =>
  sha256Hex(
    [
      QUALITY_SCORER_MODEL_VERSION,
      String(QUALITY_SCORER_FEATURE_SCHEMA_VERSION),
      trainingDatasetHash,
    ].join('\n'),
  ).slice(0, 16);

/**
 * Trains a gray-zone scorer revision from labeled examples. Requires
 * at least one `medium` and one `low` example so the binary objective
 * has signal on both sides.
 */
export const trainQualityScorerRevision = async (
  examples: readonly QualityScorerLabeledExample[],
  options: TrainQualityScorerOptions = {},
): Promise<QualityScorerRevision> => {
  const labels = new Set(examples.map((example) => example.label));
  if (examples.length < 2 || !labels.has('medium') || !labels.has('low')) {
    throw new Error(
      'quality scorer training requires at least one medium and one low labeled example',
    );
  }

  const seed = options.seed ?? DEFAULT_QUALITY_SCORER_SEED;
  const numRound = options.numRound ?? DEFAULT_QUALITY_SCORER_NUM_ROUND;
  const trainingConfig = { seed, numRound };
  const trainingDatasetHash = sha256Hex(stableDatasetBody(examples, trainingConfig));
  const revisionId = createQualityScorerRevisionId(trainingDatasetHash);
  const params = lightGbmParamString(trainingConfig);

  const matrix = encodeQualityScorerFeatureMatrix(
    examples.map((example) => qualityScorerFeatures(example.signals)),
  );
  await loadLGB();
  const dataset = new Dataset(matrix, examples.length, QUALITY_SCORER_FEATURE_KEYS.length, params);

  try {
    dataset.setLabel(new Float32Array(examples.map((example) => labelValue(example.label))));
    const booster = new Booster(dataset.handle, params);
    try {
      for (let iteration = 0; iteration < numRound; iteration += 1) {
        booster.update();
      }
      return {
        revisionId,
        modelVersion: QUALITY_SCORER_MODEL_VERSION,
        featureSchemaVersion: QUALITY_SCORER_FEATURE_SCHEMA_VERSION,
        trainingDatasetHash,
        trainedAt: options.trainedAt ?? 0,
        modelBytes: toOwnedArrayBuffer(booster.saveModel()),
      };
    } finally {
      booster.dispose();
    }
  } finally {
    dataset.dispose();
  }
};
