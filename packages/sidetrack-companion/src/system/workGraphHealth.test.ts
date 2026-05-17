import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../connections/snapshot.js';
import { edgeIdFor, type ConnectionsSnapshot } from '../connections/types.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import { projectFeedback } from '../feedback/projection.js';
import {
  TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
  createTopicRevisionStore,
  type TopicRevision,
} from '../producers/topic-revision.js';
import {
  augmentFeedbackWithVisitPairLabels,
  fingerprintFeedbackTrainingLabels,
} from '../ranker/retrain.js';
import { RANKER_MODEL_VERSION } from '../ranker/train.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createEventLog } from '../sync/eventLog.js';
import { collectWorkGraphHealth } from './workGraphHealth.js';

describe('work graph diagnostic candidates', () => {
  let vaultRoot = '';
  let priorHotSimilarity: string | undefined;
  let priorHotTopics: string | undefined;
  let priorConnectionsChild: string | undefined;
  let priorConnectionsWorker: string | undefined;
  let priorConnectionsInProcess: string | undefined;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-workgraph-health-'));
    priorHotSimilarity = process.env['SIDETRACK_CONNECTIONS_HOT_SIMILARITY'];
    priorHotTopics = process.env['SIDETRACK_CONNECTIONS_HOT_TOPICS'];
    priorConnectionsChild = process.env['SIDETRACK_CONNECTIONS_CHILD'];
    priorConnectionsWorker = process.env['SIDETRACK_CONNECTIONS_WORKER'];
    priorConnectionsInProcess = process.env['SIDETRACK_CONNECTIONS_INPROCESS'];
    delete process.env['SIDETRACK_CONNECTIONS_WORKER'];
    delete process.env['SIDETRACK_CONNECTIONS_INPROCESS'];
    process.env['SIDETRACK_CONNECTIONS_HOT_SIMILARITY'] = '1';
    delete process.env['SIDETRACK_CONNECTIONS_HOT_TOPICS'];
    process.env['SIDETRACK_CONNECTIONS_CHILD'] = '1';
  });

  afterEach(async () => {
    if (priorHotSimilarity === undefined) {
      delete process.env['SIDETRACK_CONNECTIONS_HOT_SIMILARITY'];
    } else {
      process.env['SIDETRACK_CONNECTIONS_HOT_SIMILARITY'] = priorHotSimilarity;
    }
    if (priorHotTopics === undefined) {
      delete process.env['SIDETRACK_CONNECTIONS_HOT_TOPICS'];
    } else {
      process.env['SIDETRACK_CONNECTIONS_HOT_TOPICS'] = priorHotTopics;
    }
    if (priorConnectionsChild === undefined) {
      delete process.env['SIDETRACK_CONNECTIONS_CHILD'];
    } else {
      process.env['SIDETRACK_CONNECTIONS_CHILD'] = priorConnectionsChild;
    }
    if (priorConnectionsWorker === undefined) {
      delete process.env['SIDETRACK_CONNECTIONS_WORKER'];
    } else {
      process.env['SIDETRACK_CONNECTIONS_WORKER'] = priorConnectionsWorker;
    }
    if (priorConnectionsInProcess === undefined) {
      delete process.env['SIDETRACK_CONNECTIONS_INPROCESS'];
    } else {
      process.env['SIDETRACK_CONNECTIONS_INPROCESS'] = priorConnectionsInProcess;
    }
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('normalizes active, standby, shadow, diagnostic, and content-lane rows', async () => {
    const topicRevision: TopicRevision = {
      revisionId: 'topic-rev-active',
      visitSimilarityRevisionId: 'sim-rev',
      cosineThreshold: 0.85,
      algorithmVersion: TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
      topics: [
        {
          topicId: 'topic-1',
          memberCanonicalUrls: ['https://example.test/a'],
          metadata: {
            memberCount: 1,
            representativeTitles: ['A'],
            firstObservedAt: '2026-05-16T12:00:00.000Z',
            lastObservedAt: '2026-05-16T12:00:00.000Z',
            cohesion: 1,
          },
        },
      ],
      lineage: [],
      producedAt: Date.parse('2026-05-16T12:00:00.000Z'),
    };
    await createTopicRevisionStore(vaultRoot).putActiveRevision(topicRevision);
    await mkdir(join(vaultRoot, '_BAC', 'connections', 'diagnostics'), { recursive: true });
    await writeFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      `${JSON.stringify({
        producedAt: '2026-05-16T12:34:00.000Z',
        rankerAugmentation: {
          status: 'absent',
          reason: 'no-active-manifest',
          activeRevisionId: null,
          activeModelVersion: null,
          expectedModelVersion: RANKER_MODEL_VERSION,
          activeFeatureSchemaVersion: null,
          expectedFeatureSchemaVersion: 3,
          needsRetrain: false,
          modelFreshness: null,
          methodologySpine: {
            servingGateEnforced: false,
            split: {
              status: 'available',
              strategy: 'forward-chaining-time',
              timestampSource: 'supervision-event-or-visit-observed-at',
              trainGroupCount: 12,
              validationGroupCount: 4,
              testGroupCount: 3,
              validationCutoffGeneratedAt: 1,
              testCutoffGeneratedAt: 2,
            },
            shipGate: {
              status: 'fail',
              candidate: RANKER_MODEL_VERSION,
              minValidationDeltaVsBaseline: 0.01,
              minReservedTestNdcg: 0.2,
              reservedTestUsedExactlyOnce: true,
              reason: 'reserved-test-below-floor',
            },
          },
          closestVisitEdgeCount: 0,
          rankerSourceEdgeCount: 0,
        },
        shadowVsBaseline: {
          enabled: true,
          shadowAlgorithmVersion: TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
          shadowRevisionId: 'shadow-rev',
          baselineTopicCount: 2,
          shadowTopicCount: 3,
          shadowMaxTopicShare: 0.42,
          noiseShare: 0.12,
        },
        shadowObservation: {
          shadowRevisionId: 'shadow-rev',
          adjacentPerVisitChurn: 0.33,
          shadowCollapseBoundaryChanged: true,
        },
        drift: {
          status: 'warning',
          trippedSignals: [],
          warningSignals: ['noiseShare'],
          silhouette: {
            revisionId: 'topic-rev-active',
            silhouette: 0.44,
            delta: -0.16,
          },
        },
      })}\n`,
      'utf8',
    );

    const health = await collectWorkGraphHealth({
      vaultRoot,
      now: () => new Date('2026-05-16T12:45:00.000Z'),
      connectionsDiagnostics: () => ({
        dirtySourceCount: 2,
        tombstonedSourceCount: 1,
        latestExtractionCount: 1,
        oldestDirtySourceAgeMs: null,
      }),
    });

    expect(health.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'topic.active-producer',
          lane: 'active',
          servingImpact: 'serving',
          status: 'ok',
          revisionId: 'topic-rev-active',
          asOf: '2026-05-16T12:00:00.000Z',
        }),
        expect.objectContaining({
          id: 'topic.hdbscan-standby',
          lane: 'standby',
          servingImpact: 'not-serving',
          status: 'off',
        }),
        expect.objectContaining({
          id: 'topic.shadow-idf-rkn-split',
          lane: 'shadow',
          servingImpact: 'observe-only',
          status: 'warning',
          reason: 'shadow-collapse-boundary-changed',
          revisionId: 'shadow-rev',
        }),
        expect.objectContaining({
          id: 'diagnostic.drift-sidecar',
          lane: 'diagnostic',
          servingImpact: 'observe-only',
          status: 'warning',
          reason: 'drift-warning',
        }),
        expect.objectContaining({
          id: 'ranker.methodology-spine',
          lane: 'diagnostic',
          status: 'warning',
          reason: 'reserved-test-below-floor',
        }),
        expect.objectContaining({
          id: 'similarity.hot-incremental',
          lane: 'standby',
          status: 'pending',
          reason: 'last-fast-path-decision-unavailable',
        }),
        expect.objectContaining({
          id: 'topic.hot-incremental',
          lane: 'standby',
          status: 'off',
          reason: 'env-off',
        }),
        expect.objectContaining({
          id: 'content-lane.dirty-source-queue',
          lane: 'standby',
          status: 'pending',
          reason: 'dirty-source-pending',
          asOf: '2026-05-16T12:45:00.000Z',
          metrics: expect.objectContaining({
            dirtySourceCount: 2,
            tombstonedSourceCount: 1,
            latestExtractionCount: 1,
            oldestDirtySourceAgeMs: null,
            backlogWarnMs: 600_000,
          }),
        }),
        expect.objectContaining({
          id: 'reconcile.runner-mode',
          lane: 'active',
          servingImpact: 'serving',
          status: 'ok',
          reason: 'child-process',
        }),
        expect.objectContaining({
          id: 'quality.gray-zone-scorer',
          family: 'quality',
          status: 'off',
          reason: 'no-runtime-model-injection',
        }),
      ]),
    );
  });

  it('warns on content-lane backlog only when an age threshold is tripped', async () => {
    const health = await collectWorkGraphHealth({
      vaultRoot,
      now: () => new Date('2026-05-16T13:00:00.000Z'),
      connectionsDiagnostics: () => ({
        dirtySourceCount: 1,
        tombstonedSourceCount: 0,
        latestExtractionCount: 0,
        oldestDirtySourceAgeMs: 600_001,
      }),
    });

    expect(health.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'content-lane.dirty-source-queue',
          status: 'warning',
          reason: 'dirty-source-backlog',
          asOf: '2026-05-16T13:00:00.000Z',
          metrics: expect.objectContaining({
            dirtySourceCount: 1,
            oldestDirtySourceAgeMs: 600_001,
            backlogWarnMs: 600_000,
          }),
        }),
      ]),
    );
  });

  it('does not warn for an aged content-lane snapshot with no dirty work', async () => {
    const health = await collectWorkGraphHealth({
      vaultRoot,
      now: () => new Date('2026-05-16T13:05:00.000Z'),
      connectionsDiagnostics: () => ({
        dirtySourceCount: 0,
        tombstonedSourceCount: 0,
        latestExtractionCount: 0,
        oldestDirtySourceAgeMs: 600_001,
      }),
    });

    expect(health.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'content-lane.dirty-source-queue',
          status: 'ok',
          reason: null,
          asOf: '2026-05-16T13:05:00.000Z',
          metrics: expect.objectContaining({
            dirtySourceCount: 0,
            oldestDirtySourceAgeMs: 600_001,
          }),
        }),
      ]),
    );
  });

  it('compares retrain freshness against the same augmented label dataset used by retrain', async () => {
    const replicaId = '11111111-1111-4111-8111-111111111111';
    const peerReplicaId = '22222222-2222-4222-8222-222222222222';
    let seq = 0;
    const eventLog = createEventLog(vaultRoot, {
      replicaId,
      created: true,
      nextSeq: async () => {
        seq += 1;
        return seq;
      },
      peekSeq: () => seq,
      observeSeq: async (incoming: number) => {
        seq = Math.max(seq, incoming);
      },
    });
    const rejectedAgainstWorkstream: AcceptedEvent = {
      clientEventId: 'client-reject-a-from-w1',
      dot: { replicaId: peerReplicaId, seq: 1 },
      deps: {},
      aggregateId: 'feedback:reject-a-from-w1',
      type: USER_ORGANIZED_ITEM,
      payload: {
        payloadVersion: 1,
        itemKind: 'canonical-url',
        itemId: 'https://example.test/a',
        action: 'ignore',
        fromContainer: 'workstream:w1',
      },
      acceptedAtMs: Date.parse('2026-05-16T14:00:00.000Z'),
    };
    await eventLog.importPeerEvent(rejectedAgainstWorkstream);

    const snapshot: ConnectionsSnapshot = {
      scope: {},
      nodes: [],
      edges: [
        {
          id: edgeIdFor(
            'visit_in_workstream',
            'timeline-visit:https://example.test/b',
            'workstream:w1',
          ),
          kind: 'visit_in_workstream',
          fromNodeId: 'timeline-visit:https://example.test/b',
          toNodeId: 'workstream:w1',
          observedAt: '2026-05-16T14:00:00.000Z',
          producedBy: {
            source: 'event-log',
            eventType: USER_ORGANIZED_ITEM,
            dot: { replicaId: peerReplicaId, seq: 2 },
          },
          confidence: 'asserted',
        },
      ],
      updatedAt: '2026-05-16T14:00:00.000Z',
      nodeCount: 0,
      edgeCount: 1,
      snapshotRevision: 'snapshot-with-workstream-member',
    };
    await createConnectionsStore(vaultRoot).putCurrent(snapshot);

    const feedback = augmentFeedbackWithVisitPairLabels(
      projectFeedback([rejectedAgainstWorkstream]),
      snapshot,
    );
    const fingerprint = fingerprintFeedbackTrainingLabels(feedback);
    await mkdir(join(vaultRoot, '_BAC', 'connections', 'closest-visit'), { recursive: true });
    await writeFile(
      join(vaultRoot, '_BAC', 'connections', 'closest-visit', 'retrain-state.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        lastTrainedLabelDatasetHash: fingerprint.hash,
        lastTrainedLabelCount: fingerprint.labelCount,
        lastTrainedPositiveLabelCount: fingerprint.positiveLabelCount,
        lastTrainedNegativeLabelCount: fingerprint.negativeLabelCount,
        activeRevisionId: 'ranker-rev',
        rankerTrainingDatasetHash:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        updatedAt: Date.parse('2026-05-16T14:01:00.000Z'),
      })}\n`,
      'utf8',
    );

    const health = await collectWorkGraphHealth({
      vaultRoot,
      eventLog,
      now: () => new Date('2026-05-16T14:02:00.000Z'),
    });

    expect(health.ranker.datasetChangedSinceTrain).toBe(false);
    expect(health.ranker.retrainSkipReason).toBe('unchanged');
    expect(health.ranker.trainingMix).toMatchObject({
      positivesAtTrain: 0,
      userFeedbackNegativesAtTrain: 2,
    });
  });
});
