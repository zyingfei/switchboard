import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  augmentConnectionsSnapshotWithClosestVisitRanker,
  augmentConnectionsSnapshotWithClosestVisitRankerFrontier,
  buildConnectionsSnapshot,
  createConnectionsStore,
  expandRankerFrontier,
  type ClosestVisitRanker,
  type ConnectionsInput,
  type ConnectionsSnapshot,
} from '../../connections/snapshot.js';
import { nodeIdFor, type ConnectionEdge, type ConnectionNode } from '../../connections/types.js';
import type { VisitSimilarityEmbedder } from '../../connections/visitSimilarity.js';
import {
  TOPIC_UNION_FIND_REVISION_KEY,
  createTopicRevisionId,
  createTopicRevisionStore,
  type TopicRevision,
} from '../../producers/topic-revision.js';
import type { RankerContributions } from '../../ranker/predict.js';
import { createEmptyTabSessionProjection } from '../../tabsession/projection.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createTimelineStore, type TimelineDayProjection } from '../../timeline/projection.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';

const at = (minute: number): string => `2026-05-07T10:${String(minute).padStart(2, '0')}:00.000Z`;

const edgeId = (kind: string, fromNodeId: string, toNodeId: string): string =>
  `edge:${kind}:${fromNodeId}:${toNodeId}`;

const visitNode = (key: string, metadata: Record<string, unknown> = {}): ConnectionNode => ({
  id: nodeIdFor('timeline-visit', key),
  kind: 'timeline-visit',
  label: key,
  firstSeenAt: at(0),
  lastSeenAt: at(0),
  metadata: { canonicalUrl: key, ...metadata },
});

const edge = (
  kind: ConnectionEdge['kind'],
  fromNodeId: string,
  toNodeId: string,
): ConnectionEdge => ({
  id: edgeId(kind, fromNodeId, toNodeId),
  kind,
  fromNodeId,
  toNodeId,
  observedAt: at(0),
  producedBy: { source: 'timeline-projection' },
  confidence: 'inferred',
});

const snapshotFixture = (): ConnectionsSnapshot => {
  const v1 = 'https://example.test/a';
  const v1b = 'https://example.test/a#section';
  const v2 = 'https://example.test/b';
  const v3 = 'https://example.test/c';
  const nodes: ConnectionNode[] = [
    visitNode(v1, { workstreamId: 'ws-1' }),
    visitNode(v1b, { canonicalUrl: v1 }),
    visitNode(v2, { workstreamId: 'ws-1' }),
    visitNode(v3),
    {
      id: 'visit-instance:i1',
      kind: 'visit-instance',
      label: 'i1',
      firstSeenAt: at(0),
      lastSeenAt: at(0),
      metadata: { timelineVisitId: nodeIdFor('timeline-visit', v1), tabSessionId: 'ts-1' },
    },
    {
      id: 'visit-instance:i2',
      kind: 'visit-instance',
      label: 'i2',
      firstSeenAt: at(1),
      lastSeenAt: at(1),
      metadata: { timelineVisitId: nodeIdFor('timeline-visit', v2), tabSessionId: 'ts-1' },
    },
    {
      id: 'tab-session:ts-1',
      kind: 'tab-session',
      label: 'ts-1',
      firstSeenAt: at(0),
      lastSeenAt: at(1),
      metadata: {},
    },
    {
      id: 'workstream:ws-1',
      kind: 'workstream',
      label: 'ws-1',
      firstSeenAt: at(0),
      lastSeenAt: at(1),
      metadata: {},
    },
    {
      id: 'thread:thread-1',
      kind: 'thread',
      label: 'thread-1',
      firstSeenAt: at(0),
      lastSeenAt: at(1),
      metadata: {},
    },
  ];
  const edges: ConnectionEdge[] = [
    edge('visit_instance_in_tab_session', 'visit-instance:i1', 'tab-session:ts-1'),
    edge('visit_instance_in_tab_session', 'visit-instance:i2', 'tab-session:ts-1'),
    edge('visit_in_workstream', nodeIdFor('timeline-visit', v1), 'workstream:ws-1'),
    edge('visit_in_workstream', nodeIdFor('timeline-visit', v2), 'workstream:ws-1'),
    edge('timeline_same_url_as_thread', nodeIdFor('timeline-visit', v1), 'thread:thread-1'),
    edge('timeline_same_url_as_thread', nodeIdFor('timeline-visit', v3), 'thread:thread-1'),
    {
      ...edge('closest_visit', nodeIdFor('timeline-visit', v1), nodeIdFor('timeline-visit', v3)),
      producedBy: { source: 'ranker', revisionId: 'ranker-rev-1' },
    },
    {
      ...edge(
        'visit_resembles_visit',
        nodeIdFor('timeline-visit', v1),
        nodeIdFor('timeline-visit', v2),
      ),
      producedBy: { source: 'visit-similarity', revisionId: 'sim-1' },
    },
  ];
  return {
    schemaVersion: 1,
    generatedAt: at(1),
    updatedAt: at(1),
    nodes,
    edges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    snapshotRevision: 'fixture',
  };
};

const event = (seq: number, slug: string, tabSessionId = `tab-${slug}`): AcceptedEvent => ({
  clientEventId: `evt-${seq}`,
  dot: { replicaId: 'replica-A', seq },
  deps: {},
  aggregateId: `timeline.${seq}`,
  type: BROWSER_TIMELINE_OBSERVED,
  payload: {
    eventId: `timeline-${slug}`,
    observedAt: at(seq),
    url: `https://ranker.test/${slug}`,
    canonicalUrl: `https://ranker.test/${slug}`,
    title: `ranker ${slug}`,
    provider: 'generic',
    transition: 'activated',
    payloadVersion: 1,
    tabSessionId,
    dimensions: { engagement: { focusedWindowMs: 10_000 } },
  },
  acceptedAtMs: Date.parse(at(seq)),
});

const dayFor = (events: readonly AcceptedEvent[]): TimelineDayProjection => ({
  date: '2026-05-07',
  updatedAt: at(events.length),
  entryCount: events.length,
  entries: events.map((accepted) => {
    const payload = accepted.payload as {
      readonly url: string;
      readonly canonicalUrl: string;
      readonly title: string;
      readonly tabSessionId: string;
    };
    return {
      id: `entry-${accepted.dot.seq}`,
      firstSeenAt: at(accepted.dot.seq),
      lastSeenAt: at(accepted.dot.seq),
      url: payload.url,
      canonicalUrl: payload.canonicalUrl,
      title: payload.title,
      provider: 'generic',
      visitCount: 1,
      tabSessionId: payload.tabSessionId,
    };
  }),
});

const inputFor = (events: readonly AcceptedEvent[]): ConnectionsInput => ({
  events,
  threads: [],
  workstreams: [],
  dispatches: [],
  queueItems: [],
  reminders: [],
  codingSessions: [],
  timelineDays: [dayFor(events)],
  tabSessionProjection: createEmptyTabSessionProjection(),
});

const contributions = (): RankerContributions => ({
  schemaVersion: 0,
  same_workstream: 0,
  opener_chain_depth: 0,
  in_navigation_chain: 0,
  same_canonical_url: 0,
  same_host: 1,
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

const ranker = (revisionId: string, seenFrom?: Set<string>): ClosestVisitRanker => ({
  revisionId,
  threshold: 0.1,
  topK: 2,
  predict: (_features, candidate) => {
    if (candidate !== undefined) seenFrom?.add(candidate.fromVisitId);
    return { score: 0.9, contributions: contributions() };
  },
});

const closestEdges = (snapshot: ConnectionsSnapshot): readonly ConnectionEdge[] =>
  snapshot.edges.filter((candidate) => candidate.kind === 'closest_visit');

const incidentClosestEdges = (
  snapshot: ConnectionsSnapshot,
  frontier: ReadonlySet<string>,
): readonly ConnectionEdge[] => {
  const nodeIds = new Set([...frontier].map((visit) => nodeIdFor('timeline-visit', visit)));
  return closestEdges(snapshot).filter(
    (candidate) => nodeIds.has(candidate.fromNodeId) || nodeIds.has(candidate.toNodeId),
  );
};

const withoutInputFrontier = (edges: readonly ConnectionEdge[]): readonly ConnectionEdge[] =>
  edges.map((candidate) => {
    const { inputFrontier: _inputFrontier, ...metadata } = candidate.metadata ?? {};
    void _inputFrontier;
    return { ...candidate, metadata };
  });

describe('connections incremental ranker frontier', () => {
  let vaultRoot: string;
  const previousEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-incremental-ranker-'));
    for (const key of [
      'SIDETRACK_CONNECTIONS_INCREMENTAL_RANKER',
      'SIDETRACK_CONNECTIONS_TOPIC_EVERY_DRAINS',
      'SIDETRACK_CONNECTIONS_TOPIC_EVERY_MS',
      'SIDETRACK_TOPIC_PRODUCER',
    ]) {
      previousEnv[key] = process.env[key];
    }
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('expands the ranker frontier across URL, tab-session, workstream, thread, prior closest, and similarity neighbors', () => {
    const snapshot = snapshotFixture();
    const frontier = expandRankerFrontier(new Set(['https://example.test/a']), snapshot, {
      includeSameUrlSiblings: true,
      includeSameTabSession: true,
      includeSameWorkstream: true,
      includeSameThread: true,
      includePriorClosestNeighbors: true,
      includeSimEdgeChanged: true,
    });

    expect([...frontier]).toEqual([
      'https://example.test/a',
      'https://example.test/a#section',
      'https://example.test/b',
      'https://example.test/c',
    ]);
  });

  it('matches full closest-visit augmentation for the incremental frontier and leaves outside edges untouched', () => {
    const events = [
      event(1, 'alpha', 'tab-1'),
      event(2, 'bravo', 'tab-1'),
      event(3, 'charlie', 'tab-2'),
    ];
    const input = inputFor(events);
    const base = buildConnectionsSnapshot(input);
    const full = augmentConnectionsSnapshotWithClosestVisitRanker(
      { ...input, closestVisitRanker: ranker('ranker-rev-1') },
      base,
    );
    const frontier = expandRankerFrontier(new Set(['https://ranker.test/charlie']), full, {
      includeSameUrlSiblings: true,
      includeSameTabSession: true,
      includeSameWorkstream: true,
      includeSameThread: true,
      includePriorClosestNeighbors: true,
      includeSimEdgeChanged: true,
    });
    const incremental = augmentConnectionsSnapshotWithClosestVisitRankerFrontier(
      {
        ...input,
        closestVisitRanker: ranker('ranker-rev-1'),
        rankerFrontier: frontier,
        inputFrontier: { 'replica-A': 3 },
      },
      full,
    );

    expect(withoutInputFrontier(incidentClosestEdges(incremental, frontier))).toEqual(
      withoutInputFrontier(incidentClosestEdges(full, frontier)),
    );
    const frontierNodeIds = new Set(
      [...frontier].map((visit) => nodeIdFor('timeline-visit', visit)),
    );
    expect(
      closestEdges(incremental).filter(
        (candidate) =>
          !frontierNodeIds.has(candidate.fromNodeId) && !frontierNodeIds.has(candidate.toNodeId),
      ),
    ).toEqual(
      closestEdges(full).filter(
        (candidate) =>
          !frontierNodeIds.has(candidate.fromNodeId) && !frontierNodeIds.has(candidate.toNodeId),
      ),
    );
  });

  it('forces a full ranker augmentation when the producer revision changes', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    for (const accepted of [event(1, 'alpha'), event(2, 'bravo')]) {
      await eventLog.importPeerEvent(accepted);
    }
    await createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      rankerRetrainer: () =>
        Promise.resolve({ status: 'skipped', reason: 'no-labels', newLabelCount: 0 }),
      closestVisitRankerLoader: () =>
        Promise.resolve({
          status: 'ready',
          activeRevisionId: 'ranker-rev-1',
          ranker: ranker('ranker-rev-1'),
          model: { dispose: () => undefined } as never,
        }),
    }).catchUp(eventLog);

    const third = event(3, 'charlie');
    await eventLog.importPeerEvent(third);
    const seenFrom = new Set<string>();
    await createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      rankerRetrainer: () =>
        Promise.resolve({ status: 'skipped', reason: 'no-labels', newLabelCount: 0 }),
      closestVisitRankerLoader: () =>
        Promise.resolve({
          status: 'ready',
          activeRevisionId: 'ranker-rev-2',
          ranker: ranker('ranker-rev-2', seenFrom),
          model: { dispose: () => undefined } as never,
        }),
    }).catchUp(eventLog);

    expect([...seenFrom].sort()).toEqual([
      'https://ranker.test/alpha',
      'https://ranker.test/bravo',
      'https://ranker.test/charlie',
    ]);
  });

  it('reuses cached topics for 49 drains and recomputes on the 50th when similarity changed', async () => {
    process.env['SIDETRACK_CONNECTIONS_TOPIC_EVERY_DRAINS'] = '50';
    process.env['SIDETRACK_CONNECTIONS_TOPIC_EVERY_MS'] = '999999999';
    process.env['SIDETRACK_TOPIC_PRODUCER'] = 'union-find';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const baseStore = createConnectionsStore(vaultRoot);
    const store = { ...baseStore, readMaterializerProgress: () => Promise.resolve(null) };
    await eventLog.importPeerEvent(event(1, 'alpha'));
    const topicRevisionStore = createTopicRevisionStore(vaultRoot);
    const oldRevisionId = await createTopicRevisionId({
      visitSimilarityRevisionId: 'old-sim',
      cosineThreshold: 0.82,
      algorithmVersion: TOPIC_UNION_FIND_REVISION_KEY,
    });
    const oldRevision: TopicRevision = {
      revisionId: oldRevisionId,
      visitSimilarityRevisionId: 'old-sim',
      cosineThreshold: 0.82,
      algorithmVersion: TOPIC_UNION_FIND_REVISION_KEY,
      topics: [],
      lineage: [],
      producedAt: 1,
    };
    await topicRevisionStore.putActiveRevision(oldRevision);
    let activeWrites = 0;
    const embed: VisitSimilarityEmbedder = (texts) =>
      Promise.resolve(texts.map(() => Float32Array.from([1, 0])));
    const materializer = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed,
      topicRevisionStore: {
        ...topicRevisionStore,
        putActiveRevision: async (revision) => {
          activeWrites += 1;
          await topicRevisionStore.putActiveRevision(revision);
        },
      },
      rankerRetrainer: () =>
        Promise.resolve({ status: 'skipped', reason: 'no-labels', newLabelCount: 0 }),
    });

    for (let i = 0; i < 49; i += 1) await materializer.catchUp(eventLog);
    expect(activeWrites).toBe(0);
    await materializer.catchUp(eventLog);
    expect(activeWrites).toBe(1);
  });
});
