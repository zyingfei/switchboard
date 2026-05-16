import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENGAGEMENT_SESSION_AGGREGATED } from '../engagement/events.js';
import { USER_ORGANIZED_ITEM, type UserOrganizedItemPayload } from '../feedback/events.js';
import { FEATURE_SCHEMA_VERSION } from '../ranker/feature-schema.js';
import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../tabsession/events.js';
import type { RankerRetrainResult } from '../ranker/retrain.js';
import { RANKER_MODEL_VERSION } from '../ranker/train.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { URL_ATTRIBUTION_INFERRED } from '../urls/events.js';
import type { UrlProjection, UrlVisitRecord } from '../urls/projection.js';

import {
  attachDriftReport,
  collectMaterializerDiagnostics,
  createMaterializerDiagnosticsStore,
  summarizeMaterializerDiagnostics,
  type MaterializerDiagnostics,
  type MaterializerDiagnosticsInput,
} from './materializerDiagnostics.js';
import type { DriftStateStore, DriftPersistedState } from './drift/driftStateStore.js';
import type {
  ConnectionEdge,
  ConnectionNode,
  ConnectionsSnapshot,
  VisitSimilarityRevision,
} from './types.js';

const TIMESTAMP = '2026-05-10T00:00:00.000Z';
const ACCEPTED_AT_MS = Date.parse(TIMESTAMP);

const event = (
  overrides: Partial<AcceptedEvent> & {
    readonly type: AcceptedEvent['type'];
    readonly payload?: AcceptedEvent['payload'];
  },
): AcceptedEvent => ({
  clientEventId: overrides.clientEventId ?? `evt-${overrides.type}`,
  dot: overrides.dot ?? { replicaId: 'rep-1', seq: 1 },
  deps: overrides.deps ?? {},
  aggregateId: overrides.aggregateId ?? 'aggregate-1',
  type: overrides.type,
  payload: overrides.payload ?? {},
  acceptedAtMs: overrides.acceptedAtMs ?? ACCEPTED_AT_MS,
});

const organizedItem = (
  payload: UserOrganizedItemPayload,
  overrides: Partial<AcceptedEvent> = {},
): AcceptedEvent =>
  event({
    type: USER_ORGANIZED_ITEM,
    payload,
    aggregateId: payload.itemId,
    ...overrides,
  });

const emptyUrlProjection = (): UrlProjection => ({
  schemaVersion: 1,
  byCanonicalUrl: new Map<string, UrlVisitRecord>(),
});

const projection = (records: readonly UrlVisitRecord[]): UrlProjection => ({
  schemaVersion: 1,
  byCanonicalUrl: new Map(records.map((r) => [r.canonicalUrl, r])),
});

const url = (canonicalUrl: string, overrides: Partial<UrlVisitRecord> = {}): UrlVisitRecord => ({
  canonicalUrl,
  firstSeenAt: TIMESTAMP,
  lastSeenAt: TIMESTAMP,
  visitCount: 1,
  tabSessionIds: [],
  attributionHistory: [],
  ...overrides,
});

const visitNode = (id: string): ConnectionNode => ({
  id,
  kind: 'visit-instance',
  label: id,
  originReplicaIds: ['rep-1'],
  metadata: {},
});

const workstreamNode = (id: string): ConnectionNode => ({
  id,
  kind: 'workstream',
  label: id,
  originReplicaIds: ['rep-1'],
  metadata: {},
});

const edgeOf = (
  kind: ConnectionEdge['kind'],
  fromNodeId: string,
  toNodeId: string,
): ConnectionEdge => ({
  id: `edge:${kind}:${fromNodeId}:${toNodeId}`,
  kind,
  fromNodeId,
  toNodeId,
  observedAt: TIMESTAMP,
  producedBy: { source: 'event-log' },
  confidence: 'asserted',
});

const snapshot = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[] = [],
): ConnectionsSnapshot => ({
  scope: {},
  nodes,
  edges,
  updatedAt: TIMESTAMP,
  nodeCount: nodes.length,
  edgeCount: edges.length,
});

const emptySimilarityRevision = (): VisitSimilarityRevision => ({
  revisionId: 'sim-rev-1',
  modelId: 'Xenova/multilingual-e5-small',
  modelRevision: 'model-rev-1',
  featureSchemaVersion: 1,
  threshold: 0.85,
  edges: [],
  producedAt: ACCEPTED_AT_MS,
  producer: 'embedding',
});

const emptyTopicRevision = () => ({
  revisionId: 'topic-rev-1',
  visitSimilarityRevisionId: 'sim-rev-1',
  cosineThreshold: 0.85,
  algorithmVersion: 'topic-revision:v1:union-find' as const,
  topics: [],
  lineage: [],
  producedAt: ACCEPTED_AT_MS,
});

const baseInput = (
  overrides: Partial<MaterializerDiagnosticsInput> = {},
): MaterializerDiagnosticsInput => ({
  producedAt: TIMESTAMP,
  maxAcceptedAtMs: ACCEPTED_AT_MS,
  engagementGateMs: 5_000,
  timelineEntries: [],
  visitSimilarity: emptySimilarityRevision(),
  topicRevision: emptyTopicRevision(),
  rankerRetrainResult: null,
  events: [],
  urlProjection: emptyUrlProjection(),
  snapshot: snapshot([]),
  ...overrides,
});

describe('collectMaterializerDiagnostics', () => {
  it('counts engagement-eligible timeline entries against the configured gate', () => {
    const input = baseInput({
      engagementGateMs: 5_000,
      timelineEntries: [
        { tabSessionId: 'tses-a', dimensions: { engagement: { focusedWindowMs: 1_000 } } },
        { tabSessionId: 'tses-b', dimensions: { engagement: { focusedWindowMs: 6_000 } } },
        { tabSessionId: 'tses-c' },
        { dimensions: { engagement: { focusedWindowMs: 10_000 } } },
      ],
    });
    const diag = collectMaterializerDiagnostics(input);
    expect(diag.timeline).toEqual({
      entryCount: 4,
      entriesWithTabSessionId: 3,
      entriesWithFocusedWindowMs: 3,
      engagementEligibleEntryCount: 2,
      engagementGateMs: 5_000,
    });
  });

  it('partitions user.organized.item events by itemKind and counts inferred-attribution events', () => {
    const input = baseInput({
      events: [
        organizedItem(
          {
            payloadVersion: 1,
            itemKind: 'canonical-url',
            itemId: 'https://example.test/a',
            action: 'move',
            toContainer: 'ws-1',
          },
          { clientEventId: 'evt-a' },
        ),
        organizedItem(
          {
            payloadVersion: 1,
            itemKind: 'canonical-url',
            itemId: 'https://example.test/b',
            action: 'move',
            toContainer: 'ws-1',
          },
          { clientEventId: 'evt-b' },
        ),
        organizedItem(
          {
            payloadVersion: 1,
            itemKind: 'tab-session',
            itemId: 'tses-1',
            action: 'move',
            toContainer: 'ws-1',
          },
          { clientEventId: 'evt-c' },
        ),
        event({ type: URL_ATTRIBUTION_INFERRED, payload: { canonicalUrl: 'x' } }),
        event({ type: URL_ATTRIBUTION_INFERRED, payload: { canonicalUrl: 'y' } }),
        event({ type: TAB_SESSION_ATTRIBUTION_INFERRED, payload: { tabSessionId: 'tses-2' } }),
      ],
    });
    const diag = collectMaterializerDiagnostics(input);
    expect(diag.userAssertions.total).toBe(3);
    expect(diag.userAssertions.byItemKind['canonical-url']).toBe(2);
    expect(diag.userAssertions.byItemKind['tab-session']).toBe(1);
    expect(diag.userAssertions.byItemKind.workstream).toBe(0);
    expect(diag.inferred).toEqual({
      urlAttributionInferredCount: 2,
      tabSessionAttributionInferredCount: 1,
    });
  });

  it('reports topic component sizes sorted descending and total member count', () => {
    const input = baseInput({
      topicRevision: {
        ...emptyTopicRevision(),
        topics: [
          {
            topicId: 'topic-small',
            memberCanonicalUrls: ['url-a', 'url-b'],
            metadata: {
              memberCount: 2,
              representativeTitles: [],
              firstObservedAt: TIMESTAMP,
              lastObservedAt: TIMESTAMP,
              cohesion: 0.9,
            },
          },
          {
            topicId: 'topic-large',
            memberCanonicalUrls: ['url-c', 'url-d', 'url-e', 'url-f'],
            metadata: {
              memberCount: 4,
              representativeTitles: [],
              firstObservedAt: TIMESTAMP,
              lastObservedAt: TIMESTAMP,
              cohesion: 0.8,
            },
          },
        ],
      },
    });
    const diag = collectMaterializerDiagnostics(input);
    expect(diag.topics.topicCount).toBe(2);
    expect(diag.topics.memberCount).toBe(6);
    expect(diag.topics.componentSizes).toEqual([4, 2]);
  });

  it('reports ranker skip reason and label counts when retrain skipped', () => {
    const skipped: RankerRetrainResult = {
      status: 'skipped',
      reason: 'below-threshold',
      fingerprint: {
        hash: 'abc',
        labelCount: 12,
        positiveLabelCount: 7,
        negativeLabelCount: 5,
      },
      newLabelCount: 12,
      candidateCount: 30,
    };
    const diag = collectMaterializerDiagnostics(baseInput({ rankerRetrainResult: skipped }));
    expect(diag.ranker).toEqual({
      status: 'skipped',
      reason: 'below-threshold',
      labelCount: 12,
      positiveLabelCount: 7,
      negativeLabelCount: 5,
      newLabelCount: 12,
      candidateCount: 30,
      revisionId: null,
      error: null,
    });
  });

  it('reports ranker trained revision id when retrain succeeded', () => {
    const trained: RankerRetrainResult = {
      status: 'trained',
      revisionId: 'ranker-rev-9',
      fingerprint: {
        hash: 'def',
        labelCount: 60,
        positiveLabelCount: 33,
        negativeLabelCount: 27,
      },
      newLabelCount: 60,
      candidateCount: 200,
    };
    const diag = collectMaterializerDiagnostics(baseInput({ rankerRetrainResult: trained }));
    expect(diag.ranker.status).toBe('trained');
    expect(diag.ranker.revisionId).toBe('ranker-rev-9');
    expect(diag.ranker.candidateCount).toBe(200);
    expect(diag.ranker.newLabelCount).toBe(60);
  });

  it('reports not-run ranker counters when no retrain result is supplied', () => {
    const diag = collectMaterializerDiagnostics(baseInput({ rankerRetrainResult: null }));
    expect(diag.ranker.status).toBe('not-run');
    expect(diag.ranker.labelCount).toBe(0);
    expect(diag.ranker.revisionId).toBeNull();
  });

  it('reports ranker augmentation status and emitted edge counts', () => {
    const snap = snapshot(
      [
        visitNode('timeline-visit:https://example.test/a'),
        visitNode('timeline-visit:https://example.test/b'),
      ],
      [
        {
          ...edgeOf(
            'closest_visit',
            'timeline-visit:https://example.test/a',
            'timeline-visit:https://example.test/b',
          ),
          producedBy: { source: 'ranker', revisionId: 'ranker-rev-1' },
          confidence: 'inferred',
        },
      ],
    );
    const diag = collectMaterializerDiagnostics(
      baseInput({
        snapshot: snap,
        rankerAugmentation: {
          status: 'emitted',
          reason: null,
          activeRevisionId: 'ranker-rev-1',
          activeModelVersion: RANKER_MODEL_VERSION,
          expectedModelVersion: RANKER_MODEL_VERSION,
          activeFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
          expectedFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
          needsRetrain: false,
          modelFreshness: 'fresh',
          baseEdgeCount: 0,
          finalEdgeCount: 1,
          closestVisitEdgeCount: 1,
          rankerSourceEdgeCount: 1,
        },
      }),
    );
    expect(diag.rankerAugmentation).toEqual({
      status: 'emitted',
      reason: null,
      activeRevisionId: 'ranker-rev-1',
      activeModelVersion: RANKER_MODEL_VERSION,
      expectedModelVersion: RANKER_MODEL_VERSION,
      activeFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
      expectedFeatureSchemaVersion: FEATURE_SCHEMA_VERSION,
      needsRetrain: false,
      modelFreshness: 'fresh',
      baseEdgeCount: 0,
      finalEdgeCount: 1,
      closestVisitEdgeCount: 1,
      rankerSourceEdgeCount: 1,
    });
  });

  it('counts canonical-url attribution by source from the URL projection', () => {
    const urls = projection([
      url('https://example.test/a', {
        currentAttribution: {
          workstreamId: 'ws-1',
          source: 'user_asserted',
          observedAt: TIMESTAMP,
          clientEventId: 'evt-1',
          replicaId: 'rep-1',
          seq: 1,
        },
      }),
      url('https://example.test/b', {
        currentAttribution: {
          workstreamId: 'ws-1',
          source: 'inferred',
          observedAt: TIMESTAMP,
          clientEventId: 'evt-2',
          replicaId: 'rep-1',
          seq: 2,
        },
      }),
      url('https://example.test/c', {
        currentAttribution: {
          workstreamId: null,
          source: 'user_asserted',
          observedAt: TIMESTAMP,
          clientEventId: 'evt-3',
          replicaId: 'rep-1',
          seq: 3,
        },
      }),
      url('https://example.test/d'),
    ]);
    const diag = collectMaterializerDiagnostics(baseInput({ urlProjection: urls }));
    expect(diag.urls).toEqual({
      canonicalUrlCount: 4,
      attributedCanonicalUrlCount: 2,
      attributedByUserCanonicalUrlCount: 1,
      attributionBySource: { user_asserted: 1, inferred: 1 },
    });
  });

  it('partitions snapshot visit-instances by visit_instance_in_workstream attribution', () => {
    const visitA = visitNode('visit-instance:tses-1:2026-05-10:a');
    const visitB = visitNode('visit-instance:tses-1:2026-05-10:b');
    const visitC = visitNode('visit-instance:tses-2:2026-05-10:c');
    const ws = workstreamNode('workstream:ws-1');
    const snap = snapshot(
      [visitA, visitB, visitC, ws],
      [
        edgeOf('visit_instance_in_workstream', visitA.id, ws.id),
        edgeOf('visit_instance_in_workstream', visitB.id, ws.id),
        edgeOf('tab_session_in_workstream', 'tab-session:tses-1', ws.id),
      ],
    );
    const diag = collectMaterializerDiagnostics(baseInput({ snapshot: snap }));
    expect(diag.snapshot.visitInstanceCount).toBe(3);
    expect(diag.snapshot.attributedVisitInstanceCount).toBe(2);
    expect(diag.snapshot.unattributedVisitInstanceCount).toBe(1);
    expect(diag.snapshot.edgeCountByKind['visit_instance_in_workstream']).toBe(2);
    expect(diag.snapshot.nodeCountByKind['visit-instance']).toBe(3);
    expect(diag.snapshot.nodeCountByKind['workstream']).toBe(1);
  });

  it('counts engagement.session.aggregated events and aggregates focusedWindowMs', () => {
    const engagementEvent = (focusedWindowMs: number, seq: number): AcceptedEvent =>
      event({
        type: ENGAGEMENT_SESSION_AGGREGATED,
        payload: { dimensions: { engagement: { focusedWindowMs } } },
        clientEventId: `engagement-${String(seq)}`,
        dot: { replicaId: 'rep-1', seq },
      });
    const diag = collectMaterializerDiagnostics(
      baseInput({
        events: [engagementEvent(1_200, 1), engagementEvent(5_500, 2), engagementEvent(0, 3)],
      }),
    );
    expect(diag.engagement).toEqual({
      sessionAggregatedCount: 3,
      sumFocusedWindowMs: 6_700,
      maxFocusedWindowMs: 5_500,
    });
  });

  it('reports zeros when no engagement.session.aggregated events arrive', () => {
    const diag = collectMaterializerDiagnostics(baseInput());
    expect(diag.engagement).toEqual({
      sessionAggregatedCount: 0,
      sumFocusedWindowMs: 0,
      maxFocusedWindowMs: 0,
    });
  });

  it('reports the effective similarity config the materializer forwarded', () => {
    const diag = collectMaterializerDiagnostics(
      baseInput({
        engagementGateMs: 1_000,
        similarityEffectiveConfig: {
          threshold: 0.6,
          topK: 25,
          engagementGateMs: 1_000,
          lexicalThreshold: 0.4,
          lexicalFallbackEnabled: true,
        },
        timelineEntries: [
          { dimensions: { engagement: { focusedWindowMs: 800 } } }, // below the override
          { dimensions: { engagement: { focusedWindowMs: 1_500 } } }, // above the override
        ],
      }),
    );
    // engagementGateMs reflects the override, not the constant default.
    expect(diag.timeline.engagementGateMs).toBe(1_000);
    expect(diag.timeline.engagementEligibleEntryCount).toBe(1);
    // effectiveConfig surfaces every knob.
    expect(diag.similarity.effectiveConfig).toEqual({
      threshold: 0.6,
      topK: 25,
      engagementGateMs: 1_000,
      lexicalThreshold: 0.4,
      lexicalFallbackEnabled: true,
    });
  });

  it('omits effectiveConfig when no similarityEffectiveConfig is supplied (back-compat)', () => {
    const diag = collectMaterializerDiagnostics(baseInput());
    expect(diag.similarity.effectiveConfig).toBeUndefined();
  });

  it('preserves shadow observation diagnostics for the dogfood window', () => {
    const diag = collectMaterializerDiagnostics(
      baseInput({
        topicShadowObservation: {
          shadowRevisionId: 'shadow-next',
          previousShadowRevisionId: 'shadow-prev',
          adjacentOverlapVisitCount: 10,
          adjacentChangedVisitCount: 1,
          adjacentPerVisitChurn: 0.1,
          adjacentRawTopicIdChurn: 0.3,
          previousShadowTopicCount: 8,
          previousShadowMaxTopicSize: 12,
          previousShadowAssignedVisitCount: 90,
          topicCountDeltaFromPrevious: 2,
          maxTopicSizeDeltaFromPrevious: -4,
          assignedVisitCountDeltaFromPrevious: 6,
          baselineCollapsed: true,
          previousBaselineCollapsed: true,
          activeCollapseBoundaryChanged: false,
          shadowCollapsed: false,
          previousShadowCollapsed: false,
          shadowCollapseBoundaryChanged: false,
        },
      }),
    );

    expect(diag.shadowObservation).toMatchObject({
      shadowRevisionId: 'shadow-next',
      previousShadowRevisionId: 'shadow-prev',
      adjacentPerVisitChurn: 0.1,
      topicCountDeltaFromPrevious: 2,
      shadowCollapseBoundaryChanged: false,
    });
  });
});

describe('summarizeMaterializerDiagnostics', () => {
  it('emits a single line with the load-bearing counters', () => {
    const diag = collectMaterializerDiagnostics(
      baseInput({
        timelineEntries: [{ dimensions: { engagement: { focusedWindowMs: 9_000 } } }],
        visitSimilarity: { ...emptySimilarityRevision(), edges: [] },
      }),
    );
    const summary = summarizeMaterializerDiagnostics(diag);
    expect(summary.startsWith('[materializer-diag] ')).toBe(true);
    expect(summary).toContain('simEdges=0(embedding)');
    expect(summary).toContain('engagementEligible=1');
    expect(summary).toContain('ranker=not-run');
    expect(summary).toContain('rankerAug=not-run:unknown');
    expect(summary).toContain('newLabels=n/a');
  });

  it('flags the similarity producer when the lexical fallback runs', () => {
    const diag = collectMaterializerDiagnostics(
      baseInput({
        visitSimilarity: { ...emptySimilarityRevision(), producer: 'lexical' },
      }),
    );
    expect(diag.similarity.producer).toBe('lexical');
    expect(summarizeMaterializerDiagnostics(diag)).toContain('simEdges=0(lexical)');
  });

  it('reports producer="unknown" for legacy revisions without the producer field', () => {
    const legacy: VisitSimilarityRevision = {
      ...emptySimilarityRevision(),
    };
    // Strip producer to simulate the pre-T2 fixture shape.
    const { producer: _producer, ...stripped } = legacy;
    void _producer;
    const diag = collectMaterializerDiagnostics(baseInput({ visitSimilarity: stripped }));
    expect(diag.similarity.producer).toBe('unknown');
  });

  it('includes adjacent shadow observation counters when present', () => {
    const diag = collectMaterializerDiagnostics(
      baseInput({
        topicShadowObservation: {
          shadowRevisionId: 'shadow-next',
          previousShadowRevisionId: 'shadow-prev',
          adjacentOverlapVisitCount: 10,
          adjacentChangedVisitCount: 1,
          adjacentPerVisitChurn: 0.1,
          adjacentRawTopicIdChurn: 0.3,
          baselineCollapsed: true,
          previousBaselineCollapsed: false,
          activeCollapseBoundaryChanged: true,
          shadowCollapsed: false,
          previousShadowCollapsed: false,
          shadowCollapseBoundaryChanged: false,
          noiseShareDeltaFromPrevious: 0.04,
        },
      }),
    );

    const summary = summarizeMaterializerDiagnostics(diag);
    expect(summary).toContain('shadowAdjChurn=0.1');
    expect(summary).toContain('shadowBoundaryChanged=false');
    expect(summary).toContain('activeBoundaryChanged=true');
    expect(summary).toContain('shadowNoiseDelta=0.04');
  });
});

describe('createMaterializerDiagnosticsStore', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'mat-diag-test-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('writes latest.json + history/<iso>.json atomically', async () => {
    const store = createMaterializerDiagnosticsStore(vaultRoot);
    const diagnostics: MaterializerDiagnostics = collectMaterializerDiagnostics(baseInput());
    await store.write(diagnostics);

    const latestBody = await readFile(
      join(vaultRoot, '_BAC/connections/diagnostics/latest.json'),
      'utf8',
    );
    expect(JSON.parse(latestBody)).toEqual(diagnostics);

    const historyEntries = await readdir(join(vaultRoot, '_BAC/connections/diagnostics/history'));
    expect(historyEntries).toHaveLength(1);
    expect(historyEntries[0]).toMatch(/^2026-05-10T00-00-00-000Z\.json$/);
  });

  it('writes a second history entry on every drain, even with the same producedAt content', async () => {
    const store = createMaterializerDiagnosticsStore(vaultRoot);
    const first: MaterializerDiagnostics = collectMaterializerDiagnostics(baseInput());
    const second: MaterializerDiagnostics = collectMaterializerDiagnostics(
      baseInput({ producedAt: '2026-05-10T00:00:01.000Z' }),
    );
    await store.write(first);
    await store.write(second);
    const entries = await readdir(join(vaultRoot, '_BAC/connections/diagnostics/history'));
    expect(entries.sort()).toEqual([
      '2026-05-10T00-00-00-000Z.json',
      '2026-05-10T00-00-01-000Z.json',
    ]);
  });
});

describe('attachDriftReport (drift layer wiring)', () => {
  const memoryStore = (): DriftStateStore & {
    current: () => DriftPersistedState | null;
  } => {
    let saved: DriftPersistedState | null = null;
    return {
      read: (): Promise<DriftPersistedState | null> => Promise.resolve(saved),
      write: (state: DriftPersistedState): Promise<void> => {
        saved = structuredClone(state);
        return Promise.resolve();
      },
      current: (): DriftPersistedState | null => saved,
    };
  };

  it('folds a drift report into the diagnostics without throwing', async () => {
    const diagnostics = collectMaterializerDiagnostics(baseInput());
    const store = memoryStore();
    const result = await attachDriftReport({
      diagnostics,
      topics: [],
      similarityEdges: [],
      stateStore: store,
    });
    const drift = result.diagnostics.drift;
    expect(drift).toBeDefined();
    expect(['stable', 'warning', 'drift']).toContain(drift?.status);
    expect(result.statePersisted).toBe(true);
    expect(store.current()).not.toBeNull();
    // Base diagnostics fields are untouched.
    expect(result.diagnostics.snapshot).toEqual(diagnostics.snapshot);
  });

  it('summary line includes the drift status once attached', async () => {
    const diagnostics = collectMaterializerDiagnostics(baseInput());
    const result = await attachDriftReport({
      diagnostics,
      topics: [],
      similarityEdges: [],
      stateStore: memoryStore(),
    });
    const summary = summarizeMaterializerDiagnostics(result.diagnostics);
    expect(summary).toContain('drift=');
    expect(summary).toContain('silhouette=');
  });

  it('persists detector state across successive drains', async () => {
    const store = memoryStore();
    for (let i = 0; i < 5; i += 1) {
      const diagnostics = collectMaterializerDiagnostics(baseInput());
      await attachDriftReport({
        diagnostics,
        topics: [],
        similarityEdges: [],
        stateStore: store,
      });
    }
    const state = store.current();
    expect(state).not.toBeNull();
    // Four always-available signals have accumulated detector windows.
    expect(Object.keys(state?.signals ?? {}).sort()).toEqual(
      ['similarityEdgeCount', 'snapshotEdgeCount', 'topicCount', 'topicMemberCount'].sort(),
    );
  });

  it('never throws and yields a stable fallback when the store explodes', async () => {
    const diagnostics = collectMaterializerDiagnostics(baseInput());
    const explodingStore: DriftStateStore = {
      read: (): Promise<DriftPersistedState | null> => Promise.reject(new Error('boom-read')),
      write: (): Promise<void> => Promise.reject(new Error('boom-write')),
    };
    const result = await attachDriftReport({
      diagnostics,
      topics: [],
      similarityEdges: [],
      stateStore: explodingStore,
    });
    // loadDriftMonitor swallows the read error → fresh monitor still
    // produces a report; the write error surfaces as stateError but
    // never throws.
    expect(result.diagnostics.drift).toBeDefined();
    expect(result.diagnostics.drift?.status).toBe('stable');
    expect(result.statePersisted).toBe(false);
    expect(result.stateError).toBe('boom-write');
  });

  it('feeds shadow signals when the shadow block is present', async () => {
    const diagnostics: MaterializerDiagnostics = {
      ...collectMaterializerDiagnostics(baseInput()),
      shadowVsBaseline: {
        enabled: true,
        candidate: 'idf-rkn-split',
        baselineAlgorithmVersion: 'topic-revision:v1:union-find',
        shadowAlgorithmVersion: 'topic-revision:shadow:idf-rkn-split',
        baselineRevisionId: 'b',
        shadowRevisionId: 's',
        edgeCountBeforePruning: 100,
        edgeCountAfterPruning: 40,
        reciprocalK: 10,
        minLexicalScore: 0.05,
        workstreamHardUnionEdgesRemoved: 0,
        inThreadRelationsRetained: 0,
        highDfTermsSuppressed: 0,
        highDfTerms: [],
        baselineTopicCount: 3,
        shadowTopicCount: 4,
        topicCountDelta: 1,
        baselineMaxTopicSize: 10,
        shadowMaxTopicSize: 7,
        maxTopicSizeDelta: -3,
        baselineMaxTopicShare: 0.5,
        shadowMaxTopicShare: 0.35,
        maxShareDelta: -0.15,
        eligibleVisitCount: 20,
        shadowAssignedVisitCount: 18,
        noiseShare: 0.1,
        splitParentCount: 1,
        splitAcceptedCount: 1,
        secondaryAffiliationCount: 0,
        perVisitChurn: 0.2,
        runtimeMs: 1,
      },
    };
    const store = memoryStore();
    await attachDriftReport({
      diagnostics,
      topics: [],
      similarityEdges: [],
      stateStore: store,
    });
    const signals = Object.keys(store.current()?.signals ?? {});
    expect(signals).toContain('noiseShare');
    expect(signals).toContain('perVisitChurn');
  });
});
