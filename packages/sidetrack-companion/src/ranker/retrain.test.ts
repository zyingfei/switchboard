import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../connections/snapshot.js';
import type { ConnectionEdge, ConnectionsSnapshot } from '../connections/types.js';
import { nodeIdFor } from '../connections/types.js';
import {
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
} from '../feedback/events.js';
import {
  projectFeedback,
  type FeedbackProjection,
  type FeedbackTrainingLabel,
} from '../feedback/projection.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createConnectionsMaterializer } from '../sync/contract/connectionsMaterializer.js';
import { createEventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createTimelineStore } from '../timeline/projection.js';
import { FEATURE_SCHEMA_VERSION } from './feature-schema.js';
import {
  buildRankerTrainingCandidates,
  fingerprintFeedbackTrainingLabels,
  maybeRetrainClosestVisitRanker,
  planRankerRetrain,
  type RankerRetrainState,
  type TrainRankerRevisionFn,
  type WriteActiveRankerRevisionFn,
} from './retrain.js';
import {
  DETERMINISTIC_BASELINE_VERSION,
  RANKER_FEATURE_KEYS,
  RANKER_MODEL_VERSION,
  REGULARIZED_LOGISTIC_REGRESSION_VERSION,
  trainRankerRevision,
  trainRankerRevisionFromRows,
  type RankerRevision,
  type RankerTrainingRow,
  type TrainRankerInput,
} from './train.js';
import {
  readActiveClosestVisitRankerRevisionManifest,
  writeActiveClosestVisitRankerRevision,
} from '../producers/closest-visit-revision.js';

const observedAt = '2026-05-08T12:00:00.000Z';
const observedAtMs = Date.parse(observedAt);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const label = (fromId: string, toId: string, weight = 1): FeedbackTrainingLabel => ({
  fromId,
  toId,
  weight,
});

const projection = (
  positiveLabels: readonly FeedbackTrainingLabel[],
  negativeLabels: readonly FeedbackTrainingLabel[] = [],
): FeedbackProjection => ({
  schemaVersion: 1,
  perItem: {},
  containerByItem: {},
  organizedItemsByContainer: {},
  positiveLabels,
  negativeLabels,
});

const manyLabels = (count: number): readonly FeedbackTrainingLabel[] =>
  Array.from({ length: count }, (_, index) =>
    label('visit-a', `visit-${String(index).padStart(3, '0')}`),
  );

const snapshotWithVisits = (urls: readonly string[]): ConnectionsSnapshot => ({
  scope: {},
  nodes: urls.map((url) => ({
    id: nodeIdFor('timeline-visit', url),
    kind: 'timeline-visit',
    label: url,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    originReplicaIds: ['replica-a'],
    metadata: {
      url,
      canonicalUrl: url,
      title: url,
    },
  })),
  edges: [],
  updatedAt: observedAt,
  nodeCount: urls.length,
  edgeCount: 0,
});

const edge = (
  kind: ConnectionEdge['kind'],
  fromNodeId: string,
  toNodeId: string,
  metadata?: Record<string, unknown>,
): ConnectionEdge => ({
  id: `edge:${kind}:${fromNodeId}:${toNodeId}`,
  kind,
  fromNodeId,
  toNodeId,
  observedAt,
  producedBy: { source: 'event-log' },
  confidence: 'inferred',
  ...(metadata === undefined ? {} : { metadata }),
});

const snapshotWithWorkstreamMembership = (
  urls: readonly string[],
  workstreamId: string,
): ConnectionsSnapshot => {
  const base = snapshotWithVisits(urls);
  const workstreamNodeId = nodeIdFor('workstream', workstreamId);
  const membershipEdges: ConnectionEdge[] = urls.map((url) => ({
    ...edge('visit_in_workstream', nodeIdFor('timeline-visit', url), workstreamNodeId),
    confidence: 'asserted' as const,
    producedBy: { source: 'event-log' as const, eventType: USER_ORGANIZED_ITEM },
  }));
  return {
    ...base,
    nodes: [
      ...base.nodes,
      {
        id: workstreamNodeId,
        kind: 'workstream',
        label: workstreamId,
        originReplicaIds: ['replica-a'],
        metadata: {},
      },
    ],
    edges: membershipEdges,
    nodeCount: base.nodeCount + 1,
    edgeCount: membershipEdges.length,
  };
};

const feedbackEvent = (seq: number, fromId: string, toId: string): AcceptedEvent => ({
  clientEventId: `feedback-${String(seq)}`,
  dot: { replicaId: 'replica-a', seq },
  deps: {},
  aggregateId: `feedback-${String(seq)}`,
  type: USER_FLOW_CONFIRMED,
  payload: {
    payloadVersion: 1,
    relationKind: 'closest_visit',
    fromId,
    toId,
  },
  acceptedAtMs: observedAtMs + seq,
});

const rejectedFeedbackEvent = (seq: number, fromId: string, toId: string): AcceptedEvent => ({
  clientEventId: `feedback-rejected-${String(seq)}`,
  dot: { replicaId: 'replica-a', seq },
  deps: {},
  aggregateId: `feedback-rejected-${String(seq)}`,
  type: USER_FLOW_REJECTED,
  payload: {
    payloadVersion: 1,
    relationKind: 'closest_visit',
    fromId,
    toId,
    reason: 'not-related',
  },
  acceptedAtMs: observedAtMs + seq,
});

const organizedEvent = (
  seq: number,
  itemId: string,
  toContainer: string | null,
): AcceptedEvent => ({
  clientEventId: `organized-${String(seq)}`,
  dot: { replicaId: 'replica-a', seq },
  deps: {},
  aggregateId: `feedback:${itemId}`,
  type: USER_ORGANIZED_ITEM,
  payload: {
    payloadVersion: 1,
    itemKind: 'canonical-url',
    itemId,
    action: 'move',
    toContainer,
  },
  acceptedAtMs: observedAtMs + seq,
});

const fakeRevision = (trainingDatasetHash: string): RankerRevision => ({
  revisionId: 'revision-s25',
  modelVersion: RANKER_MODEL_VERSION,
  featureSchemaVersion: FEATURE_SCHEMA_VERSION,
  trainingDatasetHash,
  trainedAt: observedAtMs,
  modelBytes: new ArrayBuffer(4),
});

const emptyState = (): RankerRetrainState | null => null;

const fixtureDcgAt2 = (labels: readonly number[]): number =>
  (labels[0] ?? 0) + (labels[1] ?? 0) / Math.log2(3);

const fixtureMeanNdcg = (
  labelsByGroup: readonly (readonly number[])[],
  scoresByGroup: readonly (readonly number[])[],
): number => {
  let sum = 0;
  for (let index = 0; index < labelsByGroup.length; index += 1) {
    const labels = labelsByGroup[index] ?? [];
    const scores = scoresByGroup[index] ?? [];
    const ideal = [...labels].sort((left, right) => right - left);
    const predicted = labels
      .map((labelValue, rowIndex) => ({
        label: labelValue,
        score: scores[rowIndex] ?? 0,
        rowIndex,
      }))
      .sort((left, right) => right.score - left.score || left.rowIndex - right.rowIndex)
      .map((entry) => entry.label);
    sum += fixtureDcgAt2(predicted) / fixtureDcgAt2(ideal);
  }
  return sum / labelsByGroup.length;
};

describe('ranker retraining loop', () => {
  it('fingerprints the training-label dataset independent of input order', () => {
    const first = fingerprintFeedbackTrainingLabels(
      projection(
        [label('visit-a', 'visit-b'), label('visit-c', 'visit-d')],
        [label('visit-a', 'visit-e')],
      ),
    );
    const second = fingerprintFeedbackTrainingLabels(
      projection(
        [label('visit-c', 'visit-d'), label('visit-a', 'visit-b')],
        [label('visit-a', 'visit-e')],
      ),
    );
    const changedWeight = fingerprintFeedbackTrainingLabels(
      projection(
        [label('visit-a', 'visit-b', 2), label('visit-c', 'visit-d')],
        [label('visit-a', 'visit-e')],
      ),
    );

    expect(second).toEqual(first);
    expect(changedWeight.hash).not.toBe(first.hash);
    expect(first).toMatchObject({
      labelCount: 3,
      positiveLabelCount: 2,
      negativeLabelCount: 1,
    });
  });

  it('plans retraining only when the label hash changed past the threshold', () => {
    const base = fingerprintFeedbackTrainingLabels(projection(manyLabels(10)));
    const belowThreshold = fingerprintFeedbackTrainingLabels(projection(manyLabels(59)));
    const atThreshold = fingerprintFeedbackTrainingLabels(projection(manyLabels(60)));
    const state: RankerRetrainState = {
      schemaVersion: 1,
      lastTrainedLabelDatasetHash: base.hash,
      lastTrainedLabelCount: base.labelCount,
      lastTrainedPositiveLabelCount: base.positiveLabelCount,
      lastTrainedNegativeLabelCount: base.negativeLabelCount,
      activeRevisionId: 'old-revision',
      rankerTrainingDatasetHash: '0'.repeat(64),
      updatedAt: observedAtMs,
    };

    expect(
      planRankerRetrain({
        fingerprint: fingerprintFeedbackTrainingLabels(projection([])),
        state: null,
      }),
    ).toMatchObject({ action: 'skip', reason: 'no-labels' });
    expect(planRankerRetrain({ fingerprint: base, state })).toMatchObject({
      action: 'skip',
      reason: 'unchanged',
      newLabelCount: 0,
    });
    expect(planRankerRetrain({ fingerprint: belowThreshold, state, threshold: 50 })).toMatchObject({
      action: 'skip',
      reason: 'below-threshold',
      newLabelCount: 49,
    });
    expect(planRankerRetrain({ fingerprint: atThreshold, state, threshold: 50 })).toMatchObject({
      action: 'train',
      newLabelCount: 50,
    });
  });

  it('skips with reason `cooldown` when threshold cleared but last train is too recent', () => {
    const base = fingerprintFeedbackTrainingLabels(projection(manyLabels(10)));
    const atThreshold = fingerprintFeedbackTrainingLabels(projection(manyLabels(60)));
    const state: RankerRetrainState = {
      schemaVersion: 1,
      lastTrainedLabelDatasetHash: base.hash,
      lastTrainedLabelCount: base.labelCount,
      lastTrainedPositiveLabelCount: base.positiveLabelCount,
      lastTrainedNegativeLabelCount: base.negativeLabelCount,
      activeRevisionId: 'old-revision',
      rankerTrainingDatasetHash: '0'.repeat(64),
      updatedAt: observedAtMs,
    };
    // 2 minutes after the last train, well within the 10-minute cooldown.
    expect(
      planRankerRetrain({
        fingerprint: atThreshold,
        state,
        threshold: 50,
        cooldownMs: 10 * 60_000,
        nowMs: observedAtMs + 2 * 60_000,
      }),
    ).toMatchObject({ action: 'skip', reason: 'cooldown', newLabelCount: 50 });
    // 11 minutes later → past the cooldown, trains.
    expect(
      planRankerRetrain({
        fingerprint: atThreshold,
        state,
        threshold: 50,
        cooldownMs: 10 * 60_000,
        nowMs: observedAtMs + 11 * 60_000,
      }),
    ).toMatchObject({ action: 'train', newLabelCount: 50 });
  });

  it('force flag bypasses below-threshold + cooldown', () => {
    const base = fingerprintFeedbackTrainingLabels(projection(manyLabels(10)));
    const tinyDelta = fingerprintFeedbackTrainingLabels(projection(manyLabels(11)));
    const state: RankerRetrainState = {
      schemaVersion: 1,
      lastTrainedLabelDatasetHash: base.hash,
      lastTrainedLabelCount: base.labelCount,
      lastTrainedPositiveLabelCount: base.positiveLabelCount,
      lastTrainedNegativeLabelCount: base.negativeLabelCount,
      activeRevisionId: 'old-revision',
      rankerTrainingDatasetHash: '0'.repeat(64),
      updatedAt: observedAtMs,
    };
    // newLabelCount=1, threshold=50, cooldown=10min, nowMs = same as
    // last train. Without force this would be 'below-threshold'.
    expect(
      planRankerRetrain({
        fingerprint: tinyDelta,
        state,
        threshold: 50,
        cooldownMs: 10 * 60_000,
        nowMs: observedAtMs,
        force: true,
      }),
    ).toMatchObject({ action: 'train', newLabelCount: 1 });
  });

  it('force flag retrains unchanged labels for model or candidate-generation changes', () => {
    const fingerprint = fingerprintFeedbackTrainingLabels(projection(manyLabels(10)));
    const state: RankerRetrainState = {
      schemaVersion: 1,
      lastTrainedLabelDatasetHash: fingerprint.hash,
      lastTrainedLabelCount: fingerprint.labelCount,
      lastTrainedPositiveLabelCount: fingerprint.positiveLabelCount,
      lastTrainedNegativeLabelCount: fingerprint.negativeLabelCount,
      activeRevisionId: 'old-revision',
      rankerTrainingDatasetHash: '0'.repeat(64),
      updatedAt: observedAtMs,
    };

    expect(
      planRankerRetrain({
        fingerprint,
        state,
        threshold: 50,
        cooldownMs: 10 * 60_000,
        nowMs: observedAtMs,
        force: true,
      }),
    ).toMatchObject({ action: 'train', newLabelCount: 0 });
  });

  it('builds ranker training candidates from feedback labels and snapshot features', () => {
    const from = 'https://example.test/a';
    const positive = 'https://example.test/b';
    const negative = 'https://example.test/c';
    const candidates = buildRankerTrainingCandidates({
      feedback: projection([label(from, positive)], [label(from, negative)]),
      merged: [],
      snapshot: snapshotWithVisits([from, positive, negative]),
      randomNegativeCandidatesPerPositive: 0,
    });

    expect(candidates.map((candidate) => candidate.candidate.toVisitId)).toEqual([
      positive,
      negative,
    ]);
    expect(candidates[0]?.candidate.sources).toEqual(['user_confirmed']);
    expect(candidates[0]?.features.same_host).toBe(1);
    expect(candidates[1]?.candidate.sources).toEqual(['recently_skipped']);
    expect(candidates[1]?.features.same_host).toBe(1);
  });

  it('does not build ranker training candidates from shared workstream membership alone', () => {
    const from = 'https://alpha.test/reference';
    const to = 'https://bravo.invalid/handbook';
    const candidates = buildRankerTrainingCandidates({
      feedback: projection([]),
      merged: [],
      snapshot: snapshotWithWorkstreamMembership([from, to], 'ws_scope'),
      randomNegativeCandidatesPerPositive: 0,
    });

    expect(candidates).toEqual([]);
  });

  it('keeps explicit user-confirmed training candidates inside a shared workstream', () => {
    const from = 'https://alpha.test/reference';
    const to = 'https://bravo.invalid/handbook';
    const candidates = buildRankerTrainingCandidates({
      feedback: projection([label(from, to)]),
      merged: [],
      snapshot: snapshotWithWorkstreamMembership([from, to], 'ws_scope'),
      randomNegativeCandidatesPerPositive: 0,
    });

    expect(candidates.map((candidate) => candidate.candidate.toVisitId)).toEqual([to]);
    expect(candidates[0]?.candidate.sources).toEqual(['user_confirmed']);
  });

  it('keeps independent similarity training candidates inside a shared workstream', () => {
    const from = 'https://alpha.test/reference';
    const to = 'https://bravo.invalid/handbook';
    const membership = snapshotWithWorkstreamMembership([from, to], 'ws_scope');
    const similarity = edge(
      'visit_resembles_visit',
      nodeIdFor('timeline-visit', from),
      nodeIdFor('timeline-visit', to),
    );
    const candidates = buildRankerTrainingCandidates({
      feedback: projection([]),
      merged: [],
      snapshot: {
        ...membership,
        edges: [...membership.edges, similarity],
        edgeCount: membership.edgeCount + 1,
      },
      randomNegativeCandidatesPerPositive: 0,
    });

    const fromCandidates = candidates.filter(
      (candidate) => candidate.candidate.fromVisitId === from,
    );
    expect(fromCandidates.map((candidate) => candidate.candidate.toVisitId)).toEqual([to]);
    expect(fromCandidates[0]?.candidate.sources).toEqual(['embedding_neighborhood']);
  });

  it('trains, writes the active revision, and persists retrain state when threshold is met', async () => {
    const from = 'https://example.test/a';
    const to = 'https://example.test/b';
    const negative = 'https://example.test/c';
    const trainInputs: TrainRankerInput[] = [];
    const writtenRevisions: RankerRevision[] = [];
    const writtenStates: RankerRetrainState[] = [];
    const train: TrainRankerRevisionFn = (input) => {
      trainInputs.push(input);
      return Promise.resolve(fakeRevision('1'.repeat(64)));
    };
    const writeActiveRevision: WriteActiveRankerRevisionFn = (_vaultRoot, revision) => {
      writtenRevisions.push(revision);
      return Promise.resolve();
    };

    const result = await maybeRetrainClosestVisitRanker({
      vaultRoot: '/tmp/sidetrack-ranker-retrain-test',
      merged: [feedbackEvent(1, from, to)],
      snapshot: snapshotWithVisits([from, to, negative]),
      threshold: 1,
      randomNegativeCandidatesPerPositive: 1,
      train,
      writeActiveRevision,
      readState: () => Promise.resolve(emptyState()),
      writeState: (_vaultRoot, state) => {
        writtenStates.push(state);
        return Promise.resolve();
      },
    });

    expect(result).toMatchObject({
      status: 'trained',
      revisionId: 'revision-s25',
      newLabelCount: 1,
      candidateCount: 2,
    });
    expect(trainInputs[0]?.feedback.positiveLabels).toHaveLength(1);
    expect(trainInputs[0]?.feedback.negativeLabels).toHaveLength(0);
    expect(trainInputs[0]?.candidates).toHaveLength(2);
    expect(writtenRevisions[0]?.revisionId).toBe('revision-s25');
    expect(writtenStates[0]).toMatchObject({
      lastTrainedLabelCount: 1,
      activeRevisionId: 'revision-s25',
      rankerTrainingDatasetHash: '1'.repeat(64),
    });
  });

  it('skips before candidate generation when labels cannot form a usable query group', async () => {
    const trainInputs: TrainRankerInput[] = [];
    const train: TrainRankerRevisionFn = (input) => {
      trainInputs.push(input);
      return Promise.resolve(fakeRevision('1'.repeat(64)));
    };

    const result = await maybeRetrainClosestVisitRanker({
      vaultRoot: '/tmp/sidetrack-ranker-retrain-test',
      merged: [organizedEvent(1, 'https://example.test/a', 'workstream:alpha')],
      snapshot: snapshotWithVisits(['https://example.test/a', 'https://example.test/b']),
      force: true,
      train,
      writeActiveRevision: () => Promise.resolve(),
      readState: () => Promise.resolve(emptyState()),
      writeState: () => Promise.resolve(),
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'no-usable-query-groups',
      candidateCount: 0,
      fingerprint: {
        labelCount: 1,
        positiveLabelCount: 1,
        negativeLabelCount: 0,
      },
    });
    expect(trainInputs).toEqual([]);
  });

  it('captures trainQuality (gradeHistogram + spread + in-sample metric) into the persisted manifest', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-ranker-trainquality-'));
    tempRoots.push(vaultRoot);

    // Small synthetic dataset: two from-visits, each with one positive
    // (graded >=1) and one negative (graded 0) destination so each query
    // group has the >=2 rows / >=2 distinct labels the trainer needs.
    const fromA = 'https://example.test/from-a';
    const fromB = 'https://example.test/from-b';
    const posA = 'https://example.test/pos-a';
    const negA = 'https://example.test/neg-a';
    const posB = 'https://example.test/pos-b';
    const negB = 'https://example.test/neg-b';
    const feedback = projection(
      [label(fromA, posA), label(fromB, posB)],
      [label(fromA, negA), label(fromB, negB)],
    );
    const candidates = buildRankerTrainingCandidates({
      feedback,
      merged: [],
      snapshot: snapshotWithVisits([fromA, fromB, posA, negA, posB, negB]),
      randomNegativeCandidatesPerPositive: 0,
    });

    const revision = await trainRankerRevision({
      feedback,
      candidates,
      options: { numRound: 5, trainedAt: observedAtMs },
    });

    expect(revision.trainQuality).toBeDefined();
    const histogram = revision.trainQuality?.gradeHistogram;
    expect(histogram).toMatchObject({ '0': 2, '1': 2 });
    expect(revision.trainQuality?.candidateLabeling).toMatchObject({
      totalCandidates: candidates.length,
      labeledRows: 4,
      positiveRows: 2,
      negativeRows: 2,
    });
    // Every graded row is accounted for exactly once across grades 0..4.
    const totalGraded = Object.values(histogram ?? {}).reduce((sum, n) => sum + n, 0);
    expect(totalGraded).toBe(4);
    if (revision.trainQuality?.scoreSpread !== undefined) {
      expect(revision.trainQuality.scoreSpread.distinctRatio).toBeGreaterThan(0);
      expect(Number.isFinite(revision.trainQuality.scoreSpread.stdDev)).toBe(true);
    }
    if (revision.trainQuality?.inSampleMetric !== undefined) {
      expect(revision.trainQuality.inSampleMetric.kind).toContain('ndcg');
      expect(revision.trainQuality.inSampleMetric.value).toBeGreaterThanOrEqual(0);
      expect(revision.trainQuality.inSampleMetric.value).toBeLessThanOrEqual(1);
    }

    await writeActiveClosestVisitRankerRevision(vaultRoot, revision);
    const manifest = await readActiveClosestVisitRankerRevisionManifest(vaultRoot);
    expect(manifest?.trainQuality?.gradeHistogram).toMatchObject({ '0': 2, '1': 2 });
    expect(manifest?.trainQuality?.candidateLabeling).toMatchObject({
      labeledRows: 4,
      unlabeledCandidateCount: 0,
    });
  });

  it('keeps workstream identity out of the closest_visit scorer feature vector', () => {
    expect([...RANKER_FEATURE_KEYS]).not.toContain('same_workstream');
    expect([...RANKER_FEATURE_KEYS]).not.toContain('user_asserted_in_workstream');
  });

  it('keeps a synthetic workstream-leak fixture as evaluator calibration', () => {
    // The live v3 scorer no longer consumes these two fields. This
    // fixture is deliberately test-only: it re-injects the old predicate
    // as a score to keep the Phase-0 instrument calibrated against the
    // degenerate signature #182 describes.
    const labelsByGroup = [
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1],
    ] as const;
    const leakedScoresByGroup = [
      [0, 2],
      [0, 2],
      [0, 2],
      [0, 2],
    ] as const;
    const ablatedScoresByGroup = [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ] as const;
    const permutedLabelsByGroup = [
      [1, 0],
      [1, 0],
      [1, 0],
      [1, 0],
    ] as const;
    const permutedLeakedScoresByGroup = [
      [2, 0],
      [2, 0],
      [2, 0],
      [2, 0],
    ] as const;

    expect(fixtureMeanNdcg(labelsByGroup, leakedScoresByGroup)).toBe(1);
    expect(fixtureMeanNdcg(labelsByGroup, ablatedScoresByGroup)).toBeLessThan(0.7);
    expect(fixtureMeanNdcg(permutedLabelsByGroup, permutedLeakedScoresByGroup)).toBe(1);
  });

  it('uses feedback event timestamps for realistic held-out splitting', async () => {
    const merged: AcceptedEvent[] = [];
    const urls: string[] = [];
    for (let group = 0; group < 5; group += 1) {
      const from = `https://example.test/realistic-from-${String(group)}`;
      const positive = `https://example.test/realistic-positive-${String(group)}`;
      const negative = `https://example.test/realistic-negative-${String(group)}`;
      urls.push(from, positive, negative);
      merged.push(
        {
          ...feedbackEvent(group * 10 + 1, from, positive),
          acceptedAtMs: observedAtMs + group * 10_000,
        },
        {
          ...rejectedFeedbackEvent(group * 10 + 2, from, negative),
          acceptedAtMs: observedAtMs + group * 10_000 + 1,
        },
      );
    }

    const feedback = projectFeedback(merged);
    const candidates = buildRankerTrainingCandidates({
      feedback,
      merged,
      snapshot: snapshotWithVisits(urls),
      randomNegativeCandidatesPerPositive: 0,
    });
    const candidateTimes = new Set(candidates.map((candidate) => candidate.candidate.generatedAt));
    expect(candidateTimes.size).toBeGreaterThan(1);

    const revision = await trainRankerRevision({
      feedback,
      candidates,
      options: { numRound: 5, trainedAt: observedAtMs },
    });

    expect(revision.trainQuality?.heldOutMetric).toMatchObject({
      kind: 'time-split held-out ndcg@5',
      trainGroupCount: 3,
      heldOutGroupCount: 1,
    });
    expect(revision.trainQuality?.methodologySpine).toMatchObject({
      split: {
        status: 'available',
        trainGroupCount: 3,
        validationGroupCount: 1,
        testGroupCount: 1,
      },
      novelPairSlice: {
        rowCount: 2,
        positiveRows: 1,
        negativeRows: 1,
      },
      labelPermutation: {
        rowCount: 2,
        groupCount: 1,
        metric: {
          kind: 'label-permutation validation ndcg@5',
        },
      },
      workstreamFeatureAblation: {
        status: 'not-in-feature-vector',
      },
    });
    expect(
      revision.trainQuality?.methodologySpine?.labelPermutation.metric?.value,
    ).toBeGreaterThanOrEqual(0);
    expect(
      revision.trainQuality?.methodologySpine?.labelPermutation.metric?.value,
    ).toBeLessThanOrEqual(1);
    expect(revision.trainQuality?.methodologySpine?.reservedTestMetric).toMatchObject({
      kind: 'reserved-test ndcg@5',
      rowCount: 2,
      groupCount: 1,
    });
    expect(revision.trainQuality?.methodologySpine?.tuning).toMatchObject({
      status: 'available',
      strategy: 'validation-num-round-grid',
      requestedNumRound: 5,
      validationCandidateCount: 3,
    });
    expect(
      revision.trainQuality?.methodologySpine?.tuning.candidates.map((item) => item.numRound),
    ).toEqual([2, 5, 10]);
    expect(revision.trainQuality?.methodologySpine?.modelChoice).toMatchObject({
      deterministicBaseline: {
        candidate: DETERMINISTIC_BASELINE_VERSION,
      },
      activeModel: {
        candidate: RANKER_MODEL_VERSION,
      },
      regularizedLogisticRegression: {
        candidate: REGULARIZED_LOGISTIC_REGRESSION_VERSION,
      },
      graduation: {
        minValidationDelta: 0.005,
      },
    });
    expect(revision.trainQuality?.methodologySpine?.shipGate).toMatchObject({
      candidate: RANKER_MODEL_VERSION,
      reservedTestUsedExactlyOnce: true,
      minValidationDeltaVsBaseline: 0.005,
      minReservedTestNdcg: 0.5,
    });
    expect(['pass', 'fail', 'unavailable']).toContain(
      revision.trainQuality?.methodologySpine?.shipGate.status,
    );
  });

  it('reports an honest time-split held-out metric when row timestamps allow it', async () => {
    const rows: RankerTrainingRow[] = [];
    for (let group = 0; group < 5; group += 1) {
      const fromVisitId = `heldout-from-${String(group)}`;
      const generatedAt = observedAtMs + group * 1_000;
      for (const [suffix, labelValue, cosine] of [
        ['positive', 1, 0.9],
        ['negative', 0, 0.1],
      ] as const) {
        rows.push({
          candidate: {
            fromVisitId,
            toVisitId: `heldout-${suffix}-${String(group)}`,
            sources: labelValue === 1 ? ['user_confirmed'] : ['random_unrelated'],
            generatedAt,
          },
          features: {
            schemaVersion: FEATURE_SCHEMA_VERSION,
            same_workstream: 0,
            opener_chain_depth: 0,
            in_navigation_chain: 0,
            same_canonical_url: 0,
            same_host: 0,
            same_repo: 0,
            same_search_query: 0,
            same_copied_snippet_count: 0,
            shared_title_tokens: labelValue,
            shared_path_tokens: 0,
            cosine_similarity: cosine,
            recency_score_from: 0,
            recency_score_to: 0,
            engagement_class_match: 0,
            return_count_from: 0,
            return_count_to: 0,
            user_asserted_in_thread: 0,
            user_asserted_in_workstream: 0,
            same_active_topic: 0,
            topic_lineage_merge_split_related: 0,
            page_quality_tier_from: 0,
            page_quality_tier_to: 0,
          },
          label: labelValue,
        });
      }
    }

    const revision = await trainRankerRevisionFromRows(rows, {
      numRound: 5,
      trainedAt: observedAtMs,
    });

    expect(revision.trainQuality?.heldOutMetric).toMatchObject({
      kind: 'time-split held-out ndcg@5',
      trainGroupCount: 3,
      heldOutGroupCount: 1,
    });
    expect(revision.trainQuality?.methodologySpine?.split).toMatchObject({
      status: 'available',
      trainGroupCount: 3,
      validationGroupCount: 1,
      testGroupCount: 1,
    });
    expect(revision.trainQuality?.methodologySpine?.reservedTestMetric).toMatchObject({
      kind: 'reserved-test ndcg@5',
      rowCount: 2,
      groupCount: 1,
    });
    expect(revision.trainQuality?.heldOutMetric?.value).toBeGreaterThanOrEqual(0);
    expect(revision.trainQuality?.heldOutMetric?.value).toBeLessThanOrEqual(1);
  });

  it('connections materializer schedules retrain checks for feedback events', async () => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-ranker-retrain-mat-'));
    tempRoots.push(vaultRoot);
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    let retrainCalls = 0;
    let mergedEventCount = 0;
    const materializer = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      rankerRetrainer: ({ merged }) => {
        retrainCalls += 1;
        mergedEventCount = merged.length;
        return Promise.resolve({
          status: 'skipped',
          reason: 'below-threshold',
          fingerprint: {
            hash: '0'.repeat(64),
            labelCount: 1,
            positiveLabelCount: 1,
            negativeLabelCount: 0,
          },
          newLabelCount: 1,
        });
      },
    });
    const event = feedbackEvent(1, 'https://example.test/a', 'https://example.test/b');

    await eventLog.importPeerEvent(event);
    materializer.onAccepted(event, { origin: 'peer' });
    await materializer.awaitIdle();

    expect(materializer.handles.has(USER_FLOW_CONFIRMED)).toBe(true);
    expect(retrainCalls).toBe(1);
    expect(mergedEventCount).toBe(1);
  });
});
