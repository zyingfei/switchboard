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

  it('keeps JSON current.json as the default when the flag is unset', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-sqlite-fallback-'));
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

  it('returns the SQLite store when SIDETRACK_CONNECTIONS_STORE=sqlite', async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-sqlite-flag-'));
    process.env['SIDETRACK_CONNECTIONS_STORE'] = 'sqlite';

    const store = createConnectionsStore(vaultRoot);

    expect(store).toBeInstanceOf(SqliteConnectionsStore);
    if (store instanceof SqliteConnectionsStore) store.close();
  });
});
