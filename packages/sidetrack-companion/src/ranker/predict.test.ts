import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { FeedbackProjection, FeedbackTrainingLabel } from '../feedback/projection.js';
import {
  listClosestVisitRankerRevisionIds,
  readClosestVisitRankerRevision,
  readClosestVisitRankerRevisionManifest,
  writeActiveClosestVisitRankerRevision,
} from '../producers/closest-visit-revision.js';
import { FEATURE_SCHEMA_VERSION, type CandidatePairFeatures } from './feature-schema.js';
import { loadRankerModel, predictRanker, topRankerContributions } from './predict.js';
import {
  buildRankerTrainingRows,
  createRankerRevisionId,
  RANKER_MODEL_VERSION,
  trainRankerRevision,
  type RankerTrainingCandidate,
} from './train.js';

const generatedAt = Date.parse('2026-05-08T12:00:00.000Z');
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const featuresFor = (score: number, sameWorkstream: 0 | 1): CandidatePairFeatures => ({
  schemaVersion: FEATURE_SCHEMA_VERSION,
  same_workstream: sameWorkstream,
  opener_chain_depth: sameWorkstream,
  in_navigation_chain: sameWorkstream,
  same_canonical_url: 0,
  same_host: sameWorkstream,
  same_repo: 0,
  same_search_query: 0,
  same_copied_snippet_count: sameWorkstream,
  shared_title_tokens: Math.round(score * 4),
  shared_path_tokens: Math.round(score * 3),
  cosine_similarity: score,
  recency_score_from: 0.9,
  recency_score_to: 0.4 + score * 0.4,
  engagement_class_match: sameWorkstream,
  return_count_from: 2,
  return_count_to: sameWorkstream === 1 ? 3 : 0,
  user_asserted_in_thread: 0,
  user_asserted_in_workstream: sameWorkstream,
});

const syntheticTrainingSet = (): {
  readonly feedback: FeedbackProjection;
  readonly candidates: readonly RankerTrainingCandidate[];
} => {
  const positiveLabels: FeedbackTrainingLabel[] = [];
  const negativeLabels: FeedbackTrainingLabel[] = [];
  const candidates: RankerTrainingCandidate[] = [];

  for (let query = 0; query < 10; query += 1) {
    const fromVisitId = `visit-${String(query)}`;
    for (let item = 0; item < 10; item += 1) {
      const toVisitId = `visit-${String(query)}-${String(item)}`;
      const positive = item >= 7;
      if (positive) {
        positiveLabels.push({ fromId: fromVisitId, toId: toVisitId, weight: 2 });
      } else {
        negativeLabels.push({ fromId: fromVisitId, toId: toVisitId, weight: 1 });
      }
      candidates.push({
        candidate: {
          fromVisitId,
          toVisitId,
          generatedAt: generatedAt + query,
          sources: positive ? ['same_workstream'] : ['random_unrelated'],
        },
        features: featuresFor(positive ? 0.78 + item / 100 : item / 100, positive ? 1 : 0),
      });
    }
  }

  return {
    feedback: {
      schemaVersion: 1,
      perItem: {},
      containerByItem: {},
      organizedItemsByContainer: {},
      positiveLabels,
      negativeLabels,
    },
    candidates,
  };
};

describe('LightGBM LambdaMART ranker', () => {
  it('scores a held-out related pair above an unrelated pair after synthetic training', async () => {
    const input = syntheticTrainingSet();
    const revision = await trainRankerRevision({
      ...input,
      options: { seed: 17, numRound: 24, trainedAt: generatedAt },
    });
    const model = await loadRankerModel(revision);

    try {
      const related = predictRanker(featuresFor(0.95, 1), model);
      const unrelated = predictRanker(featuresFor(0.05, 0), model);

      expect(related.score).toBeGreaterThan(unrelated.score);
      expect(related.score - unrelated.score).toBeGreaterThan(0.05);
    } finally {
      model.dispose();
    }
  });

  it('uses a deterministic revision id derived from model version, schema, and dataset hash', async () => {
    const input = syntheticTrainingSet();
    const first = await trainRankerRevision({
      ...input,
      options: { seed: 23, numRound: 12, trainedAt: generatedAt },
    });
    const second = await trainRankerRevision({
      feedback: input.feedback,
      candidates: [...input.candidates].reverse(),
      options: { seed: 23, numRound: 12, trainedAt: generatedAt },
    });

    expect(first.trainingDatasetHash).toBe(second.trainingDatasetHash);
    expect(first.revisionId).toBe(second.revisionId);
    expect(first.revisionId).toBe(createRankerRevisionId(first.trainingDatasetHash));
    expect(first.modelVersion).toBe(RANKER_MODEL_VERSION);
  });

  it('returns native LightGBM contribution values whose sum matches the score', async () => {
    const input = syntheticTrainingSet();
    const revision = await trainRankerRevision({
      ...input,
      options: { seed: 31, numRound: 18, trainedAt: generatedAt },
    });
    const model = await loadRankerModel(revision);

    try {
      const prediction = predictRanker(featuresFor(0.91, 1), model);
      const sum = Object.values(prediction.contributions).reduce(
        (total, value) => total + value,
        0,
      );

      expect(sum).toBeCloseTo(prediction.score, 6);
      const top = topRankerContributions(prediction.contributions, 3);
      expect(top.length).toBeGreaterThan(0);
      expect(top.length).toBeLessThanOrEqual(3);
    } finally {
      model.dispose();
    }
  });

  it('stores closest-visit revisions as listable manifests plus base64 model bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidetrack-ranker-'));
    tempRoots.push(root);
    const input = syntheticTrainingSet();
    const revision = await trainRankerRevision({
      ...input,
      options: { seed: 37, numRound: 8, trainedAt: generatedAt },
    });

    await writeActiveClosestVisitRankerRevision(root, revision);

    await expect(listClosestVisitRankerRevisionIds(root)).resolves.toEqual([revision.revisionId]);
    const manifest = await readClosestVisitRankerRevisionManifest(root, revision.revisionId);
    expect(manifest?.revisionId).toBe(revision.revisionId);
    expect(manifest?.modelByteLength).toBe(revision.modelBytes.byteLength);
    await expect(readClosestVisitRankerRevision(root, revision.revisionId)).resolves.toMatchObject({
      revisionId: revision.revisionId,
      trainingDatasetHash: revision.trainingDatasetHash,
    });
  });

  it('builds supervised rows from feedback labels and negative candidate sources', () => {
    const input = syntheticTrainingSet();

    expect(buildRankerTrainingRows(input.feedback, input.candidates)).toHaveLength(100);
  });
});
