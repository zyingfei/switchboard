import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../connections/snapshot.js';
import { edgeIdFor, type ConnectionsSnapshot } from '../connections/types.js';
import { USER_ORGANIZED_ITEM, USER_REJECTED_RELATION } from '../feedback/events.js';
import { projectFeedback } from '../feedback/projection.js';
import { recordCanonicalCollision } from '../page-content/canonicalize-telemetry.js';
import { sha256Hex } from '../page-content/store.js';
import { writeActiveClosestVisitRankerRevision } from '../producers/closest-visit-revision.js';
import {
  TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
  createTopicRevisionStore,
  type TopicRevision,
} from '../producers/topic-revision.js';
import { FEATURE_SCHEMA_VERSION } from '../ranker/feature-schema.js';
import { fingerprintFeedbackTrainingLabels } from '../ranker/retrain.js';
import {
  writeRecallImpressionRetrainState,
  type RecallImpressionTrainingStats,
} from '../ranker/retrain-impressions.js';
import {
  shipGateV2Decide,
  type ImpressionMetrics,
} from '../ranker/shipGateV2.js';
import { RANKER_MODEL_VERSION } from '../ranker/train.js';
import {
  __resetRankerShadowDiffForTests,
  recordRankerShadowDiff,
} from '../recall-v2/rankerShadowDiff.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createEventLog } from '../sync/eventLog.js';
import {
  collectWorkGraphHealth,
  withLiveShipGateV2Serving,
} from './workGraphHealth.js';

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
        // Health-panel cleanup 2026-05-26: topic.hdbscan-standby is
        // perpetually status=off + no-production-selector → filtered
        // from the candidates response to reduce noise. Re-add to the
        // unfiltered ID set in workGraphHealth.ts:isStaleDiagnostic if
        // it ever becomes meaningful.
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
        // U2 — hot paths default ON (topics unset ⇒ now enabled, was
        // 'off'/'env-off'); no hotPath diagnostics in this fixture ⇒
        // honest 'pending'/'fast-path-decision-pending'.
        // Lane renames 2026-05-27: 'standby' → 'incremental' for
        // hot-paths, 'queue' for content-lane queue health.
        expect.objectContaining({
          id: 'similarity.hot-incremental',
          lane: 'incremental',
          status: 'pending',
          reason: 'fast-path-decision-pending',
        }),
        expect.objectContaining({
          id: 'topic.hot-incremental',
          lane: 'incremental',
          status: 'pending',
          reason: 'fast-path-decision-pending',
        }),
        expect.objectContaining({
          id: 'content-lane.dirty-source-queue',
          lane: 'queue',
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
        // Health-panel cleanup 2026-05-26: quality.gray-zone-scorer is
        // perpetually status=off → filtered from the candidates response.
      ]),
    );
  });

  it('filters out perpetually-off diagnostic candidates from the response', async () => {
    const filteredIds = ['topic.hdbscan-standby', 'topic.algorithm-comparison', 'quality.gray-zone-scorer'];
    const health = await collectWorkGraphHealth({ vaultRoot, now: () => new Date('2026-05-16T13:00:00.000Z') });
    for (const id of filteredIds) {
      expect(health.candidates.some((c) => c.id === id)).toBe(false);
    }
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

  it('surfaces canonicalization telemetry and over-collapsed page-content hygiene', async () => {
    const canonicalUrl = 'https://health-collapse.example.test/thread';
    for (const ref of ['one', 'two', 'three', 'four']) {
      recordCanonicalCollision(
        `https://health-collapse.example.test/thread?utm_source=${ref}`,
        canonicalUrl,
      );
    }
    const dir = join(vaultRoot, '_BAC', 'page-content', 'by-url');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sha256Hex(canonicalUrl)}.json`),
      `${JSON.stringify(
        {
          coverage: {
            canonicalUrl,
            state: 'indexed',
            lastIndexedAt: '2026-05-26T12:30:00.000Z',
            contentHash: 'hash-overcollapsed-health',
            chunkCount: 67,
          },
          url: canonicalUrl,
          updatedAt: '2026-05-26T12:30:00.000Z',
          sourceEventType: 'page.content.extracted',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const health = await collectWorkGraphHealth({ vaultRoot });

    expect(health.recall.canonicalizationTelemetry.suspiciousHosts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: 'health-collapse.example.test',
          canonicalCount: 1,
          rawCount: 4,
          collisionRatio: 4,
          samplePairs: [
            expect.objectContaining({
              canonicalUrl,
              rawUrls: expect.arrayContaining([
                'https://health-collapse.example.test/thread?utm_source=one',
              ]),
            }),
          ],
        }),
      ]),
    );
    expect(health.hygiene.overCollapsedRecords).toMatchObject({
      count: 1,
      samples: [{ canonicalUrl, chunkCount: 67, contentHash: 'hash-overcollapsed-health' }],
    });
  });

  it('reports v6 legacy-trained ranker manifests as ready (softened 2026-05-26)', async () => {
    // Round 1 #5 originally marked v6-from-legacy as invalid. Softened
    // per dogfood: the model still carries ~27 real features from
    // explicit feedback; the 5 retrieval features are zero-fills. Let
    // it serve and compete via the ship-gate.
    await writeActiveClosestVisitRankerRevision(vaultRoot, {
      revisionId: 'legacy-v6',
      modelVersion: RANKER_MODEL_VERSION,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      trainingDatasetHash: 'b'.repeat(64),
      trainedAt: Date.parse('2026-05-16T13:10:00.000Z'),
      trainedFromImpressions: false,
      modelBytes: new ArrayBuffer(4),
    });

    const health = await collectWorkGraphHealth({
      vaultRoot,
      now: () => new Date('2026-05-16T13:15:00.000Z'),
    });

    expect(health.ranker.loadStatus).toBe('ready');
    expect(health.ranker.loadReason).toBeNull();
  });

  it('compares retrain freshness against the unexpanded event-sourced label dataset', async () => {
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

    const feedback = projectFeedback([rejectedAgainstWorkstream]);
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
    expect(health.ranker.retrainSkipReason).toBe('insufficient_groups');
    expect(health.ranker.expandedNegativeCount).toBe(0);
    expect(health.ranker.labelDriftWithoutFeedback).toBe(0);
    expect(health.ranker.trainingMix).toMatchObject({
      positivesAtTrain: 0,
      userFeedbackNegativesAtTrain: 1,
    });
  });

  it('surfaces the rejected-relation count in the label-channels diagnostics (Move 2b)', async () => {
    const peerReplicaId = '33333333-3333-4333-8333-333333333333';
    let seq = 0;
    const eventLog = createEventLog(vaultRoot, {
      replicaId: '44444444-4444-4444-8444-444444444444',
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
    const rejectedRelation: AcceptedEvent = {
      clientEventId: 'client-rejected-relation-1',
      dot: { replicaId: peerReplicaId, seq: 1 },
      deps: {},
      aggregateId: 'feedback:rejected-relation:https://example.test/a:https://example.test/b',
      type: USER_REJECTED_RELATION,
      payload: {
        payloadVersion: 1,
        fromRef: 'https://example.test/a',
        toRef: 'https://example.test/b',
        surface: 'connections',
        reason: 'not-related',
      },
      acceptedAtMs: Date.parse('2026-05-16T14:00:00.000Z'),
    };
    await eventLog.importPeerEvent(rejectedRelation);

    const health = await collectWorkGraphHealth({
      vaultRoot,
      eventLog,
      now: () => new Date('2026-05-16T14:02:00.000Z'),
    });

    expect(health.labelChannels.rejectedRelations.count).toBe(1);
    expect(health.labelChannels.rejectedRelations.bySurface).toEqual({ connections: 1 });
    // Weak-negative densification defaults ON (SIDETRACK_RANKER_WEAK_NEGATIVES).
    expect(health.labelChannels.weakNegativesEnabled).toBe(true);
  });

  describe('shipGateV2 serving-gate enforcement + shadow-diff (read-back)', () => {
    const priorServeV6 = process.env['SIDETRACK_RANKER_SERVE_V6'];
    const priorLegacy = process.env['SIDETRACK_RECALL_LEARNED_RERANK'];

    const impressionMetrics = (
      overrides: Partial<ImpressionMetrics> = {},
    ): ImpressionMetrics => ({
      nDcgAt5: 0.5,
      nDcgAt10: 0.5,
      mrr: 0.5,
      recallAt5: 0.5,
      recallAt10: 0.5,
      explicitRejectPrecision: 0.5,
      falsePositiveRateOnRejectedContexts: 0,
      impressionCount: 80,
      impressionsWithPositiveCount: 80,
      ...overrides,
    });

    const stats: RecallImpressionTrainingStats = {
      rawPositiveCount: 80,
      rawNegativeCount: 200,
      groupCount: 80,
      positiveGroupCount: 80,
      groupCountWithPositives: 80,
      avgCandidatesPerGroup: 4,
      positivesPerGroup: 1,
      explicitRejectsPerGroup: 1,
      unjudgedCandidatesPerGroup: 2,
      candidateSourceDistribution: {},
    };

    // A real PASS decision from the gate machinery (do not re-derive the
    // gate — feed it metrics that clear every check).
    const passingDecision = shipGateV2Decide({
      activeMetrics: impressionMetrics({ nDcgAt10: 0.62, mrr: 0.62 }),
      baselineMetrics: impressionMetrics({ nDcgAt10: 0.5, mrr: 0.5 }),
      expandedNegativeCount: 0,
      labelDriftWithoutFeedback: 0,
      reservedTestUsedExactlyOnce: true,
    });

    beforeEach(() => {
      __resetRankerShadowDiffForTests();
      delete process.env['SIDETRACK_RANKER_SERVE_V6'];
      delete process.env['SIDETRACK_RECALL_LEARNED_RERANK'];
    });
    afterEach(() => {
      __resetRankerShadowDiffForTests();
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restore('SIDETRACK_RANKER_SERVE_V6', priorServeV6);
      restore('SIDETRACK_RECALL_LEARNED_RERANK', priorLegacy);
    });

    it('gate PASSES but is INERT by default (flag off): servingGateEnforced=false', async () => {
      expect(passingDecision.status).toBe('pass');
      await writeRecallImpressionRetrainState(vaultRoot, {
        schemaVersion: 1,
        status: 'promoted',
        revisionId: 'rev-v6-passing',
        updatedAt: Date.parse('2026-05-16T15:00:00.000Z'),
        stats,
        shipGateDecision: passingDecision,
      });

      const health = await collectWorkGraphHealth({
        vaultRoot,
        now: () => new Date('2026-05-16T15:05:00.000Z'),
      });

      expect(health.ranker.shipGateV2?.status).toBe('pass');
      // Earned-but-inert: the flag is off, so serving still uses the baseline.
      expect(health.ranker.shipGateV2?.servingGateEnforced).toBe(false);
      // No request recorded a shadow sample yet.
      expect(health.ranker.shipGateV2?.shadowDiff).toBeNull();
    });

    it('flips servingGateEnforced=true and reads back the shadow-diff window', async () => {
      process.env['SIDETRACK_RANKER_SERVE_V6'] = '1';
      await writeRecallImpressionRetrainState(vaultRoot, {
        schemaVersion: 1,
        status: 'promoted',
        revisionId: 'rev-v6-passing',
        updatedAt: Date.parse('2026-05-16T15:00:00.000Z'),
        stats,
        shipGateDecision: passingDecision,
      });

      // Two /v2 requests recorded divergence into the in-process window.
      recordRankerShadowDiff(vaultRoot, ['a', 'b', 'c'], ['a', 'b', 'c'], 1_000);
      recordRankerShadowDiff(vaultRoot, ['a', 'b', 'c'], ['c', 'b', 'a'], 2_000);

      const health = await collectWorkGraphHealth({
        vaultRoot,
        now: () => new Date('2026-05-16T15:05:00.000Z'),
      });

      expect(health.ranker.shipGateV2?.status).toBe('pass');
      // Flag on + gate passed → serving now uses v6.
      expect(health.ranker.shipGateV2?.servingGateEnforced).toBe(true);
      // The rolling window is surfaced back to the health reader.
      expect(health.ranker.shipGateV2?.shadowDiff?.requests).toBe(2);
      expect(health.ranker.shipGateV2?.shadowDiff?.meanTopKOverlap).toBe(1);
      expect(health.ranker.shipGateV2?.shadowDiff?.meanKendallTau).toBe(0);
      expect(health.ranker.shipGateV2?.shadowDiff?.lastComputedAt).toBe(
        new Date(2_000).toISOString(),
      );
    });

    it('does NOT enforce when the gate FAILS even with the flag on', async () => {
      process.env['SIDETRACK_RANKER_SERVE_V6'] = '1';
      const failingDecision = shipGateV2Decide({
        activeMetrics: impressionMetrics({ nDcgAt10: 0.4, mrr: 0.4 }),
        baselineMetrics: impressionMetrics({ nDcgAt10: 0.5, mrr: 0.5 }),
        expandedNegativeCount: 0,
        labelDriftWithoutFeedback: 0,
        reservedTestUsedExactlyOnce: true,
      });
      expect(failingDecision.status).toBe('fail');
      await writeRecallImpressionRetrainState(vaultRoot, {
        schemaVersion: 1,
        status: 'ship_gate_failed',
        revisionId: 'rev-v6-failing',
        updatedAt: Date.parse('2026-05-16T15:00:00.000Z'),
        stats,
        shipGateDecision: failingDecision,
      });

      const health = await collectWorkGraphHealth({
        vaultRoot,
        now: () => new Date('2026-05-16T15:05:00.000Z'),
      });

      expect(health.ranker.shipGateV2?.status).toBe('fail');
      // Flag on but gate failed → automatic fallback, enforcement stays false.
      expect(health.ranker.shipGateV2?.servingGateEnforced).toBe(false);
    });

    it('withLiveShipGateV2Serving overlays live enforcement + shadow-diff onto a frozen (artifact) report', async () => {
      // Collect a report with the flag OFF and no shadow samples — this is the
      // shape the drain-time artifact would freeze.
      await writeRecallImpressionRetrainState(vaultRoot, {
        schemaVersion: 1,
        status: 'promoted',
        revisionId: 'rev-v6-passing',
        updatedAt: Date.parse('2026-05-16T15:00:00.000Z'),
        stats,
        shipGateDecision: passingDecision,
      });
      const frozen = await collectWorkGraphHealth({
        vaultRoot,
        now: () => new Date('2026-05-16T15:05:00.000Z'),
      });
      expect(frozen.ranker.shipGateV2?.servingGateEnforced).toBe(false);
      expect(frozen.ranker.shipGateV2?.shadowDiff).toBeNull();

      // Now the env flips on and requests record divergence — the artifact
      // path must reflect this WITHOUT a recompute.
      process.env['SIDETRACK_RANKER_SERVE_V6'] = '1';
      recordRankerShadowDiff(vaultRoot, ['a', 'b'], ['b', 'a'], 5_000);
      const live = withLiveShipGateV2Serving(frozen, vaultRoot);

      expect(live.ranker.shipGateV2?.servingGateEnforced).toBe(true);
      expect(live.ranker.shipGateV2?.shadowDiff?.requests).toBe(1);
      // The rest of the report is preserved (same status/revision).
      expect(live.ranker.shipGateV2?.status).toBe('pass');
      expect(live.ranker.shipGateV2?.revisionId).toBe('rev-v6-passing');
    });
  });
});
