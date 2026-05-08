import { Booster, loadLGB } from '@wlearn/lightgbm';

import type { CandidatePairFeatures, FEATURE_SCHEMA_VERSION } from './feature-schema.js';
import {
  encodeRankerFeatureMatrix,
  RANKER_FEATURE_KEYS,
  RANKER_MODEL_FEATURE_COUNT,
  type RankerRevision,
  type RANKER_MODEL_VERSION,
} from './train.js';

export interface LightGBMModel {
  readonly revisionId: string;
  readonly modelVersion: typeof RANKER_MODEL_VERSION;
  readonly featureSchemaVersion: typeof FEATURE_SCHEMA_VERSION;
  readonly booster: Booster;
  readonly dispose: () => void;
}

export type RankerContributions = Record<keyof CandidatePairFeatures, number>;

export type RankerPredict = (
  features: CandidatePairFeatures,
  model: LightGBMModel,
) => { readonly score: number; readonly contributions: RankerContributions };

const LIGHTGBM_PREDICT_NORMAL = 0;
const LIGHTGBM_PREDICT_CONTRIB = 3;

const arrayBufferToBytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer);

export const loadRankerModel = async (revision: RankerRevision): Promise<LightGBMModel> => {
  await loadLGB();
  const booster = Booster.loadModel(arrayBufferToBytes(revision.modelBytes));
  return {
    revisionId: revision.revisionId,
    modelVersion: revision.modelVersion,
    featureSchemaVersion: revision.featureSchemaVersion,
    booster,
    dispose: () => {
      booster.dispose();
    },
  };
};

const scoreFeatureMatrix = (
  model: LightGBMModel,
  matrix: Float32Array,
  rowCount: number,
  predictType: number,
): Float64Array =>
  model.booster.predict(matrix, rowCount, RANKER_FEATURE_KEYS.length, { predictType });

const emptyContributions = (): RankerContributions => ({
  schemaVersion: 0,
  same_workstream: 0,
  opener_chain_depth: 0,
  in_navigation_chain: 0,
  same_canonical_url: 0,
  same_host: 0,
  same_repo: 0,
  same_search_query: 0,
  same_copied_snippet_count: 0,
  shared_title_tokens: 0,
  shared_path_tokens: 0,
  cosine_similarity: 0,
  recency_score_from: 0,
  recency_score_to: 0,
  engagement_class_match: 0,
  return_count_from: 0,
  return_count_to: 0,
  user_asserted_in_thread: 0,
  user_asserted_in_workstream: 0,
});

const contributionsFor = (rawContributions: Float64Array): RankerContributions => {
  if (rawContributions.length !== RANKER_MODEL_FEATURE_COUNT) {
    throw new Error(
      `LightGBM returned ${String(rawContributions.length)} contributions for ${String(
        RANKER_FEATURE_KEYS.length,
      )} features`,
    );
  }
  const contributions = emptyContributions();
  for (let index = 0; index < RANKER_FEATURE_KEYS.length; index += 1) {
    const key = RANKER_FEATURE_KEYS[index];
    if (key === undefined) throw new Error('ranker feature key is missing');
    contributions[key] = rawContributions[index] ?? 0;
  }
  // LightGBM pred_contrib returns feature contributions plus a final bias
  // slot. The public S20 contract is keyed by CandidatePairFeatures only, so
  // the schemaVersion slot carries the bias rather than a model input feature.
  contributions.schemaVersion = rawContributions[RANKER_FEATURE_KEYS.length] ?? 0;
  return contributions;
};

export const predictRanker: RankerPredict = (features, model) => {
  const matrix = encodeRankerFeatureMatrix([features]);
  const score = scoreFeatureMatrix(model, matrix, 1, LIGHTGBM_PREDICT_NORMAL)[0];
  const rawContributions = scoreFeatureMatrix(model, matrix, 1, LIGHTGBM_PREDICT_CONTRIB);
  if (score === undefined || !Number.isFinite(score)) {
    throw new Error('LightGBM returned a non-finite ranker score');
  }
  return {
    score,
    contributions: contributionsFor(rawContributions),
  };
};

export const topRankerContributions = (
  contributions: RankerContributions,
  limit: number,
): readonly { readonly feature: keyof CandidatePairFeatures; readonly weight: number }[] =>
  (Object.entries(contributions) as readonly [keyof CandidatePairFeatures, number][])
    .filter(([feature, weight]) => feature !== 'schemaVersion' && weight !== 0)
    .sort(
      (left, right) => Math.abs(right[1]) - Math.abs(left[1]) || left[0].localeCompare(right[0]),
    )
    .slice(0, Math.max(0, Math.floor(limit)))
    .map(([feature, weight]) => ({ feature, weight }));
