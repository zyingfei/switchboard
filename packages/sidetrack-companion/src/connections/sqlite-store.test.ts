import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createConnectionsStore, SqliteConnectionsStore } from './snapshot.js';
import {
  edgeIdFor,
  type ConnectionEdge,
  type ConnectionNode,
  type ConnectionsSnapshot,
} from './types.js';
import { EMPTY_PROGRESS } from '../sync/contract/materializerProgress.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const node = (id: string, kind: ConnectionNode['kind'], label: string): ConnectionNode => ({
  id,
  kind,
  label,
  originReplicaIds: [],
  metadata: {},
});

const edge = (
  kind: ConnectionEdge['kind'],
  fromNodeId: string,
  toNodeId: string,
  observedAt: string,
): ConnectionEdge => ({
  id: edgeIdFor(kind, fromNodeId, toNodeId),
  kind,
  fromNodeId,
  toNodeId,
  observedAt,
  producedBy: { source: 'event-log' },
  confidence: 'observed',
});

const buildSnapshot = (): ConnectionsSnapshot => {
  const thread = node('thread:alpha', 'thread', 'Alpha');
  const workstream = node('workstream:main', 'workstream', 'Main');
  const dispatch = node('dispatch:one', 'dispatch', 'Dispatch');
  return {
    scope: {},
    nodes: [thread, workstream, dispatch],
    edges: [
      edge('thread_in_workstream', thread.id, workstream.id, '2026-05-01T00:00:00.000Z'),
      edge('annotation_targets_workstream', thread.id, workstream.id, '2026-05-01T00:00:01.000Z'),
      edge('dispatch_in_workstream', dispatch.id, workstream.id, '2026-05-01T00:00:02.000Z'),
    ],
    updatedAt: '2026-05-01T00:00:02.000Z',
    nodeCount: 3,
    edgeCount: 3,
    snapshotRevision: 'rev-sqlite-test',
  };
};

const buildTraversalSnapshot = (): ConnectionsSnapshot => {
  const tab = node('tab-session:ts-1', 'tab-session', 'Tab 1');
  const visit = node('timeline-visit:https://example.test/page', 'timeline-visit', 'Example');
  const instance: ConnectionNode = {
    ...node('visit-instance:ts-1:0:https://example.test/page', 'visit-instance', 'Example visit'),
    metadata: { canonicalUrl: 'https://example.test/page' },
  };
  const workstream = node('workstream:main', 'workstream', 'Main');
  const unrelated = node('workstream:other', 'workstream', 'Other');
  return {
    scope: {},
    nodes: [tab, visit, instance, workstream, unrelated],
    edges: [
      edge('visit_in_tab_session', visit.id, tab.id, '2026-05-01T00:00:00.000Z'),
      edge(
        'visit_instance_same_url_as_timeline_visit',
        instance.id,
        visit.id,
        '2026-05-01T00:00:01.000Z',
      ),
      edge('visit_in_workstream', visit.id, workstream.id, '2026-05-01T00:00:02.000Z'),
    ],
    updatedAt: '2026-05-01T00:00:02.000Z',
    nodeCount: 5,
    edgeCount: 3,
    urlProjection: {
      schemaVersion: 1,
      byCanonicalUrl: {},
    },
    tabSessionProjection: {
      schemaVersion: 1,
      bySessionId: {},
      openSessionsByTabId: {},
    },
    snapshotRevision: 'rev-traversal',
  };
};

describe('SqliteConnectionsStore', () => {
  let vaultRoot: string | null = null;

  afterEach(async () => {
    delete process.env['SIDETRACK_CONNECTIONS_STORE'];
    if (vaultRoot !== null) {
      await rm(vaultRoot, { recursive: true, force: true });
      vaultRoot = null;
    }
  });

  sqliteIt('round-trips putCurrent/readCurrent without changing snapshot shape', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    const snapshot = buildSnapshot();

    await store.putCurrent(snapshot);

    expect(await store.readCurrent()).toEqual(snapshot);
    store.close();
  });

  sqliteIt('returns only requested nodes and connecting edges from readSubgraph', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    const snapshot = buildSnapshot();
    await store.putCurrent(snapshot);

    const subgraph = await store.readSubgraph(['thread:alpha', 'workstream:main']);

    expect(subgraph?.nodes.map((n) => n.id)).toEqual(['thread:alpha', 'workstream:main']);
    expect(subgraph?.edges.map((e) => e.kind)).toEqual([
      'annotation_targets_workstream',
      'thread_in_workstream',
    ]);
    expect(subgraph?.nodeCount).toBe(2);
    expect(subgraph?.edgeCount).toBe(2);
    store.close();
  });

  sqliteIt('reads node neighborhoods without materializing unrelated nodes', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    await store.putCurrent(buildTraversalSnapshot());

    const subgraph = await store.readSubgraphForNode('tab-session:ts-1', 1);

    expect(subgraph?.nodes.map((n) => n.id)).toEqual([
      'tab-session:ts-1',
      'timeline-visit:https://example.test/page',
    ]);
    expect(subgraph?.edges.map((e) => e.kind)).toEqual(['visit_in_tab_session']);
    expect(subgraph?.nodeCount).toBe(2);
    expect(subgraph?.edgeCount).toBe(1);
    store.close();
  });

  sqliteIt('resolver subgraph reads route through bulk readCurrent (perf parity)', async () => {
    // The seed-expansion BFS-based partial read walked the connected
    // component one node at a time and was measurably slower than the
    // bulk readCurrent on a dense graph (live cold-path resolves were
    // ~1–3s before the change). The resolver subgraph methods now
    // forward to readCurrent; this test pins the new contract
    // (full-snapshot parity) so the BFS path is not silently
    // reintroduced. See the TODO comment in snapshot.ts for the
    // future bounded-hops + bulk-expansion partial-read design.
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    await store.putCurrent(buildTraversalSnapshot());

    const fromUrl = await store.readResolverSubgraphForUrl('https://example.test/page');
    const fromTabSession = await store.readResolverSubgraphForTabSession('ts-1');
    const fromThread = await store.readResolverSubgraphForThread({ threadId: 'alpha' });
    const current = await store.readCurrent();

    expect(fromUrl).toEqual(current);
    expect(fromTabSession).toEqual(current);
    expect(fromThread).toEqual(current);
    // Full-snapshot counts and edge cardinality preserved.
    expect(fromUrl?.nodeCount).toBe(5);
    expect(fromUrl?.edgeCount).toBe(3);
    expect(fromUrl?.edges).toHaveLength(3);
    store.close();
  });

  sqliteIt('memoizes readCurrent across calls and invalidates on putCurrent', async () => {
    // Without the memo, every cold resolve repeats ~17K JSON.parses
    // to materialize the whole snapshot. Sibling resolves within the
    // same revision must share a single bulk read.
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    await store.putCurrent(buildTraversalSnapshot());

    const a = await store.readCurrent();
    const b = await store.readCurrent();
    expect(b).toBe(a); // same object identity proves the memo

    // putCurrent invalidates; next read re-materializes against the
    // new snapshotRevision.
    await store.putCurrent({
      ...buildTraversalSnapshot(),
      snapshotRevision: 'rev-changed',
    });
    const c = await store.readCurrent();
    expect(c).not.toBe(a);
    expect(c?.snapshotRevision).toBe('rev-changed');
    store.close();
  });

  sqliteIt('reads snapshot metadata and individual edges without full snapshot reads', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    const snapshot = buildTraversalSnapshot();
    await store.putCurrent(snapshot);

    const metadata = await store.readSnapshotMetadata();
    const foundEdge = await store.readEdge(snapshot.edges[0]?.id ?? '');

    expect(metadata?.snapshotRevision).toBe('rev-traversal');
    expect(metadata?.urlProjection).toEqual(snapshot.urlProjection);
    expect(metadata?.tabSessionProjection).toEqual(snapshot.tabSessionProjection);
    expect(foundEdge).toEqual(snapshot.edges[0]);
    store.close();
  });

  sqliteIt('round-trips scope membership rows through replaceScopeRows', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    const thread = node('thread:alpha', 'thread', 'Alpha');
    const workstream = node('workstream:main', 'workstream', 'Main');
    const membership = edge(
      'thread_in_workstream',
      thread.id,
      workstream.id,
      '2026-05-01T00:00:00.000Z',
    );

    await store.replaceScopeRows({
      scopes: [
        { kind: 'thread', id: 'alpha' },
        { kind: 'workstream', id: 'main' },
      ],
      nodes: [thread, workstream],
      edges: [membership],
      progress: {
        ...EMPTY_PROGRESS('connections', 'connections@test'),
        snapshotRevisionId: 'rev-scopes',
      },
    });

    await expect(store.readScopesForNode('thread:alpha')).resolves.toEqual([
      { kind: 'thread', id: 'alpha' },
      { kind: 'workstream', id: 'main' },
    ]);
    await expect(store.readScopesForEdge(thread.id, workstream.id)).resolves.toEqual([
      { kind: 'thread', id: 'alpha' },
      { kind: 'workstream', id: 'main' },
    ]);
    await expect(store.readNodesForScope({ kind: 'workstream', id: 'main' })).resolves.toEqual([
      'thread:alpha',
      'workstream:main',
    ]);
    await expect(store.readEdgesForScope({ kind: 'thread', id: 'alpha' })).resolves.toEqual([
      { src: thread.id, dst: workstream.id },
    ]);
    expect((await store.readCurrent())?.snapshotRevision).toBe('rev-scopes');
    store.close();
  });

  sqliteIt('rolls back scope replacement when progress write fails', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    const snapshot = buildSnapshot();
    const progress = {
      ...EMPTY_PROGRESS('connections', 'connections@test'),
      appliedDotIntervals: { replica: [[1, 1] as const] },
      appliedFrontier: { replica: 1 },
      snapshotRevisionId: snapshot.snapshotRevision ?? null,
    };
    await store.writeSnapshotAndProgress(snapshot, progress);

    const changedThread = { ...snapshot.nodes[0]!, label: 'Changed' };
    await expect(
      store.replaceScopeRows({
        scopes: [{ kind: 'thread', id: 'alpha' }],
        nodes: [changedThread],
        edges: [],
        progress: {
          ...progress,
          appliedDotIntervals: { replica: [[1, 1] as const, [1, 2] as const] },
          appliedFrontier: { replica: 2 },
          snapshotRevisionId: 'rev-should-roll-back',
        },
      }),
    ).rejects.toThrow();

    expect(await store.readCurrent()).toEqual(snapshot);
    expect(await store.readMaterializerProgress('connections')).toEqual(progress);
    store.close();
  });

  sqliteIt(
    'keeps readCurrent parity with the JSON store across changed and stale rows',
    async () => {
      vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-sqlite-parity-'));
      const jsonRoot = join(vaultRoot, 'json');
      const sqliteStore = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
      process.env['SIDETRACK_CONNECTIONS_STORE'] = 'json';
      const jsonStore = createConnectionsStore(jsonRoot);
      delete process.env['SIDETRACK_CONNECTIONS_STORE'];
      const first = buildSnapshot();
      const second: ConnectionsSnapshot = {
        ...first,
        nodes: [
          {
            ...first.nodes[0]!,
            label: 'Alpha renamed',
          },
          first.nodes[1]!,
        ],
        edges: [first.edges[0]!],
        nodeCount: 2,
        edgeCount: 1,
        snapshotRevision: 'rev-sqlite-test-2',
      };

      await sqliteStore.putCurrent(first);
      await jsonStore.putCurrent(first);
      expect(await sqliteStore.readCurrent()).toEqual(await jsonStore.readCurrent());

      await sqliteStore.putCurrent(second);
      await jsonStore.putCurrent(second);

      expect(await sqliteStore.readCurrent()).toEqual(await jsonStore.readCurrent());
      expect(await sqliteStore.readSubgraph(['thread:alpha', 'workstream:main'])).toEqual({
        ...second,
        nodes: second.nodes,
        edges: second.edges,
      });
      sqliteStore.close();
    },
  );

  sqliteIt('handles empty current snapshots and empty subgraph requests', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    const snapshot: ConnectionsSnapshot = {
      scope: {},
      nodes: [],
      edges: [],
      updatedAt: '',
      nodeCount: 0,
      edgeCount: 0,
      snapshotRevision: 'rev-empty',
    };

    await store.putCurrent(snapshot);

    expect(await store.readCurrent()).toEqual(snapshot);
    expect(await store.readSubgraph([])).toEqual(snapshot);
    store.close();
  });

  it('uses JSON current.json when SIDETRACK_CONNECTIONS_STORE=json', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-sqlite-fallback-'));
    process.env['SIDETRACK_CONNECTIONS_STORE'] = 'json';
    const store = createConnectionsStore(vaultRoot);
    const snapshot: ConnectionsSnapshot = {
      scope: {},
      nodes: [],
      edges: [],
      updatedAt: '2026-05-01T00:00:00.000Z',
      nodeCount: 0,
      edgeCount: 0,
      snapshotRevision: 'rev-json-default',
    };

    expect(store).not.toBeInstanceOf(SqliteConnectionsStore);
    await store.putCurrent(snapshot);

    await expect(
      stat(join(vaultRoot, '_BAC', 'connections', 'current.json')),
    ).resolves.toBeDefined();
    expect(await store.readCurrent()).toEqual(snapshot);
  });

  it('returns the SQLite store by default', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-sqlite-flag-'));

    const store = createConnectionsStore(vaultRoot);

    expect(store).toBeInstanceOf(SqliteConnectionsStore);
    if (store instanceof SqliteConnectionsStore) store.close();
  });

  sqliteIt('imports current.json into an empty SQLite database on first read', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-sqlite-bootstrap-'));
    const snapshot = buildTraversalSnapshot();
    process.env['SIDETRACK_CONNECTIONS_STORE'] = 'json';
    const jsonStore = createConnectionsStore(vaultRoot);
    await jsonStore.putCurrent(snapshot);
    delete process.env['SIDETRACK_CONNECTIONS_STORE'];

    const sqliteStore = new SqliteConnectionsStore(vaultRoot, { databasePath: ':memory:' });

    expect(await sqliteStore.readCurrent()).toEqual(snapshot);
    expect(await sqliteStore.readSubgraph(['tab-session:ts-1'])).toMatchObject({
      snapshotRevision: 'rev-traversal',
    });
    sqliteStore.close();
  });

  sqliteIt(
    'factory-selected SQLite store preserves JSON readCurrent behavior under the flag',
    async () => {
      vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-sqlite-factory-parity-'));
      const sqliteRoot = join(vaultRoot, 'sqlite');
      const jsonRoot = join(vaultRoot, 'json');
      const snapshot = buildTraversalSnapshot();

      const sqliteStore = createConnectionsStore(sqliteRoot);
      process.env['SIDETRACK_CONNECTIONS_STORE'] = 'json';
      const jsonStore = createConnectionsStore(jsonRoot);
      delete process.env['SIDETRACK_CONNECTIONS_STORE'];

      await sqliteStore.putCurrent(snapshot);
      await jsonStore.putCurrent(snapshot);

      expect(await sqliteStore.readCurrent()).toEqual(await jsonStore.readCurrent());
      expect(await stat(join(sqliteRoot, '_BAC', 'connections', 'current.db'))).toBeDefined();
      if (sqliteStore instanceof SqliteConnectionsStore) sqliteStore.close();
    },
  );
});
