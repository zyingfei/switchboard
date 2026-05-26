import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { FeedbackProjection, FeedbackTrainingLabel } from '../feedback/projection.js';
import {
  activeClosestVisitRevisionManifestPath,
  closestVisitRevisionDir,
  closestVisitRevisionManifestPath,
  closestVisitRevisionModelPath,
  listClosestVisitRankerRevisionIds,
  readActiveClosestVisitRankerRevisionManifest,
  readClosestVisitRankerRevision,
  readClosestVisitRankerRevisionManifest,
  writeActiveClosestVisitRankerRevision,
} from '../producers/closest-visit-revision.js';
import { FEATURE_SCHEMA_VERSION, type CandidatePairFeatures } from './feature-schema.js';
import {
  loadActiveRanker,
  loadRankerModel,
  predictActive,
  predictRanker,
  topRankerContributions,
} from './predict.js';
import {
  buildRankerTrainingRows,
  createRankerRevisionId,
  RANKER_MODEL_VERSION,
  trainRankerRevision,
  type RankerRevision,
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
  same_active_topic: sameWorkstream,
  topic_lineage_merge_split_related: sameWorkstream,
  page_quality_tier_from: sameWorkstream === 1 ? 3 : 1,
  page_quality_tier_to: sameWorkstream === 1 ? 3 : 1,
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
          sources: positive ? ['user_confirmed'] : ['random_unrelated'],
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

const withPassingShipGate = (revision: RankerRevision): RankerRevision => {
  const trainQuality = revision.trainQuality;
  const methodologySpine = trainQuality?.methodologySpine;
  if (trainQuality === undefined || methodologySpine === undefined) {
    throw new Error('expected trained revision to include methodology spine diagnostics');
  }
  return {
    ...revision,
    trainQuality: {
      ...trainQuality,
      methodologySpine: {
        ...methodologySpine,
        shipGate: {
          ...methodologySpine.shipGate,
          status: 'pass',
          reason: 'active-model-cleared-validation-and-reserved-test',
        },
      },
    },
  };
};

const withFailingShipGate = (revision: RankerRevision): RankerRevision => {
  const trainQuality = revision.trainQuality;
  const methodologySpine = trainQuality?.methodologySpine;
  if (trainQuality === undefined || methodologySpine === undefined) {
    throw new Error('expected trained revision to include methodology spine diagnostics');
  }
  return {
    ...revision,
    trainQuality: {
      ...trainQuality,
      methodologySpine: {
        ...methodologySpine,
        shipGate: {
          ...methodologySpine.shipGate,
          status: 'fail',
          reason: 'reserved-test-below-floor',
        },
      },
    },
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
    const revision = withPassingShipGate(
      await trainRankerRevision({
        ...input,
        options: { seed: 37, numRound: 8, trainedAt: generatedAt },
      }),
    );

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

  it('keeps non-passing ship-gated revisions inspectable and loadable until serving gate lands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidetrack-ranker-shipgate-'));
    tempRoots.push(root);
    const input = syntheticTrainingSet();
    const revision = withFailingShipGate(
      await trainRankerRevision({
        ...input,
        options: { seed: 39, numRound: 8, trainedAt: generatedAt },
      }),
    );

    await writeActiveClosestVisitRankerRevision(root, revision);

    const manifest = await readClosestVisitRankerRevisionManifest(root, revision.revisionId);
    expect(manifest?.trainQuality?.methodologySpine?.shipGate.status).not.toBe('pass');
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

describe('ranker model version back-compat', () => {
  it('pins the bumped model + feature-schema versions for the expanded feature set', () => {
    expect(RANKER_MODEL_VERSION).toBe('lightgbm-lambdamart-v4');
    expect(FEATURE_SCHEMA_VERSION).toBe(4);
  });

  it('rejects a persisted model whose manifest predates the feature-set bump', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidetrack-ranker-backcompat-'));
    tempRoots.push(root);

    // Simulate a model trained under the *previous* feature count: a
    // valid-shaped manifest + base64 model body on disk, but stamped
    // with the old model/feature-schema versions. The byte body is
    // arbitrary — validation must reject on the version gate before
    // any LightGBM load is attempted, so a stale-width booster can
    // never be fed a wider feature row.
    const staleModelBytes = Buffer.from('stale-v1-lightgbm-model-bytes');
    const staleRevisionId = 'stale-v1-revision';
    const staleManifest = {
      revisionId: staleRevisionId,
      modelVersion: 'lightgbm-lambdamart-v1',
      featureSchemaVersion: 1,
      trainingDatasetHash: 'a'.repeat(64),
      trainedAt: generatedAt,
      modelByteLength: staleModelBytes.byteLength,
      modelSha256: createHash('sha256').update(staleModelBytes).digest('hex'),
    };
    await mkdir(closestVisitRevisionDir(root), { recursive: true });
    await writeFile(
      closestVisitRevisionManifestPath(root, staleRevisionId),
      `${JSON.stringify(staleManifest, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      closestVisitRevisionModelPath(root, staleRevisionId),
      `${staleModelBytes.toString('base64')}\n`,
      'utf8',
    );
    await writeFile(
      activeClosestVisitRevisionManifestPath(root),
      `${JSON.stringify(staleManifest, null, 2)}\n`,
      'utf8',
    );

    // Graceful fall back: the stale manifest fails the version gate,
    // so the readers return null instead of handing back a revision
    // that would crash prediction. Callers treat null as "no usable
    // model" and retrain.
    await expect(readClosestVisitRankerRevisionManifest(root, staleRevisionId)).resolves.toBeNull();
    await expect(readActiveClosestVisitRankerRevisionManifest(root)).resolves.toBeNull();
    await expect(readClosestVisitRankerRevision(root, staleRevisionId)).resolves.toBeNull();
  });

  it('round-trips and predicts a freshly trained v4 model after the bump', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidetrack-ranker-v4-'));
    tempRoots.push(root);
    const input = syntheticTrainingSet();
    const revision = withPassingShipGate(
      await trainRankerRevision({
        ...input,
        options: { seed: 41, numRound: 8, trainedAt: generatedAt },
      }),
    );
    expect(revision.modelVersion).toBe('lightgbm-lambdamart-v4');
    expect(revision.featureSchemaVersion).toBe(4);

    await writeActiveClosestVisitRankerRevision(root, revision);
    const reloaded = await readClosestVisitRankerRevision(root, revision.revisionId);
    expect(reloaded).not.toBeNull();
    if (reloaded === null) throw new Error('expected reloaded v4 revision');

    const model = await loadRankerModel(reloaded);
    try {
      const related = predictRanker(featuresFor(0.95, 1), model);
      const unrelated = predictRanker(featuresFor(0.05, 0), model);
      expect(Number.isFinite(related.score)).toBe(true);
      expect(related.score).toBeGreaterThan(unrelated.score);
    } finally {
      model.dispose();
    }
  });
});

describe('active-ranker dispatch (Step 4)', () => {
  // The selector+dispatch is the load-bearing change of the
  // incremental-ranker plan: even when the LightGBM ship-gate fails on
  // a fresh-retrained revision (the current dogfood state, observed:
  // active-model-does-not-beat-comparison-baseline), serving routes to
  // whichever peer artifact still passes its own gate.

  const lightgbmFailsLrPasses = (revision: RankerRevision): RankerRevision => {
    const artifactQuality = revision.artifactQuality;
    if (artifactQuality === undefined) {
      throw new Error('expected revision to carry per-artifact quality records');
    }
    // The synthetic training set scores a perfect baseline NDCG (real
    // vaults won't), so the fixture overrides both the baseline AND
    // LR reservedTest values to recreate the dogfood ordering
    // (baseline ~0.5, LR ~0.75, LightGBM fail).
    return {
      ...revision,
      artifactQuality: artifactQuality.map((artifact) => {
        if (artifact.kind === 'lightgbm_lambdamart') {
          return {
            ...artifact,
            shipGate: {
              status: 'fail',
              reason: 'artifact-does-not-beat-baseline',
            },
          };
        }
        if (artifact.kind === 'logistic_batch') {
          return {
            ...artifact,
            shipGate: {
              status: 'pass',
              reason: 'artifact-cleared-baseline-and-floor',
            },
            reservedTestMetric: {
              kind: 'reserved-test ndcg@5',
              value: 0.75,
            },
          };
        }
        if (artifact.kind === 'graph_baseline') {
          return {
            ...artifact,
            reservedTestMetric: {
              kind: 'deterministic baseline reserved-test ndcg@5',
              value: 0.5,
            },
          };
        }
        return artifact;
      }),
    };
  };

  it('routes scoring to the regularized LR when LightGBM fails its ship-gate', async () => {
    const input = syntheticTrainingSet();
    const trained = await trainRankerRevision({
      ...input,
      options: { seed: 17, numRound: 24, trainedAt: generatedAt },
    });
    // Sanity: Step 2 wrote artifactQuality + Step 3 wrote LR weights.
    expect(trained.artifactQuality?.map((a) => a.kind)).toContain('logistic_batch');
    expect(trained.logisticBatchWeights).toBeDefined();

    const handle = await loadActiveRanker(lightgbmFailsLrPasses(trained));
    try {
      expect(handle.selection.selectedKind).toBe('logistic_batch');
      expect(handle.lightgbm).toBeUndefined(); // LightGBM not loaded on LR path
      expect(handle.logisticBatchWeights).toBeDefined();

      // LR is a calibrated sigmoid in [0, 1]; scoring a clearly-related
      // pair should beat scoring an unrelated pair on the same handle.
      const related = predictActive(featuresFor(0.95, 1), handle);
      const unrelated = predictActive(featuresFor(0.05, 0), handle);
      expect(related.kind).toBe('logistic_batch');
      expect(related.score).toBeGreaterThanOrEqual(0);
      expect(related.score).toBeLessThanOrEqual(1);
      expect(related.score).toBeGreaterThan(unrelated.score);
    } finally {
      handle.dispose();
    }
  });

  it('falls back to graph_baseline when no learned artifact passes', async () => {
    const input = syntheticTrainingSet();
    const trained = await trainRankerRevision({
      ...input,
      options: { seed: 17, numRound: 24, trainedAt: generatedAt },
    });
    const allFail: RankerRevision = {
      ...trained,
      artifactQuality: (trained.artifactQuality ?? []).map((artifact) =>
        artifact.kind === 'graph_baseline'
          ? artifact // baseline can never `fail` by construction
          : {
              ...artifact,
              shipGate: {
                status: 'fail',
                reason: 'artifact-does-not-beat-baseline',
              },
            },
      ),
    };

    const handle = await loadActiveRanker(allFail);
    try {
      expect(handle.selection.selectedKind).toBe('graph_baseline');
      expect(handle.selection.reason).toBe('best_passing'); // baseline still cleared
      expect(handle.lightgbm).toBeUndefined();
      expect(handle.logisticBatchWeights).toBeUndefined();

      const score = predictActive(featuresFor(0.95, 1), handle);
      expect(score.kind).toBe('graph_baseline');
      expect(Number.isFinite(score.score)).toBe(true);
    } finally {
      handle.dispose();
    }
  });
});
