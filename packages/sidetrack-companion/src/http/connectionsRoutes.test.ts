import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore, type ConnectionsStore } from '../connections/snapshot.js';
import {
  edgeIdFor,
  type ConnectionNode,
  type ConnectionsSnapshot,
} from '../connections/types.js';
import {
  createTopicRevisionStore,
  TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
} from '../producers/topic-revision.js';
import { createConnectionsMaterializer } from '../sync/contract/connectionsMaterializer.js';
import { createSyncContractRunner } from '../sync/contract/runner.js';
import { createEventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { THREAD_UPSERTED } from '../threads/events.js';
import { createTimelineStore } from '../timeline/projection.js';
import { createVaultWriter } from '../vault/writer.js';
import { createIdempotencyStore } from './idempotency.js';
import { createCompanionHttpServer, startHttpServer } from './server.js';
import type { AcceptedEvent } from '../sync/causal.js';

const buildEvent = (input: { seq: number; type: string; payload: unknown }): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: Date.parse('2026-05-07T10:00:00.000Z') + input.seq * 1000,
});

describe('connections HTTP routes', () => {
  let vaultRoot: string;
  let serverUrl: string;
  let connectionsStore: ConnectionsStore;
  let close: (() => Promise<void>) | null = null;
  const BRIDGE = 'connections-bridge-key';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-connections-http-'));
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    connectionsStore = createConnectionsStore(vaultRoot);
    const runner = createSyncContractRunner();
    runner.register(
      createConnectionsMaterializer({
        vaultRoot,
        eventLog,
        timelineStore,
        store: connectionsStore,
      }),
    );

    // Seed some data via the event log so the materializer has
    // something to project. catchUp drives the snapshot write.
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
    await runner.catchUpAll(eventLog);
    await runner.awaitIdle();

    const idempotencyStore = createIdempotencyStore(vaultRoot);
    const server = createCompanionHttpServer({
      bridgeKey: BRIDGE,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore,
      replica,
      eventLog,
      connectionsStore,
      syncMaterializerHealth: () => runner.health(),
    });
    const started = await startHttpServer(server, 0);
    serverUrl = started.url;
    close = started.close;
  });

  afterEach(async () => {
    if (close !== null) await close();
    close = null;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const get = async (path: string): Promise<{ status: number; data: unknown }> => {
    const res = await fetch(`${serverUrl}${path}`, {
      headers: { 'x-bac-bridge-key': BRIDGE },
    });
    return { status: res.status, data: await res.json() };
  };

  it('GET /v1/connections returns scoped envelope with the projected graph', async () => {
    const r = await get('/v1/connections');
    expect(r.status).toBe(200);
    const body = r.data as {
      data: {
        scope: string;
        snapshot: {
          nodes: { id: string }[];
          edges: { kind: string }[];
          nodeCount: number;
          edgeCount: number;
        };
      };
    };
    expect(body.data.scope).toBe('companion-extended');
    const ids = body.data.snapshot.nodes.map((n) => n.id);
    expect(ids).toContain('thread:thread_a');
    expect(ids).toContain('workstream:ws_x');
    expect(body.data.snapshot.edges.find((e) => e.kind === 'thread_in_workstream')).toBeDefined();
  });

  it('invalidates the cached connections response when the SQLite snapshot revision changes', async () => {
    const first = await get('/v1/connections');
    expect(first.status).toBe(200);
    const firstBody = first.data as {
      data: { snapshot: { nodes: { id: string }[]; snapshotRevision?: string } };
    };
    expect(firstBody.data.snapshot.nodes.map((n) => n.id)).toContain('thread:thread_a');
    const firstRevision = firstBody.data.snapshot.snapshotRevision;

    const replacementNode: ConnectionNode = {
      id: 'thread:thread_b',
      kind: 'thread',
      label: 'B',
      originReplicaIds: [],
      metadata: { provider: 'chatgpt', threadId: 'provider-thread-b' },
    };
    // NOTE: the caller-supplied snapshotRevision is a hint only — the
    // SqliteConnectionsStore content-addresses the revision on write
    // (computeSnapshotRevision over updatedAt+counts+projection keys),
    // so the persisted/served revision is the store's recomputed hash,
    // NOT this literal. What this test guards is invalidation: a fresh
    // putCurrent must rotate the cache key so the second GET reflects
    // the new graph + a new revision (never a stale cached response).
    const replacement: ConnectionsSnapshot = {
      scope: {},
      nodes: [replacementNode],
      edges: [],
      updatedAt: '2026-05-07T10:02:00.000Z',
      nodeCount: 1,
      edgeCount: 0,
    };
    await connectionsStore.putCurrent(replacement);
    const storedRevision = (await connectionsStore.readCurrent())?.snapshotRevision;
    expect(storedRevision).toBeDefined();

    const second = await get('/v1/connections');
    expect(second.status).toBe(200);
    const secondBody = second.data as {
      data: { snapshot: { nodes: { id: string }[]; snapshotRevision?: string } };
    };
    // Cache invalidated: content is the replacement graph, and the
    // served revision is the store's freshly-computed hash (distinct
    // from the first response's) — proving the key rotated.
    expect(secondBody.data.snapshot.nodes.map((n) => n.id)).toEqual(['thread:thread_b']);
    expect(secondBody.data.snapshot.snapshotRevision).toBe(storedRevision);
    expect(secondBody.data.snapshot.snapshotRevision).not.toBe(firstRevision);
  });

  it('GET /v1/connections?workstreamId= filters to the workstream subgraph', async () => {
    const r = await get('/v1/connections?workstreamId=ws_x');
    const body = r.data as { data: { snapshot: { nodes: { id: string }[] } } };
    const ids = body.data.snapshot.nodes.map((n) => n.id);
    expect(ids).toContain('workstream:ws_x');
    expect(ids).toContain('thread:thread_a');
  });

  it('GET /v1/connections?nodeKind= filters to that kind only', async () => {
    const r = await get('/v1/connections?nodeKind=thread');
    const body = r.data as { data: { snapshot: { nodes: { kind: string }[] } } };
    expect(body.data.snapshot.nodes.every((n) => n.kind === 'thread')).toBe(true);
  });

  it('GET /v1/connections?topicVariant=shadow overlays the shadow topic revision', async () => {
    await createTopicRevisionStore(vaultRoot).putShadowRevision({
      revisionId: 'topic-shadow-test',
      visitSimilarityRevisionId: 'sim-test',
      cosineThreshold: 0.85,
      algorithmVersion: TOPIC_SHADOW_IDF_RKN_SPLIT_REVISION_KEY,
      topics: [
        {
          topicId: 'shadow-alpha',
          memberCanonicalUrls: ['https://example.test/a', 'https://example.test/b'],
          metadata: {
            memberCount: 2,
            representativeTitles: ['Shadow Alpha'],
            firstObservedAt: '2026-05-07T10:00:00.000Z',
            lastObservedAt: '2026-05-07T10:01:00.000Z',
            cohesion: 0.91,
          },
        },
      ],
      lineage: [],
      producedAt: Date.parse('2026-05-07T10:01:00.000Z'),
    });

    const r = await get('/v1/connections?topicVariant=shadow');
    expect(r.status).toBe(200);
    const body = r.data as {
      data: {
        snapshot: {
          scope: { topicVariant?: string };
          nodes: { id: string; kind: string; label: string }[];
          edges: { kind: string; producedBy: { revisionId?: string } }[];
        };
      };
    };
    expect(body.data.snapshot.scope.topicVariant).toBe('shadow');
    expect(body.data.snapshot.nodes).toContainEqual(
      expect.objectContaining({
        id: 'topic:shadow-alpha',
        kind: 'topic',
        label: 'Shadow Alpha',
      }),
    );
    expect(body.data.snapshot.edges).toContainEqual(
      expect.objectContaining({
        kind: 'visit_in_topic',
        producedBy: { source: 'topic-clusterer', revisionId: 'topic-shadow-test' },
      }),
    );
  });

  it('GET /v1/connections/nodes/<id>/neighbors?hops=1 returns the 1-hop subgraph', async () => {
    const r = await get('/v1/connections/nodes/thread%3Athread_a/neighbors?hops=1');
    expect(r.status).toBe(200);
    const body = r.data as { data: { snapshot: { nodes: { id: string }[] } } };
    const ids = body.data.snapshot.nodes.map((n) => n.id).sort();
    expect(ids).toContain('thread:thread_a');
    expect(ids).toContain('workstream:ws_x');
  });

  it('resolves URL-form timeline anchors whose stored node id omits a trailing slash', async () => {
    const canonicalWithSlash = 'https://example.test/fabric/';
    const canonicalWithoutSlash = 'https://example.test/fabric';
    const neighborId = 'timeline-visit:https://example.test/minipack';
    const anchorId = `timeline-visit:${canonicalWithoutSlash}`;
    const snapshot: ConnectionsSnapshot = {
      scope: {},
      nodes: [
        {
          id: 'tab-session:tses_same_url',
          kind: 'tab-session',
          label: 'Fabric tab session',
          firstSeenAt: '2026-05-07T09:59:00.000Z',
          lastSeenAt: '2026-05-07T10:01:00.000Z',
          originReplicaIds: [],
          metadata: {
            canonicalUrl: canonicalWithSlash,
            latestUrl: canonicalWithSlash,
          },
        },
        {
          id: anchorId,
          kind: 'timeline-visit',
          label: 'Fabric',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:00:00.000Z',
          originReplicaIds: [],
          metadata: {
            canonicalUrl: canonicalWithSlash,
            url: canonicalWithSlash,
          },
        },
        {
          id: neighborId,
          kind: 'timeline-visit',
          label: 'Minipack',
          originReplicaIds: [],
          metadata: {
            canonicalUrl: 'https://example.test/minipack',
          },
        },
      ],
      edges: [
        {
          id: edgeIdFor('visit_resembles_visit', anchorId, neighborId),
          kind: 'visit_resembles_visit',
          fromNodeId: anchorId,
          toNodeId: neighborId,
          observedAt: '2026-05-07T10:00:00.000Z',
          producedBy: { source: 'visit-similarity', revisionId: 'sim-test' },
          confidence: 'inferred',
        },
      ],
      updatedAt: '2026-05-07T10:00:00.000Z',
      nodeCount: 3,
      edgeCount: 1,
      snapshotRevision: 'slash-alias-fixture',
    };
    await createConnectionsStore(vaultRoot).putCurrent(snapshot);

    const requested = encodeURIComponent(`timeline-visit:${canonicalWithSlash}`);
    const r = await get(`/v1/connections/nodes/${requested}/neighbors?hops=1`);

    expect(r.status).toBe(200);
    const body = r.data as {
      data: {
        snapshot: {
          scope: { nodeId?: string };
          nodes: { id: string }[];
          edges: { kind: string }[];
        };
      };
    };
    const ids = body.data.snapshot.nodes.map((n) => n.id);
    expect(body.data.snapshot.scope.nodeId).toBe(anchorId);
    expect(ids).toContain(anchorId);
    expect(ids).toContain(neighborId);
    expect(body.data.snapshot.edges).toContainEqual(
      expect.objectContaining({ kind: 'visit_resembles_visit' }),
    );
  });

  it('GET /v1/connections/edges/<id> returns provenance', async () => {
    // First fetch the snapshot to find an actual edge id.
    const snap = await get('/v1/connections');
    const edgeId = (snap.data as { data: { snapshot: { edges: { id: string }[] } } }).data.snapshot
      .edges[0]?.id;
    expect(edgeId).toBeDefined();
    const r = await get(`/v1/connections/edges/${encodeURIComponent(edgeId!)}`);
    expect(r.status).toBe(200);
    const body = r.data as {
      data: {
        edge: {
          id: string;
          kind: string;
          producedBy: { source: string; eventType?: string };
        };
      };
    };
    expect(body.data.edge.id).toBe(edgeId);
    expect(body.data.edge.producedBy.source).toBe('event-log');
  });

  it('GET /v1/connections/path returns a path between connected nodes', async () => {
    const r = await get(
      '/v1/connections/path?fromNodeId=thread%3Athread_a&toNodeId=workstream%3Aws_x',
    );
    expect(r.status).toBe(200);
    const body = r.data as { data: { found: boolean; nodes?: unknown[]; edges?: unknown[] } };
    expect(body.data.found).toBe(true);
    expect(body.data.nodes?.length).toBeGreaterThanOrEqual(2);
    expect(body.data.edges?.length).toBeGreaterThanOrEqual(1);
  });

  it('returns 503 for connections routes when materializer is not wired', async () => {
    // Spin up a fresh server WITHOUT a connectionsStore in the
    // context — the routes must report 503 honestly.
    const idempotencyStore = createIdempotencyStore(vaultRoot);
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const server = createCompanionHttpServer({
      bridgeKey: BRIDGE,
      vaultWriter: createVaultWriter(vaultRoot),
      vaultRoot,
      idempotencyStore,
      replica,
      eventLog,
      // connectionsStore intentionally omitted
    });
    const started = await startHttpServer(server, 0);
    try {
      const res = await fetch(`${started.url}/v1/connections`, {
        headers: { 'x-bac-bridge-key': BRIDGE },
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code?: string; status?: number };
      expect(body.code).toBe('CONNECTIONS_NOT_WIRED');
    } finally {
      await started.close();
    }
  });
});
