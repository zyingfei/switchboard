import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore, type ConnectionsSnapshot } from '../../connections/snapshot.js';
import type { VisitSimilarityEmbedder } from '../../connections/visitSimilarity.js';
import { activeClosestVisitRevisionManifestPath } from '../../producers/closest-visit-revision.js';
import { FEATURE_SCHEMA_VERSION } from '../../ranker/feature-schema.js';
import type { LightGBMModel, RankerContributions } from '../../ranker/predict.js';
import { RANKER_MODEL_VERSION } from '../../ranker/train.js';
import { collectWorkGraphHealth } from '../../system/workGraphHealth.js';
import { ENGAGEMENT_SESSION_AGGREGATED } from '../../engagement/events.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import {
  TOPIC_HDBSCAN_REVISION_KEY,
  TOPIC_UNION_FIND_REVISION_KEY,
  createTopicRevisionStore,
  type TopicRevision,
} from '../../producers/topic-revision.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';

const buildEvent = (input: { seq: number; type: string; payload: unknown }): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: Date.parse('2026-05-07T10:00:00.000Z') + input.seq * 1000,
});

const unit = (values: readonly number[]): Float32Array => {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return Float32Array.from(values.map((value) => value / norm));
};

const keyFromEmbeddingText = (text: string): string => {
  const corpus = text.replace(/^(?:passage|query):\s+/u, '');
  return corpus.split(/\s+/u)[0] ?? '';
};

const embedFromVectors =
  (vectors: ReadonlyMap<string, Float32Array>): VisitSimilarityEmbedder =>
  (texts) =>
    Promise.resolve().then(() =>
      texts.map((text) => {
        const key = keyFromEmbeddingText(text);
        const vector = vectors.get(key);
        if (vector === undefined) {
          throw new Error(`missing vector for ${key}`);
        }
        return vector;
      }),
    );

const noRetrain = () =>
  Promise.resolve({
    status: 'skipped' as const,
    reason: 'below-threshold' as const,
    fingerprint: {
      hash: '0'.repeat(64),
      labelCount: 0,
      positiveLabelCount: 0,
      negativeLabelCount: 0,
    },
    newLabelCount: 0,
  });

const rankerContributions = (weight: number): RankerContributions => ({
  schemaVersion: 0,
  same_workstream: 0,
  opener_chain_depth: 0,
  in_navigation_chain: 0,
  same_canonical_url: 0,
  same_host: weight,
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
  same_active_topic: 0,
  topic_lineage_merge_split_related: 0,
  page_quality_tier_from: 0,
  page_quality_tier_to: 0,
});

const timelineObservedEvent = (input: {
  readonly seq: number;
  readonly slug: string;
  readonly observedAt: string;
}): AcceptedEvent =>
  buildEvent({
    seq: input.seq,
    type: BROWSER_TIMELINE_OBSERVED,
    payload: {
      eventId: `timeline-${input.slug}`,
      observedAt: input.observedAt,
      url: `https://ranker.test/${input.slug}`,
      canonicalUrl: `https://ranker.test/${input.slug}`,
      title: `ranker ${input.slug}`,
      provider: 'generic',
      transition: 'activated',
      payloadVersion: 1,
      dimensions: { engagement: { focusedWindowMs: 10_000 } },
    },
  });

const createRecordingStore = (
  root: string,
): {
  readonly store: ReturnType<typeof createConnectionsStore>;
  readonly writes: ConnectionsSnapshot[];
} => {
  const base = createConnectionsStore(root);
  const writes: ConnectionsSnapshot[] = [];
  return {
    writes,
    store: {
      ...base,
      putCurrent: async (snapshot) => {
        writes.push(snapshot);
        await base.putCurrent(snapshot);
      },
    },
  };
};

const writeStaleV1RankerManifest = async (root: string): Promise<void> => {
  const manifestPath = activeClosestVisitRevisionManifestPath(root);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        revisionId: 'ranker-rev-v1',
        modelVersion: 'lightgbm-lambdamart-v1',
        featureSchemaVersion: 1,
        trainingDatasetHash: 'a'.repeat(64),
        trainedAt: Date.parse('2026-05-01T00:00:00.000Z'),
        modelByteLength: 0,
        modelSha256: 'b'.repeat(64),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('connectionsMaterializer (Class B, consumer-only)', () => {
  let vaultRoot: string;
  // The idf-rkn-split shadow clustering is now ON by default. These
  // tests assert the baseline active-revision behavior (union-find /
  // HDBSCAN selection / skip-gate), so default the suite to the
  // baseline; the shadow-specific test opts back in explicitly.
  let prevShadowFlag: string | undefined;
  let prevSkipRankerSnapshot: string | undefined;
  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-connections-mat-'));
    prevShadowFlag = process.env['SIDETRACK_TOPIC_SHADOW_CANDIDATE'];
    prevSkipRankerSnapshot = process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
    process.env['SIDETRACK_TOPIC_SHADOW_CANDIDATE'] = 'off';
    delete process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
    if (prevShadowFlag === undefined) delete process.env['SIDETRACK_TOPIC_SHADOW_CANDIDATE'];
    else process.env['SIDETRACK_TOPIC_SHADOW_CANDIDATE'] = prevShadowFlag;
    if (prevSkipRankerSnapshot === undefined) delete process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
    else process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = prevSkipRankerSnapshot;
  });

  it('catchUp rebuilds the snapshot from event log alone (replay-recoverable)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        type: THREAD_UPSERTED,
        payload: {
          bac_id: 'thread_a',
          provider: 'chatgpt',
          threadUrl: 'https://x/a',
          title: 'A',
          lastSeenAt: '2026-05-07T10:00:00.000Z',
          tags: [],
          primaryWorkstreamId: 'ws_x',
        },
      }),
    );

    await m.catchUp(eventLog);
    await m.awaitIdle();

    const snap = await store.readCurrent();
    expect(snap, 'current snapshot written').not.toBeNull();
    if (snap === null) throw new Error('current snapshot written');
    const ids = snap.nodes.map((n) => n.id);
    expect(ids).toContain('thread:thread_a');
    expect(ids).toContain('workstream:ws_x');
    expect(snap.edges.find((e) => e.kind === 'thread_in_workstream')).toBeDefined();
    expect(m.health().status).toBe('healthy');
  });

  it('runs visitSimilarity before snapshot and persists the active revision', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const embed = embedFromVectors(
      new Map<string, Float32Array>([
        ['visit-alpha', unit([1, 0])],
        ['visit-bravo', unit([1, 0])],
      ]),
    );
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store, embed });

    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-alpha',
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://example.test/alpha',
          canonicalUrl: 'https://example.test/alpha',
          title: 'visit-alpha',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 2,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-bravo',
          observedAt: '2026-05-07T10:05:00.000Z',
          url: 'https://example.test/bravo',
          canonicalUrl: 'https://example.test/bravo',
          title: 'visit-bravo',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );

    await m.catchUp(eventLog);
    await m.awaitIdle();

    const snap = await store.readCurrent();
    expect(snap).not.toBeNull();
    const edge = snap?.edges.find((candidate) => candidate.kind === 'visit_resembles_visit');
    expect(edge).toBeDefined();
    expect(edge?.fromNodeId).toBe('timeline-visit:https://example.test/alpha');
    expect(edge?.toNodeId).toBe('timeline-visit:https://example.test/bravo');
    expect(edge?.confidence).toBe('inferred');
    expect(edge?.producedBy.source).toBe('visit-similarity');
    const revisionId =
      edge?.producedBy.source === 'visit-similarity' ? edge.producedBy.revisionId : undefined;
    expect(revisionId).toMatch(/^[a-f0-9]{16}$/u);
    if (revisionId === undefined) throw new Error('missing visit-similarity revision id');
    const revisionRaw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'visit-similarity', `${revisionId}.json`),
      'utf8',
    );
    expect(revisionRaw).toContain(`"revisionId": "${revisionId}"`);
    const topicRevision = await createTopicRevisionStore(vaultRoot).readActiveRevision();
    expect(topicRevision?.algorithmVersion).toBe(TOPIC_UNION_FIND_REVISION_KEY);
    expect(m.health().status).toBe('healthy');
  });

  it('skips ranker-augmented snapshot when SIDETRACK_SKIP_RANKER_SNAPSHOT=1 and reports it', async () => {
    process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = '1';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const { store, writes } = createRecordingStore(vaultRoot);
    const embed = embedFromVectors(
      new Map<string, Float32Array>([
        ['ranker', unit([1, 0])],
        ['ranker', unit([1, 0])],
      ]),
    );
    let loaderCalls = 0;
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed,
      rankerRetrainer: noRetrain,
      closestVisitRankerLoader: () => {
        loaderCalls += 1;
        return Promise.resolve({
          status: 'missing',
          activeRevisionId: null,
          reason: 'no-active-manifest',
        });
      },
    });

    await eventLog.importPeerEvent(
      timelineObservedEvent({
        seq: 1,
        slug: 'alpha',
        observedAt: '2026-05-07T10:00:00.000Z',
      }),
    );
    await eventLog.importPeerEvent(
      timelineObservedEvent({
        seq: 2,
        slug: 'bravo',
        observedAt: '2026-05-07T10:05:00.000Z',
      }),
    );

    await m.catchUp(eventLog);
    await m.awaitIdle();

    expect(loaderCalls).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.edges.some((edge) => edge.kind === 'closest_visit')).toBe(false);
    const diagnosticsRaw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      'utf8',
    );
    const diagnostics = JSON.parse(diagnosticsRaw) as {
      readonly rankerAugmentation?: {
        readonly status?: string;
        readonly reason?: string;
        readonly activeModelVersion?: string | null;
        readonly expectedModelVersion?: string;
        readonly activeFeatureSchemaVersion?: number | null;
        readonly expectedFeatureSchemaVersion?: number;
        readonly needsRetrain?: boolean;
        readonly closestVisitEdgeCount?: number;
        readonly rankerSourceEdgeCount?: number;
      };
    };
    expect(diagnostics.rankerAugmentation).toMatchObject({
      status: 'skipped',
      reason: 'SIDETRACK_SKIP_RANKER_SNAPSHOT=1',
      activeModelVersion: null,
      expectedModelVersion: RANKER_MODEL_VERSION,
      activeFeatureSchemaVersion: null,
      expectedFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
      needsRetrain: false,
      closestVisitEdgeCount: 0,
      rankerSourceEdgeCount: 0,
    });
    expect(m.health().status).toBe('healthy');
  });

  it('publishes the base snapshot first, then emits closest_visit with an active ranker', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const { store, writes } = createRecordingStore(vaultRoot);
    const embed = embedFromVectors(
      new Map<string, Float32Array>([
        ['ranker', unit([1, 0])],
        ['ranker', unit([1, 0])],
      ]),
    );
    let disposeCalls = 0;
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed,
      rankerRetrainer: noRetrain,
      closestVisitRankerLoader: () =>
        Promise.resolve({
          status: 'ready',
          activeRevisionId: 'ranker-rev-test',
          model: {
            dispose: () => {
              disposeCalls += 1;
            },
          } as LightGBMModel,
          ranker: {
            revisionId: 'ranker-rev-test',
            threshold: 0.1,
            topK: 1,
            predict: () => ({ score: 0.9, contributions: rankerContributions(0.5) }),
          },
        }),
    });

    await eventLog.importPeerEvent(
      timelineObservedEvent({
        seq: 1,
        slug: 'alpha',
        observedAt: '2026-05-07T10:00:00.000Z',
      }),
    );
    await eventLog.importPeerEvent(
      timelineObservedEvent({
        seq: 2,
        slug: 'bravo',
        observedAt: '2026-05-07T10:05:00.000Z',
      }),
    );

    await m.catchUp(eventLog);
    await m.awaitIdle();

    expect(writes).toHaveLength(2);
    expect(writes[0]?.edges.some((edge) => edge.kind === 'closest_visit')).toBe(false);
    const closestVisitEdges =
      writes[1]?.edges.filter((edge) => edge.kind === 'closest_visit') ?? [];
    expect(closestVisitEdges.length).toBeGreaterThan(0);
    expect(
      closestVisitEdges.every(
        (edge) =>
          edge.producedBy.source === 'ranker' && edge.producedBy.revisionId === 'ranker-rev-test',
      ),
    ).toBe(true);
    expect(disposeCalls).toBe(1);
    const diagnosticsRaw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      'utf8',
    );
    const diagnostics = JSON.parse(diagnosticsRaw) as {
      readonly rankerAugmentation?: {
        readonly status?: string;
        readonly activeRevisionId?: string;
        readonly activeModelVersion?: string | null;
        readonly expectedModelVersion?: string;
        readonly activeFeatureSchemaVersion?: number | null;
        readonly expectedFeatureSchemaVersion?: number;
        readonly needsRetrain?: boolean;
        readonly modelFreshness?: string;
        readonly closestVisitEdgeCount?: number;
        readonly rankerSourceEdgeCount?: number;
      };
    };
    expect(diagnostics.rankerAugmentation).toMatchObject({
      status: 'emitted',
      activeRevisionId: 'ranker-rev-test',
      activeModelVersion: RANKER_MODEL_VERSION,
      expectedModelVersion: RANKER_MODEL_VERSION,
      activeFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
      expectedFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
      needsRetrain: false,
      modelFreshness: 'fresh',
      closestVisitEdgeCount: closestVisitEdges.length,
      rankerSourceEdgeCount: closestVisitEdges.length,
    });
  });

  it('reports stale-model-schema and needsRetrain when the active manifest is v1 under the v2 runtime', async () => {
    await writeStaleV1RankerManifest(vaultRoot);
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const { store, writes } = createRecordingStore(vaultRoot);
    const embed = embedFromVectors(
      new Map<string, Float32Array>([
        ['ranker', unit([1, 0])],
        ['ranker', unit([1, 0])],
      ]),
    );
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed,
      rankerRetrainer: noRetrain,
    });

    await eventLog.importPeerEvent(
      timelineObservedEvent({
        seq: 1,
        slug: 'alpha',
        observedAt: '2026-05-07T10:00:00.000Z',
      }),
    );
    await eventLog.importPeerEvent(
      timelineObservedEvent({
        seq: 2,
        slug: 'bravo',
        observedAt: '2026-05-07T10:05:00.000Z',
      }),
    );

    await m.catchUp(eventLog);
    await m.awaitIdle();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.edges.some((edge) => edge.kind === 'closest_visit')).toBe(false);
    const diagnosticsRaw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      'utf8',
    );
    const diagnostics = JSON.parse(diagnosticsRaw) as {
      readonly ranker?: {
        readonly status?: string;
      };
      readonly rankerAugmentation?: {
        readonly status?: string;
        readonly reason?: string;
        readonly activeRevisionId?: string | null;
        readonly activeModelVersion?: string | null;
        readonly expectedModelVersion?: string;
        readonly activeFeatureSchemaVersion?: number | null;
        readonly expectedFeatureSchemaVersion?: number;
        readonly needsRetrain?: boolean;
      };
    };
    expect(diagnostics.ranker?.status).toBe('skipped');
    expect(diagnostics.rankerAugmentation).toMatchObject({
      status: 'absent',
      reason: 'stale-model-schema',
      activeRevisionId: 'ranker-rev-v1',
      activeModelVersion: 'lightgbm-lambdamart-v1',
      expectedModelVersion: RANKER_MODEL_VERSION,
      activeFeatureSchemaVersion: 1,
      expectedFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
      needsRetrain: true,
    });
    const health = await collectWorkGraphHealth({ vaultRoot, eventLog });
    expect(health.ranker).toMatchObject({
      activeRevisionId: 'ranker-rev-v1',
      loadStatus: 'invalid-model',
      activeModelVersion: 'lightgbm-lambdamart-v1',
      expectedModelVersion: RANKER_MODEL_VERSION,
      activeFeatureSchemaVersion: 1,
      expectedFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
      needsRetrain: true,
      augmentation: {
        status: 'absent',
        reason: 'stale-model-schema',
        needsRetrain: true,
      },
    });
  });

  it('does not crash when the active ranker manifest is missing and reports absence', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const { store, writes } = createRecordingStore(vaultRoot);
    const embed = embedFromVectors(
      new Map<string, Float32Array>([
        ['ranker', unit([1, 0])],
        ['ranker', unit([1, 0])],
      ]),
    );
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed,
      rankerRetrainer: noRetrain,
    });

    await eventLog.importPeerEvent(
      timelineObservedEvent({
        seq: 1,
        slug: 'alpha',
        observedAt: '2026-05-07T10:00:00.000Z',
      }),
    );
    await eventLog.importPeerEvent(
      timelineObservedEvent({
        seq: 2,
        slug: 'bravo',
        observedAt: '2026-05-07T10:05:00.000Z',
      }),
    );

    await m.catchUp(eventLog);
    await m.awaitIdle();

    expect(m.health().status).toBe('healthy');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.edges.some((edge) => edge.kind === 'closest_visit')).toBe(false);
    const diagnosticsRaw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
      'utf8',
    );
    const diagnostics = JSON.parse(diagnosticsRaw) as {
      readonly rankerAugmentation?: {
        readonly status?: string;
        readonly reason?: string;
        readonly activeModelVersion?: string | null;
        readonly expectedModelVersion?: string;
        readonly activeFeatureSchemaVersion?: number | null;
        readonly expectedFeatureSchemaVersion?: number;
        readonly needsRetrain?: boolean;
      };
    };
    expect(diagnostics.rankerAugmentation).toMatchObject({
      status: 'absent',
      reason: 'no-active-manifest',
      activeModelVersion: null,
      expectedModelVersion: RANKER_MODEL_VERSION,
      activeFeatureSchemaVersion: null,
      expectedFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
      needsRetrain: false,
    });
  });

  it('uses accumulated engagement aggregates for the topic gate', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const embed = embedFromVectors(
      new Map<string, Float32Array>([
        ['visit-alpha', unit([1, 0])],
        ['visit-bravo', unit([1, 0])],
      ]),
    );
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store, embed });

    for (const [seq, key] of [
      [1, 'alpha'],
      [2, 'bravo'],
    ] as const) {
      await eventLog.importPeerEvent(
        buildEvent({
          seq,
          type: BROWSER_TIMELINE_OBSERVED,
          payload: {
            eventId: `timeline-${key}`,
            observedAt: `2026-05-07T10:0${String(seq)}:00.000Z`,
            url: `https://example.test/${key}`,
            canonicalUrl: `https://example.test/${key}`,
            title: `visit-${key}`,
            provider: 'generic',
            transition: 'activated',
            payloadVersion: 1,
            dimensions: { engagement: { focusedWindowMs: 1_000 } },
          },
        }),
      );
      for (const offset of [10, 20] as const) {
        await eventLog.importPeerEvent(
          buildEvent({
            seq: seq + offset,
            type: ENGAGEMENT_SESSION_AGGREGATED,
            payload: {
              payloadVersion: 1,
              visitId: `visit:https://example.test/${key}`,
              sessionId: 'session:reused-edge',
              dimensions: {
                engagement: {
                  activeMs: 3_000,
                  visibleMs: 3_000,
                  focusedWindowMs: 3_000,
                  idleMs: 0,
                  foregroundBursts: 1,
                  returnCount: 0,
                  scrollEvents: 0,
                  maxScrollRatio: 0,
                  copyCount: 0,
                  pasteCount: 0,
                },
              },
            },
          }),
        );
      }
    }

    await m.catchUp(eventLog);
    await m.awaitIdle();

    const snap = await store.readCurrent();
    expect(snap?.edges.find((edge) => edge.kind === 'visit_resembles_visit')).toBeDefined();
    const topicRevision = await createTopicRevisionStore(vaultRoot).readActiveRevision();
    expect(topicRevision?.topics[0]?.memberCanonicalUrls).toEqual([
      'https://example.test/alpha',
      'https://example.test/bravo',
    ]);
  });

  it('writes the idf-rkn-split shadow topic revision behind the env flag', async () => {
    const previousFlag = process.env['SIDETRACK_TOPIC_SHADOW_CANDIDATE'];
    process.env['SIDETRACK_TOPIC_SHADOW_CANDIDATE'] = 'idf-rkn-split';
    try {
      const replica = await loadOrCreateReplica(vaultRoot);
      const eventLog = createEventLog(vaultRoot, replica);
      const timelineStore = createTimelineStore(vaultRoot);
      const store = createConnectionsStore(vaultRoot);
      const embed = embedFromVectors(
        new Map<string, Float32Array>([
          ['visit-alpha', unit([1, 0])],
          ['visit-bravo', unit([1, 0])],
        ]),
      );
      const m = createConnectionsMaterializer({
        vaultRoot,
        eventLog,
        timelineStore,
        store,
        embed,
      });

      await eventLog.importPeerEvent(
        buildEvent({
          seq: 1,
          type: BROWSER_TIMELINE_OBSERVED,
          payload: {
            eventId: 'timeline-alpha',
            observedAt: '2026-05-07T10:00:00.000Z',
            url: 'https://example.test/alpha',
            canonicalUrl: 'https://example.test/alpha',
            title: 'visit-alpha',
            provider: 'generic',
            transition: 'activated',
            payloadVersion: 1,
            dimensions: { engagement: { focusedWindowMs: 10_000 } },
          },
        }),
      );
      await eventLog.importPeerEvent(
        buildEvent({
          seq: 2,
          type: BROWSER_TIMELINE_OBSERVED,
          payload: {
            eventId: 'timeline-bravo',
            observedAt: '2026-05-07T10:05:00.000Z',
            url: 'https://example.test/bravo',
            canonicalUrl: 'https://example.test/bravo',
            title: 'visit-bravo',
            provider: 'generic',
            transition: 'activated',
            payloadVersion: 1,
            dimensions: { engagement: { focusedWindowMs: 10_000 } },
          },
        }),
      );

      await m.catchUp(eventLog);
      await m.awaitIdle();

      const shadowRaw = await readFile(
        join(vaultRoot, '_BAC', 'connections', 'topics', 'current.shadow.json'),
        'utf8',
      );
      expect(JSON.parse(shadowRaw)).toMatchObject({
        algorithmVersion: 'topic-revision:shadow:idf-rkn-split',
        topics: [
          expect.objectContaining({ metadata: expect.objectContaining({ memberCount: 2 }) }),
        ],
      });
      const diagnosticsRaw = await readFile(
        join(vaultRoot, '_BAC', 'connections', 'diagnostics', 'latest.json'),
        'utf8',
      );
      expect(JSON.parse(diagnosticsRaw).shadowVsBaseline).toMatchObject({
        candidate: 'idf-rkn-split',
        workstreamHardUnionEdgesRemoved: 0,
      });
    } finally {
      if (previousFlag === undefined) delete process.env['SIDETRACK_TOPIC_SHADOW_CANDIDATE'];
      else process.env['SIDETRACK_TOPIC_SHADOW_CANDIDATE'] = previousFlag;
    }
  });

  it('can select the HDBSCAN topic revision builder by revision key', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const embed = embedFromVectors(
      new Map<string, Float32Array>([
        ['visit-alpha', unit([1, 0])],
        ['visit-bravo', unit([1, 0])],
      ]),
    );
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed,
      topicRevisionAlgorithm: TOPIC_HDBSCAN_REVISION_KEY,
    });

    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-alpha',
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://example.test/alpha',
          canonicalUrl: 'https://example.test/alpha',
          title: 'visit-alpha',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 2,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-bravo',
          observedAt: '2026-05-07T10:05:00.000Z',
          url: 'https://example.test/bravo',
          canonicalUrl: 'https://example.test/bravo',
          title: 'visit-bravo',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );

    await m.catchUp(eventLog);
    await m.awaitIdle();

    const topicRevision = await createTopicRevisionStore(vaultRoot).readActiveRevision();
    expect(topicRevision?.algorithmVersion).toBe(TOPIC_HDBSCAN_REVISION_KEY);
    expect(m.health().status).toBe('healthy');
  });

  it('onAccepted with a handled event triggers drain that writes the snapshot', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    const event = buildEvent({
      seq: 1,
      type: THREAD_UPSERTED,
      payload: {
        bac_id: 'thread_b',
        provider: 'chatgpt',
        threadUrl: 'https://x/b',
        title: 'B',
        lastSeenAt: '2026-05-07T11:00:00.000Z',
        tags: [],
      },
    });
    await eventLog.importPeerEvent(event);
    m.onAccepted(event, { origin: 'peer' });
    await m.awaitIdle();

    const snap = await store.readCurrent();
    expect(snap?.nodes.find((n) => n.id === 'thread:thread_b')).toBeDefined();
  });

  it('onAccepted with a non-handled event type is a no-op (does not flag dirty)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    m.onAccepted(
      {
        clientEventId: 'unrelated',
        dot: { replicaId: 'r', seq: 1 },
        deps: {},
        aggregateId: 'something',
        type: 'unrelated.event',
        payload: { ignored: true },
        acceptedAtMs: 0,
      },
      { origin: 'peer' },
    );
    await m.awaitIdle();

    const snap = await store.readCurrent();
    // Materializer never ran (no handled events) — no snapshot file.
    expect(snap).toBeNull();
  });

  it('bursts coalesce — multiple onAccepted calls produce a single drain pass', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    for (let i = 1; i <= 5; i += 1) {
      const event = buildEvent({
        seq: i,
        type: THREAD_UPSERTED,
        payload: {
          bac_id: `thread_${String(i)}`,
          provider: 'chatgpt',
          threadUrl: `https://x/${String(i)}`,
          title: `t${String(i)}`,
          lastSeenAt: `2026-05-07T${String(i + 9).padStart(2, '0')}:00:00.000Z`,
          tags: [],
        },
      });
      await eventLog.importPeerEvent(event);
      m.onAccepted(event, { origin: 'peer' });
    }
    await m.awaitIdle();

    const snap = await store.readCurrent();
    expect(snap).not.toBeNull();
    // Five threads were imported; the final snapshot must include
    // all of them.
    for (let i = 1; i <= 5; i += 1) {
      expect(snap?.nodes.map((n) => n.id)).toContain(`thread:thread_${String(i)}`);
    }
  });

  it('catchUp bypasses failure cooldown (recovery path)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    let calls = 0;
    const store = {
      putCurrent: (snapshot: ConnectionsSnapshot): Promise<void> => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('disk full'));
        void snapshot;
        return Promise.resolve();
      },
      readCurrent: () => Promise.resolve(null),
      putDay: () => Promise.resolve(undefined),
      readDay: () => Promise.resolve(null),
      listDays: () => Promise.resolve([]),
    };
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    const event = buildEvent({
      seq: 1,
      type: THREAD_UPSERTED,
      payload: {
        bac_id: 'thread_a',
        provider: 'chatgpt',
        threadUrl: 'https://x/a',
        title: 'A',
        lastSeenAt: '2026-05-07T10:00:00.000Z',
        tags: [],
      },
    });
    await eventLog.importPeerEvent(event);
    m.onAccepted(event, { origin: 'peer' });
    // Stage 5.2 W1a — drain is debounced; awaitIdle waits through
    // debounce + the failing drain attempt that parks lastError.
    await m.awaitIdle();
    expect(m.health().status).toBe('failed');
    expect(m.health().lastError).toContain('disk full');

    // catchUp bypasses the failure cooldown and runs the next
    // putCurrent attempt (which succeeds in our stub). Health
    // returns to healthy.
    await m.catchUp(eventLog);
    await m.awaitIdle();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(m.health().status).toBe('healthy');
  });

  it('awaitIdle does not hang when a drain has parked the materializer in a failed state', async () => {
    // Regression for the dirty=true-after-failure trap. After a
    // failed drain the materializer leaves dirty=true so the next
    // trigger retries; if no further trigger arrives, dirty stays
    // true forever and the failure cooldown blocks the SW-level
    // retry. A naive `while (running || dirty)` loop in awaitIdle
    // would wait forever even though work is permanently parked.
    // Updated awaitIdle treats lastError !== null + no in-flight
    // drain as idle so callers can fall through to health() and
    // surface 'failed' rather than hang.
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = {
      putCurrent: (snapshot: ConnectionsSnapshot): Promise<void> => {
        void snapshot;
        return Promise.reject(new Error('disk wedged'));
      },
      readCurrent: () => Promise.resolve(null),
      putDay: () => Promise.resolve(undefined),
      readDay: () => Promise.resolve(null),
      listDays: () => Promise.resolve([]),
    };
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    const event = buildEvent({
      seq: 1,
      type: THREAD_UPSERTED,
      payload: {
        bac_id: 'thread_a',
        provider: 'chatgpt',
        threadUrl: 'https://x/a',
        title: 'A',
        lastSeenAt: '2026-05-07T10:00:00.000Z',
        tags: [],
      },
    });
    await eventLog.importPeerEvent(event);
    m.onAccepted(event, { origin: 'peer' });

    // awaitIdle must resolve within a reasonable bound — the bug
    // would have it spin forever at 5 ms intervals waiting for
    // dirty to clear (which never happens without another trigger
    // because the failure cooldown blocks retries). Budget is the
    // drain debounce (1500 ms) + headroom; the assertion below
    // tightens that to "resolves before the budget" rather than a
    // fixed wall-clock number that would drift with the debounce.
    const budgetMs = 3_000;
    const start = Date.now();
    await Promise.race([
      m.awaitIdle(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`awaitIdle hung past ${String(budgetMs)} ms`));
        }, budgetMs);
      }),
    ]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(budgetMs);

    // health() reports the failure so callers know not to trust
    // the snapshot.
    const health = m.health();
    expect(health.status).toBe('failed');
    expect(health.lastError).toContain('disk wedged');
  });

  it('does not start a concurrent drain when an event arrives during catchUp', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    let calls = 0;
    let releaseFirstPut: (() => void) | undefined;
    let firstPutStartedResolve: (() => void) | undefined;
    const firstPutStarted = new Promise<void>((resolve) => {
      firstPutStartedResolve = resolve;
    });
    const store = {
      putCurrent: async (snapshot: ConnectionsSnapshot) => {
        void snapshot;
        calls += 1;
        if (calls === 1) {
          firstPutStartedResolve?.();
          await new Promise<void>((release) => {
            releaseFirstPut = release;
          });
        }
      },
      readCurrent: () => Promise.resolve(null),
      putDay: () => Promise.resolve(undefined),
      readDay: () => Promise.resolve(null),
      listDays: () => Promise.resolve([]),
    };
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    const first = buildEvent({
      seq: 1,
      type: THREAD_UPSERTED,
      payload: {
        bac_id: 'thread_a',
        provider: 'chatgpt',
        threadUrl: 'https://x/a',
        title: 'A',
        lastSeenAt: '2026-05-07T10:00:00.000Z',
        tags: [],
      },
    });
    await eventLog.importPeerEvent(first);
    const catchUp = m.catchUp(eventLog);
    await firstPutStarted;

    const second = buildEvent({
      seq: 2,
      type: THREAD_UPSERTED,
      payload: {
        bac_id: 'thread_b',
        provider: 'chatgpt',
        threadUrl: 'https://x/b',
        title: 'B',
        lastSeenAt: '2026-05-07T10:01:00.000Z',
        tags: [],
      },
    });
    await eventLog.importPeerEvent(second);
    m.onAccepted(second, { origin: 'peer' });

    await delay(1_700);
    expect(calls).toBe(1);
    releaseFirstPut?.();
    await catchUp;
    await m.awaitIdle();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(m.health().status).toBe('healthy');
  });

  // Stage 5.2 W3 — visit-similarity skip-gate. When the same set of
  // visits is processed twice, the second drain reads the cached
  // revision from disk instead of re-running embed (the most
  // expensive pass on the materializer's hot path).
  it('reuses an existing similarity revision when visit inputs are unchanged', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    let embedCalls = 0;
    const embed: VisitSimilarityEmbedder = (texts) => {
      embedCalls += 1;
      return Promise.resolve(texts.map(() => unit([1, 0])));
    };
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store, embed });

    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-alpha',
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://example.test/alpha',
          canonicalUrl: 'https://example.test/alpha',
          title: 'visit-alpha',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 2,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-bravo',
          observedAt: '2026-05-07T10:05:00.000Z',
          url: 'https://example.test/bravo',
          canonicalUrl: 'https://example.test/bravo',
          title: 'visit-bravo',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );

    // First drain populates the similarity revision (calls embed once
    // for the two passages).
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const firstCalls = embedCalls;
    expect(firstCalls).toBeGreaterThan(0);

    // Second drain over the same visit set: skip-gate hits, no
    // additional embed call.
    await m.catchUp(eventLog);
    await m.awaitIdle();
    expect(embedCalls).toBe(firstCalls);
  });

  it('handles set covers expected event types', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    const expected = [
      'thread.upserted',
      'workstream.upserted',
      'dispatch.recorded',
      'dispatch.linked',
      'queue.created',
      'annotation.created',
      'capture.recorded',
      'browser.timeline.observed',
    ];
    for (const t of expected) expect(m.handles.has(t)).toBe(true);
    expect(m.handles.has('unrelated.event')).toBe(false);
  });

  // Stage 5.2 W2b — high-frequency events that fold into the next
  // natural drain (engagement aggregates, visual fingerprints) MUST NOT
  // be in HANDLES, so they don't trigger their own per-event rebuild.
  it('engagement.session.aggregated is NOT in handles (deferred to next structural drain)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    expect(m.handles.has('engagement.session.aggregated')).toBe(false);
    expect(m.handles.has('visual.fingerprint.observed')).toBe(false);
  });

  it('engagement bursts do not trigger any drain (deferred until next structural event)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    let putCurrentCalls = 0;
    const store = {
      putCurrent: (snapshot: ConnectionsSnapshot): Promise<void> => {
        putCurrentCalls += 1;
        void snapshot;
        return Promise.resolve();
      },
      readCurrent: () => Promise.resolve(null),
      putDay: () => Promise.resolve(undefined),
      readDay: () => Promise.resolve(null),
      listDays: () => Promise.resolve([]),
    };
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    // Simulate 50 engagement aggregates arriving while a user reads a
    // page (every ~30s per tab × 4 tabs = these would have been 50
    // per-event drains pre-W2b). With W2b they trigger zero drains
    // because the materializer doesn't route the event type.
    for (let i = 1; i <= 50; i += 1) {
      const event = buildEvent({
        seq: i,
        type: 'engagement.session.aggregated',
        payload: {
          payloadVersion: 1,
          visitId: `visit-${String(i % 5)}`,
          sessionId: `session-${String(i)}`,
          dimensions: {
            engagement: {
              activeMs: 1000,
              visibleMs: 1000,
              focusedWindowMs: 1000,
              idleMs: 0,
              foregroundBursts: 1,
              returnCount: 0,
              scrollEvents: 0,
              maxScrollRatio: 0,
              copyCount: 0,
              pasteCount: 0,
            },
          },
        },
      });
      await eventLog.importPeerEvent(event);
      m.onAccepted(event, { origin: 'peer' });
    }
    await m.awaitIdle();

    // No drains — engagement events are not in HANDLES.
    expect(putCurrentCalls).toBe(0);
  });

  // Stage 5.2 W4 — topic-revision skip-gate. When the previous active
  // topic revision matches the id we'd derive from the current visit
  // similarity + threshold + algorithm, skip the union-find pass and
  // reuse it. Pairs with W3: when visit similarity cache-hits, topics
  // inherit the cache hit downstream.
  it('topic-revision skip-gate reuses the active revision when its id matches', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    let putActiveRevisionCalls = 0;
    const baseTopicStore = createTopicRevisionStore(vaultRoot);
    const topicRevisionStore = {
      ...baseTopicStore,
      putActiveRevision: async (revision: TopicRevision) => {
        putActiveRevisionCalls += 1;
        await baseTopicStore.putActiveRevision(revision);
      },
    };
    const embed = embedFromVectors(
      new Map<string, Float32Array>([
        ['visit-alpha', unit([1, 0])],
        ['visit-bravo', unit([1, 0])],
      ]),
    );
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed,
      topicRevisionStore,
    });

    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-alpha',
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://example.test/alpha',
          canonicalUrl: 'https://example.test/alpha',
          title: 'visit-alpha',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 2,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-bravo',
          observedAt: '2026-05-07T10:05:00.000Z',
          url: 'https://example.test/bravo',
          canonicalUrl: 'https://example.test/bravo',
          title: 'visit-bravo',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );

    // First drain produces the topic revision.
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const firstCalls = putActiveRevisionCalls;
    expect(firstCalls).toBeGreaterThanOrEqual(1);

    // Second drain with the same inputs hits the skip-gate — no new
    // topic revision written.
    await m.catchUp(eventLog);
    await m.awaitIdle();
    expect(putActiveRevisionCalls).toBe(firstCalls);
  });
});
