import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createConnectionsStore,
  SqliteConnectionsStore,
  type ConnectionsProjectionAccumulatorWrite,
} from './snapshot.js';
import { connectionsGraphSig } from '../http/server.js';
import {
  edgeIdFor,
  type ConnectionEdge,
  type ConnectionNode,
  type ConnectionsSnapshot,
} from './types.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { EMPTY_PROGRESS } from '../sync/contract/materializerProgress.js';
import type { UrlVisitRecord } from '../urls/projection.js';
import { createEmptyTabSessionProjectionAccumulator } from '../tabsession/projection.js';

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
  const thread = node('thread:alpha', 'thread', 'Alpha');
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
    nodes: [thread, tab, visit, instance, workstream, unrelated],
    edges: [
      edge('visit_in_tab_session', visit.id, tab.id, '2026-05-01T00:00:00.000Z'),
      edge(
        'visit_instance_same_url_as_timeline_visit',
        instance.id,
        visit.id,
        '2026-05-01T00:00:01.000Z',
      ),
      edge('visit_in_workstream', visit.id, workstream.id, '2026-05-01T00:00:02.000Z'),
      edge('timeline_same_url_as_thread', visit.id, thread.id, '2026-05-01T00:00:03.000Z'),
    ],
    updatedAt: '2026-05-01T00:00:03.000Z',
    nodeCount: 6,
    edgeCount: 4,
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

const progressFor = (snapshot: ConnectionsSnapshot) => ({
  ...EMPTY_PROGRESS('connections', 'connections@test'),
  appliedDotIntervals: { replica: [[1, 1] as const] },
  appliedFrontier: { replica: 1 },
  snapshotRevisionId: snapshot.snapshotRevision ?? null,
});

const timelineObservedEvent = (input: {
  readonly seq: number;
  readonly canonicalUrl: string;
  readonly tabSessionId: string;
  readonly observedAt: string;
  readonly title?: string;
}): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica', seq: input.seq },
  deps: {},
  aggregateId: `timeline:${input.canonicalUrl}`,
  type: 'browser.timeline.observed',
  payload: {
    payloadVersion: 1,
    eventId: `visit-${String(input.seq)}`,
    observedAt: input.observedAt,
    url: input.canonicalUrl,
    canonicalUrl: input.canonicalUrl,
    ...(input.title === undefined ? {} : { title: input.title }),
    provider: 'generic',
    transition: 'activated',
    tabSessionId: input.tabSessionId,
    tabIdHash: `tab-${input.tabSessionId}`,
  },
  acceptedAtMs: Date.parse(input.observedAt),
});

describe('SqliteConnectionsStore', () => {
  let vaultRoot: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env['SIDETRACK_CONNECTIONS_STORE'];
    delete process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SCOPES'];
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

  sqliteIt(
    'resolver subgraph reads bounded neighborhoods without materializing unrelated rows',
    async () => {
      const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
      await store.putCurrent(buildTraversalSnapshot());

      const fromUrl = await store.readResolverSubgraphForUrl('https://example.test/page');
      const fromTabSession = await store.readResolverSubgraphForTabSession('ts-1');
      const fromThread = await store.readResolverSubgraphForThread({ threadId: 'alpha' });
      const current = await store.readCurrent();

      expect(current?.nodes.map((n) => n.id)).toContain('workstream:other');
      expect(fromUrl?.snapshotRevision).toBe('rev-traversal');
      expect(fromUrl?.nodes.map((n) => n.id)).toEqual([
        'tab-session:ts-1',
        'thread:alpha',
        'timeline-visit:https://example.test/page',
        'visit-instance:ts-1:0:https://example.test/page',
        'workstream:main',
      ]);
      expect(fromUrl?.nodes.map((n) => n.id)).not.toContain('workstream:other');
      expect(fromUrl?.edges.map((e) => e.kind)).toEqual([
        'timeline_same_url_as_thread',
        'visit_in_tab_session',
        'visit_in_workstream',
        'visit_instance_same_url_as_timeline_visit',
      ]);
      expect(fromUrl?.nodeCount).toBe(5);
      expect(fromUrl?.edgeCount).toBe(4);
      expect(fromTabSession).toEqual(fromUrl);
      expect(fromThread).toEqual(fromUrl);
      store.close();
    },
  );

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

  // W2 (window-poverty fix) — the served similarity revision id + eligible-
  // corpus signature round-trip through StoredConnectionsMetadata so the
  // resolve SWR graph signature (server.ts) can key on them instead of the
  // volatile node/edge counts.
  sqliteIt(
    'round-trips visitSimilarityRevisionId + similarityCorpusSignature through metadata',
    async () => {
      const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
      const snapshot: ConnectionsSnapshot = {
        ...buildTraversalSnapshot(),
        visitSimilarityRevisionId: 'rev-sim-abc',
        similarityCorpusSignature: 'corpus:9:deadbeef',
      };
      await store.writeSnapshotAndProgress(snapshot, progressFor(snapshot));
      const metadata = await store.readSnapshotMetadata();
      expect(metadata?.visitSimilarityRevisionId).toBe('rev-sim-abc');
      expect(metadata?.similarityCorpusSignature).toBe('corpus:9:deadbeef');
      // W2 — the non-similarity structural discriminator is derived + persisted
      // from the snapshot's edges (buildTraversalSnapshot has 4 edges, none in
      // the similarity family). Metadata-only: NOT surfaced on readCurrent().
      expect(metadata?.nonSimilarityEdgeCount).toBe(4);
      const current = await store.readCurrent();
      expect(current?.visitSimilarityRevisionId).toBe('rev-sim-abc');
      expect(current?.similarityCorpusSignature).toBe('corpus:9:deadbeef');
      expect(
        (current as unknown as { nonSimilarityEdgeCount?: number }).nonSimilarityEdgeCount,
      ).toBeUndefined();
      store.close();
    },
  );

  // W2 — the resolve SWR graph signature (connectionsGraphSig → sqliteSig)
  // must NOT rotate on the SIMILARITY-family edge oscillation (the window-poor
  // render flux that busted the resolve cache ~35/40 drains), but MUST rotate
  // when (a) the served similarity revision / corpus signature changes OR (b) a
  // NON-similarity graph row changes (a new thread/attribution/topic edge or
  // node). Part (b) is the missed-bust the pure similarity-revision key would
  // have swallowed — the non-similarity structural discriminator
  // (nodeCount:nonSimilarityEdgeCount) closes it.
  sqliteIt(
    'graph signature ignores similarity-family flux but rotates on similarity-revision AND non-similarity graph changes',
    async () => {
      // All snapshots share the same updatedAt, so the sig's mtime BUCKET term
      // is constant across the writes — only the graph TERM can differ.
      const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
      const base = buildTraversalSnapshot();
      // Two similarity-family edges (visit_resembles_visit) between the visit
      // and thread nodes present in the traversal snapshot. These are the rows
      // Pass-7 drops/restores on a window-poor render.
      const visitId = 'timeline-visit:https://example.test/page';
      const threadId = 'thread:alpha';
      const simEdgeA = edge('visit_resembles_visit', visitId, threadId, '2026-05-01T00:00:04.000Z');
      const withSim: ConnectionsSnapshot = {
        ...base,
        nodes: base.nodes,
        edges: [...base.edges, simEdgeA],
        nodeCount: base.nodeCount,
        edgeCount: base.edges.length + 1,
        visitSimilarityRevisionId: 'rev-sim-1',
        similarityCorpusSignature: 'corpus:9:aaaa',
      };
      await store.writeSnapshotAndProgress(withSim, progressFor(withSim));
      const sig1 = await connectionsGraphSig(store, '/unused/current.json');

      // (benign) DROP the similarity-family edge — the Pass-7 window-poor flux.
      // The similarity revision + corpus signature + non-similarity rows are
      // unchanged, so the sig MUST be stable (no cache bust).
      const simDropped: ConnectionsSnapshot = {
        ...withSim,
        edges: base.edges,
        edgeCount: base.edges.length,
      };
      await store.writeSnapshotAndProgress(simDropped, progressFor(simDropped));
      const sig2 = await connectionsGraphSig(store, '/unused/current.json');
      expect(sig2).toBe(sig1); // stable — no cache bust on similarity-family flux

      // (real change) ADD a NON-similarity edge (a new thread↔workstream link)
      // WITHOUT touching the similarity revision — the missed-bust the pure
      // similarity key would swallow. The sig MUST rotate.
      const nonSimEdge = edge(
        'thread_in_workstream',
        threadId,
        'workstream:other',
        '2026-05-01T00:00:05.000Z',
      );
      const nonSimChanged: ConnectionsSnapshot = {
        ...simDropped,
        edges: [...base.edges, nonSimEdge],
        edgeCount: base.edges.length + 1,
      };
      await store.writeSnapshotAndProgress(nonSimChanged, progressFor(nonSimChanged));
      const sig3 = await connectionsGraphSig(store, '/unused/current.json');
      expect(sig3).not.toBe(sig2); // non-similarity structural change busts the cache

      // (real change) rotate the similarity revision — the sig MUST rotate.
      const revChanged: ConnectionsSnapshot = {
        ...nonSimChanged,
        visitSimilarityRevisionId: 'rev-sim-2',
      };
      await store.writeSnapshotAndProgress(revChanged, progressFor(revChanged));
      const sig4 = await connectionsGraphSig(store, '/unused/current.json');
      expect(sig4).not.toBe(sig3);
      store.close();
    },
  );

  sqliteIt('applies projection event overlays without rewriting graph rows', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    const snapshot = buildTraversalSnapshot();
    await store.putCurrent(snapshot);

    const revision = await store.applyProjectionEventOverlay(
      timelineObservedEvent({
        seq: 2,
        canonicalUrl: 'https://news.ycombinator.com/newest',
        tabSessionId: 'ts-hn',
        observedAt: '2026-05-23T15:00:00.000Z',
        title: 'New | Hacker News',
      }),
    );

    expect(revision).not.toBeNull();
    expect(revision).not.toBe(snapshot.snapshotRevision);
    const metadata = await store.readSnapshotMetadata();
    expect(metadata?.nodeCount).toBe(snapshot.nodeCount);
    expect(metadata?.edgeCount).toBe(snapshot.edgeCount);
    expect(
      metadata?.urlProjection?.byCanonicalUrl['https://news.ycombinator.com/newest'],
    ).toMatchObject({
      latestTitle: 'New | Hacker News',
      visitCount: 1,
      tabSessionIds: ['ts-hn'],
    });
    expect(metadata?.tabSessionProjection?.bySessionId['ts-hn']).toMatchObject({
      latestTitle: 'New | Hacker News',
      latestUrl: 'https://news.ycombinator.com/newest',
    });
    const current = await store.readCurrent();
    expect(current?.nodes).toEqual(snapshot.nodes);
    expect(current?.edges).toEqual(snapshot.edges);
    expect(
      current?.urlProjection?.byCanonicalUrl['https://news.ycombinator.com/newest']?.latestTitle,
    ).toBe('New | Hacker News');
    store.close();
  });

  sqliteIt(
    'preserves fresher projection overlays when an older full snapshot commits',
    async () => {
      const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
      const snapshot = buildTraversalSnapshot();
      await store.writeSnapshotAndProgress(snapshot, progressFor(snapshot));

      const overlayRevision = await store.applyProjectionEventOverlay(
        timelineObservedEvent({
          seq: 2,
          canonicalUrl: 'https://news.ycombinator.com/newest',
          tabSessionId: 'ts-hn',
          observedAt: '2026-05-23T15:00:00.000Z',
          title: 'New | Hacker News',
        }),
      );
      expect(overlayRevision).not.toBeNull();

      await store.writeSnapshotAndProgress(
        {
          ...snapshot,
          snapshotRevision: 'rev-child-started-before-overlay',
        },
        {
          ...progressFor(snapshot),
          snapshotRevisionId: 'rev-child-started-before-overlay',
        },
      );

      const current = await store.readCurrent();
      expect(
        current?.urlProjection?.byCanonicalUrl['https://news.ycombinator.com/newest']?.latestTitle,
      ).toBe('New | Hacker News');
      expect(current?.tabSessionProjection?.bySessionId['ts-hn']?.latestUrl).toBe(
        'https://news.ycombinator.com/newest',
      );
      expect(current?.snapshotRevision).not.toBe('rev-child-started-before-overlay');
      expect(current?.nodes).toEqual(snapshot.nodes);
      expect(current?.edges).toEqual(snapshot.edges);
      store.close();
    },
  );

  sqliteIt('round-trips resolver-result cache by visit id and snapshot revision', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    await expect(
      store.getCachedResolverResult('https://example.test/a', 'rev-a'),
    ).resolves.toBeNull();

    const result = { canonicalUrl: 'https://example.test/a', decision: { action: 'inbox' } };
    await store.cacheResolverResult('https://example.test/a', 'rev-a', result);

    await expect(store.getCachedResolverResult('https://example.test/a', 'rev-a')).resolves.toEqual(
      result,
    );
    store.close();
  });

  sqliteIt('invalidates resolver-result cache entries from older snapshot revisions', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    await store.cacheResolverResult('https://example.test/a', 'rev-old', { old: true });
    await store.cacheResolverResult('https://example.test/b', 'rev-current', { current: true });

    await expect(
      store.getCachedResolverResult('https://example.test/b', 'rev-current'),
    ).resolves.toEqual({ current: true });
    await expect(
      store.getCachedResolverResult('https://example.test/a', 'rev-old'),
    ).resolves.toBeNull();
    store.close();
  });

  // The resolver cache shares current.db with the drain child's long write
  // transactions. When the child holds the write lock, a cache read/write
  // hits "database is locked" (SQLITE_BUSY) — that must NEVER fail the
  // resolve. We inject the lock error at the sqlite statement seam (same
  // Database.prototype.query spy pattern the rollback test uses) and assert
  // the store degrades: the WRITE is skipped silently, the READ becomes a
  // cache miss so the caller recomputes inline instead of the route 500ing.
  const sqliteBusyError = (): Error => {
    const error = new Error('database is locked') as Error & { code?: string };
    error.code = 'SQLITE_BUSY';
    return error;
  };

  sqliteIt('cacheResolverResult swallows SQLITE_BUSY writes (serves the computed result)', async () => {
    const { Database } = (await import('bun:sqlite')) as typeof import('bun:sqlite');
    const originalQuery = Database.prototype.query;
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    // Force the schema + connection to exist before we start throwing.
    await store.cacheResolverResult('https://example.test/a', 'rev-a', { primed: true });

    vi.spyOn(Database.prototype, 'query').mockImplementation(function queryWithLockedWrite(
      this: InstanceType<typeof Database>,
      sql: string,
    ) {
      const statement = originalQuery.call(this, sql);
      if (!sql.includes('INSERT INTO connections_resolver_cache')) return statement;
      return { ...statement, run: () => { throw sqliteBusyError(); } };
    });

    // Best-effort: resolves (undefined) rather than rejecting.
    await expect(
      store.cacheResolverResult('https://example.test/b', 'rev-a', { blocked: true }),
    ).resolves.toBeUndefined();

    vi.restoreAllMocks();
    // The prior successful write survived; the locked one simply didn't land.
    await expect(
      store.getCachedResolverResult('https://example.test/a', 'rev-a'),
    ).resolves.toEqual({ primed: true });
    await expect(
      store.getCachedResolverResult('https://example.test/b', 'rev-a'),
    ).resolves.toBeNull();
    store.close();
  });

  sqliteIt('getCachedResolverResult degrades to a cache miss on SQLITE_BUSY reads', async () => {
    const { Database } = (await import('bun:sqlite')) as typeof import('bun:sqlite');
    const originalQuery = Database.prototype.query;
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    await store.cacheResolverResult('https://example.test/a', 'rev-a', { cached: true });

    vi.spyOn(Database.prototype, 'query').mockImplementation(function queryWithLockedRead(
      this: InstanceType<typeof Database>,
      sql: string,
    ) {
      const statement = originalQuery.call(this, sql);
      if (!sql.includes('FROM connections_resolver_cache')) return statement;
      return { ...statement, get: () => { throw sqliteBusyError(); } };
    });

    // Degrades to a miss (null) instead of throwing, so the caller computes
    // the result inline rather than the route returning a 500.
    await expect(
      store.getCachedResolverResult('https://example.test/a', 'rev-a'),
    ).resolves.toBeNull();

    vi.restoreAllMocks();
    // The row is intact — only the read attempt was blocked.
    await expect(
      store.getCachedResolverResult('https://example.test/a', 'rev-a'),
    ).resolves.toEqual({ cached: true });
    store.close();
  });

  sqliteIt('getCachedResolverResult rethrows NON-lock read errors (never masks real corruption)', async () => {
    const { Database } = (await import('bun:sqlite')) as typeof import('bun:sqlite');
    const originalQuery = Database.prototype.query;
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    await store.cacheResolverResult('https://example.test/a', 'rev-a', { cached: true });

    vi.spyOn(Database.prototype, 'query').mockImplementation(function queryWithCorruptRead(
      this: InstanceType<typeof Database>,
      sql: string,
    ) {
      const statement = originalQuery.call(this, sql);
      if (!sql.includes('FROM connections_resolver_cache')) return statement;
      return { ...statement, get: () => { throw new Error('malformed database schema'); } };
    });

    await expect(
      store.getCachedResolverResult('https://example.test/a', 'rev-a'),
    ).rejects.toThrow('malformed database schema');
    vi.restoreAllMocks();
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

  sqliteIt('skips scope membership writes when incremental scopes flag is off', async () => {
    process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SCOPES'] = '0';
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    const snapshot = buildSnapshot();

    await store.writeSnapshotAndProgress(snapshot, progressFor(snapshot));

    await expect(store.readNodesForScope({ kind: 'thread', id: 'alpha' })).resolves.toEqual([]);
    await expect(store.readEdgesForScope({ kind: 'thread', id: 'alpha' })).resolves.toEqual([]);
    await expect(store.readNodesForScope({ kind: 'workstream', id: 'main' })).resolves.toEqual([]);
    await expect(store.readEdgesForScope({ kind: 'workstream', id: 'main' })).resolves.toEqual([]);
    store.close();
  });

  sqliteIt('writes scope membership rows when incremental scopes flag is on', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    const snapshot = buildSnapshot();

    await store.writeSnapshotAndProgress(snapshot, progressFor(snapshot));
    await new Promise((resolve) => setImmediate(resolve));

    await expect(store.readNodesForScope({ kind: 'thread', id: 'alpha' })).resolves.toEqual([
      'thread:alpha',
    ]);
    await expect(store.readEdgesForScope({ kind: 'thread', id: 'alpha' })).resolves.toEqual([
      { src: 'thread:alpha', dst: 'workstream:main' },
    ]);
    await expect(store.readNodesForScope({ kind: 'workstream', id: 'main' })).resolves.toEqual([
      'dispatch:one',
      'workstream:main',
    ]);
    await expect(store.readEdgesForScope({ kind: 'workstream', id: 'main' })).resolves.toEqual([
      { src: 'dispatch:one', dst: 'workstream:main' },
    ]);
    store.close();
  });

  sqliteIt('selectively replaces only dirty scope membership rows', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    const first = buildSnapshot();
    const second: ConnectionsSnapshot = {
      ...first,
      nodes: [first.nodes[0]!, first.nodes[1]!],
      edges: [first.edges[0]!],
      nodeCount: 2,
      edgeCount: 1,
      snapshotRevision: 'rev-sqlite-test-2',
    };

    await store.writeSnapshotAndProgress(first, progressFor(first));
    await new Promise((resolve) => setImmediate(resolve));
    await store.writeSnapshotAndProgress(
      second,
      progressFor(second),
      new Set([{ kind: 'thread', id: 'alpha' }]),
    );

    await expect(store.readNodesForScope({ kind: 'thread', id: 'alpha' })).resolves.toEqual([
      'thread:alpha',
    ]);
    await expect(store.readEdgesForScope({ kind: 'thread', id: 'alpha' })).resolves.toEqual([
      { src: 'thread:alpha', dst: 'workstream:main' },
    ]);
    await expect(store.readNodesForScope({ kind: 'workstream', id: 'main' })).resolves.toEqual([
      'dispatch:one',
      'workstream:main',
    ]);
    await expect(store.readEdgesForScope({ kind: 'workstream', id: 'main' })).resolves.toEqual([
      { src: 'dispatch:one', dst: 'workstream:main' },
    ]);
    store.close();
  });

  sqliteIt('rolls back selective scope replacement with graph and progress writes', async () => {
    const { Database } = (await import('bun:sqlite')) as typeof import('bun:sqlite');
    const originalQuery = Database.prototype.query;
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    const first = buildSnapshot();
    const firstProgress = progressFor(first);
    const second: ConnectionsSnapshot = {
      ...first,
      nodes: [{ ...first.nodes[0]!, label: 'Changed Alpha' }, first.nodes[1]!],
      edges: [first.edges[0]!],
      nodeCount: 2,
      edgeCount: 1,
      snapshotRevision: 'rev-sqlite-test-2',
    };

    await store.writeSnapshotAndProgress(first, firstProgress);
    await new Promise((resolve) => setImmediate(resolve));
    vi.spyOn(Database.prototype, 'query').mockImplementation(function queryWithProgressCrash(
      this: InstanceType<typeof Database>,
      sql: string,
    ) {
      const statement = originalQuery.call(this, sql);
      if (!sql.includes('INSERT INTO connections_materializer_meta')) return statement;
      return {
        ...statement,
        run: () => {
          throw new Error('simulated progress write crash');
        },
      };
    });

    await expect(
      store.writeSnapshotAndProgress(
        second,
        progressFor(second),
        new Set([{ kind: 'thread', id: 'alpha' }]),
      ),
    ).rejects.toThrow('simulated progress write crash');

    expect(await store.readCurrent()).toEqual(first);
    expect(await store.readMaterializerProgress('connections')).toEqual(firstProgress);
    await expect(store.readNodesForScope({ kind: 'thread', id: 'alpha' })).resolves.toEqual([
      'thread:alpha',
    ]);
    await expect(store.readEdgesForScope({ kind: 'thread', id: 'alpha' })).resolves.toEqual([
      { src: 'thread:alpha', dst: 'workstream:main' },
    ]);
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
    ]);
    await expect(store.readScopesForEdge(thread.id, workstream.id)).resolves.toEqual([
      { kind: 'thread', id: 'alpha' },
    ]);
    await expect(store.readNodesForScope({ kind: 'workstream', id: 'main' })).resolves.toEqual([
      'workstream:main',
    ]);
    await expect(store.readEdgesForScope({ kind: 'thread', id: 'alpha' })).resolves.toEqual([
      { src: thread.id, dst: workstream.id },
    ]);
    const current = await store.readCurrent();
    const progress = await store.readMaterializerProgress('connections');
    expect(current?.snapshotRevision).toBe(progress?.snapshotRevisionId);
    expect(current?.snapshotRevision).not.toBe('rev-scopes');
    store.close();
  });

  sqliteIt('replaceScopeRows patches order metadata without full row scans', async () => {
    const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
    const snapshot = buildSnapshot();
    await store.writeSnapshotAndProgress(snapshot, progressFor(snapshot));
    await new Promise((resolve) => setImmediate(resolve));
    await expect(store.readScopesForNode('thread:alpha')).resolves.toEqual([
      { kind: 'thread', id: 'alpha' },
    ]);

    const { Database } = (await import('bun:sqlite')) as typeof import('bun:sqlite');
    const originalQuery = Database.prototype.query;
    const queries: string[] = [];
    const spy = vi
      .spyOn(Database.prototype, 'query')
      .mockImplementation(function trackScopeReplaceQueries(
        this: InstanceType<typeof Database>,
        sql: string,
      ) {
        queries.push(sql);
        return originalQuery.call(this, sql);
      });
    try {
      await store.replaceScopeRows({
        scopes: [{ kind: 'thread', id: 'alpha' }],
        nodes: [{ ...snapshot.nodes[0]!, label: 'Alpha patched' }],
        edges: [],
        progress: {
          ...progressFor(snapshot),
          appliedDotIntervals: { replica: [[1, 2] as const] },
          appliedFrontier: { replica: 2 },
          snapshotRevisionId: 'rev-scope-patched',
        },
      });
    } finally {
      spy.mockRestore();
    }

    expect(queries.some((sql) => sql.includes('SELECT data FROM nodes ORDER BY id'))).toBe(false);
    expect(queries.some((sql) => sql.includes('SELECT data FROM edges ORDER BY src, dst'))).toBe(
      false,
    );
    expect(
      queries.some((sql) => sql.includes('COUNT(*) AS count FROM connections_scope_edges')),
    ).toBe(false);
    expect(queries.some((sql) => sql.includes('SELECT data FROM edges WHERE src = ?'))).toBe(
      false,
    );
    expect(queries.some((sql) => sql.includes('temp_replace_edges'))).toBe(true);
    const current = await store.readCurrent();
    const progress = await store.readMaterializerProgress('connections');
    expect(current?.snapshotRevision).toBe(progress?.snapshotRevisionId);
    expect(current?.snapshotRevision).not.toBe('rev-scope-patched');
    expect(current?.nodes.find((item) => item.id === 'thread:alpha')?.label).toBe('Alpha patched');
    expect(current?.nodeCount).toBe(3);
    expect(current?.edgeCount).toBe(1);
    store.close();
  });

  // F4 (blob diet) write-volume acceptance (b): a scoped drain touching K
  // accumulator keys must persist O(K) rows, not re-serialize the whole
  // accumulator — the order blob keys must be gone entirely (deleted, not
  // rewritten) after a scoped write, AND the `current` metadata key itself
  // must shrink to a KB-scale tag with no urlProjection/tabSessionProjection
  // — the last per-drain O(state) rewrite (residual named in the prior F4
  // commit's message, closed here).
  sqliteIt(
    'replaceScopeRows persists the projection accumulator as O(dirty keys), not O(state), and shrinks `current` to a small tag',
    async () => {
      const store = new SqliteConnectionsStore('/unused', { databasePath: ':memory:' });
      const snapshot = buildSnapshot();

      // Seed a "large" accumulator (200 canonical URLs) via a full write —
      // full mode is allowed to be O(state), same as the node/edge rows
      // themselves on that path.
      const bigRecords = new Map<string, UrlVisitRecord>();
      for (let i = 0; i < 200; i += 1) {
        const canonicalUrl = `https://big.test/${String(i)}`;
        bigRecords.set(canonicalUrl, {
          canonicalUrl,
          firstSeenAt: '2026-05-01T00:00:00.000Z',
          lastSeenAt: '2026-05-01T00:00:00.000Z',
          visitCount: 1,
          tabSessionIds: [],
          attributionHistory: [],
        });
      }
      const seedWrite: ConnectionsProjectionAccumulatorWrite = {
        materializerName: 'connections',
        materializerVersion: 'connections@test',
        appliedDotIntervals: { replica: [[1, 1]] },
        appliedFrontier: { replica: 1 },
        urlAccumulator: { records: bigRecords, observationCursors: new Map() },
        tabSessionAccumulator: createEmptyTabSessionProjectionAccumulator(),
        dirty: { mode: 'full' },
      };
      await store.writeSnapshotAndProgress(snapshot, progressFor(snapshot), undefined, seedWrite);
      await new Promise((resolve) => setImmediate(resolve));

      const seeded = await store.readProjectionAccumulatorState('connections');
      expect(Object.keys(seeded?.urlAccumulator.byCanonicalUrl ?? {})).toHaveLength(200);

      // Now a scoped delta touching exactly ONE of those 200 keys.
      bigRecords.set('https://big.test/0', {
        canonicalUrl: 'https://big.test/0',
        firstSeenAt: '2026-05-01T00:00:00.000Z',
        lastSeenAt: '2026-05-01T01:00:00.000Z',
        visitCount: 2,
        tabSessionIds: [],
        attributionHistory: [],
      });
      const deltaWrite: ConnectionsProjectionAccumulatorWrite = {
        ...seedWrite,
        appliedDotIntervals: { replica: [[1, 2]] },
        appliedFrontier: { replica: 2 },
        dirty: {
          mode: 'delta',
          canonicalUrls: new Set(['https://big.test/0']),
          tabSessionIds: new Set(),
          openTabIdHashes: new Set(),
        },
      };

      const { Database } = (await import('bun:sqlite')) as typeof import('bun:sqlite');
      const originalQuery = Database.prototype.query;
      const originalExec = Database.prototype.exec;
      const urlUpsertRunCalls: unknown[][] = [];
      let sawOrderDelete = false;
      let sawOrderRewrite = false;
      // F4 (blob diet) — 'current' metadata rewrite volume: captured
      // alongside the accumulator/order assertions below.
      const currentMetadataWrites: string[] = [];
      // bun:sqlite caches/reuses a single Statement object across
      // db.query(sql) calls with IDENTICAL sql text — and this exact
      // upsert-metadata text is used by several call sites within one
      // replaceScopeRows transaction (this write, #persistProjectionAccumu-
      // latorWrite's progress tag, #bumpWriteSeq). Without a wrap guard,
      // each db.query(sameText) call here would layer ANOTHER wrapper
      // around the shared statement's `.run`, so a single real `.run(...)`
      // call fires every layer's closure — inflating the observed call
      // count without any extra DB write actually happening. Mark the
      // wrapped function so re-wrapping the same statement is a no-op.
      const F4_WRAPPED = Symbol('f4WrappedRun');
      const wrapOnce = (
        stmt: { run: (...args: unknown[]) => unknown },
        onRun: (args: readonly unknown[]) => void,
      ): void => {
        if ((stmt.run as { [F4_WRAPPED]?: boolean })[F4_WRAPPED] === true) return;
        const originalRun = stmt.run.bind(stmt);
        const wrapped = (...args: unknown[]): unknown => {
          onRun(args);
          return originalRun(...args);
        };
        (wrapped as { [F4_WRAPPED]?: boolean })[F4_WRAPPED] = true;
        stmt.run = wrapped;
      };
      const querySpy = vi
        .spyOn(Database.prototype, 'query')
        .mockImplementation(function trackUrlAccumulatorWrites(
          this: InstanceType<typeof Database>,
          sql: string,
        ) {
          const stmt = originalQuery.call(this, sql) as {
            run: (...args: unknown[]) => unknown;
          };
          if (sql.includes('INSERT INTO connections_projection_url_accumulator')) {
            wrapOnce(stmt, (args) => urlUpsertRunCalls.push([...args]));
          }
          if (
            sql.includes('INSERT INTO metadata') &&
            sql.includes('ON CONFLICT(key) DO UPDATE')
          ) {
            wrapOnce(stmt, (args) => {
              if (args[0] === 'node_order' || args[0] === 'edge_order') sawOrderRewrite = true;
              if (args[0] === 'current' && typeof args[1] === 'string') {
                currentMetadataWrites.push(args[1]);
              }
            });
          }
          return stmt;
        });
      const execSpy = vi
        .spyOn(Database.prototype, 'exec')
        .mockImplementation(function trackOrderDelete(
          this: InstanceType<typeof Database>,
          sql: string,
        ) {
          if (sql.includes("DELETE FROM metadata WHERE key IN ('node_order', 'edge_order')")) {
            sawOrderDelete = true;
          }
          return originalExec.call(this, sql);
        });
      try {
        await store.replaceScopeRows({
          scopes: [{ kind: 'thread', id: 'alpha' }],
          nodes: [{ ...snapshot.nodes[0]!, label: 'Alpha patched again' }],
          edges: [],
          progress: {
            ...progressFor(snapshot),
            appliedDotIntervals: { replica: [[1, 2] as const] },
            appliedFrontier: { replica: 2 },
            snapshotRevisionId: 'rev-scope-delta-accumulator',
          },
          projectionAccumulatorWrite: deltaWrite,
        });
      } finally {
        querySpy.mockRestore();
        execSpy.mockRestore();
      }

      // The load-bearing assertion: exactly ONE row upsert, not 200 — the
      // delta write touched a single dirty key, so the store must not have
      // re-persisted the other 199 untouched records.
      expect(urlUpsertRunCalls).toHaveLength(1);

      // node_order/edge_order are DELETED (cheap, O(1)), never rewritten as
      // an 18MB/1.9MB blob, by a scoped replaceScopeRows write.
      expect(sawOrderDelete).toBe(true);
      expect(sawOrderRewrite).toBe(false);

      // F4 (blob diet) — the LAST O(state) rewrite this feature eliminates:
      // `current`'s urlProjection/tabSessionProjection fields. Exactly one
      // 'current' write for this scoped delta, and it must be small (a KB-
      // scale metadata tag: scope/updatedAt/counts/revision — no 200-key
      // projection map) and must carry NEITHER projection field at all —
      // #selfHealProjections derives them from the row tables on read.
      expect(currentMetadataWrites).toHaveLength(1);
      const currentWriteJson = currentMetadataWrites[0] ?? '';
      expect(currentWriteJson.length).toBeLessThan(2_000);
      const currentWriteParsed = JSON.parse(currentWriteJson) as Record<string, unknown>;
      expect(currentWriteParsed['urlProjection']).toBeUndefined();
      expect(currentWriteParsed['tabSessionProjection']).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(currentWriteParsed, 'urlProjection')).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(currentWriteParsed, 'tabSessionProjection'),
      ).toBe(false);

      // Correctness: the reused/updated accumulator still reports all 200
      // keys (the delta write did not silently drop the other 199 rows),
      // and the touched key reflects the update.
      const afterDelta = await store.readProjectionAccumulatorState('connections');
      const byCanonicalUrl = afterDelta?.urlAccumulator.byCanonicalUrl ?? {};
      expect(Object.keys(byCanonicalUrl)).toHaveLength(200);
      expect(byCanonicalUrl['https://big.test/0']?.visitCount).toBe(2);
      expect(byCanonicalUrl['https://big.test/1']?.visitCount).toBe(1);

      store.close();
    },
  );

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
      // M4 — under double-buffer (default ON) the SQLite store persists to a
      // published generation file named by the POINTER, not a fixed
      // `current.db`. Assert the pointer + its generation db exist on disk.
      const { readPointer, generationDbPath } = await import('./generationBuffer.js');
      const connectionsDir = join(sqliteRoot, '_BAC', 'connections');
      const gen = readPointer(connectionsDir);
      expect(gen).not.toBeNull();
      expect(await stat(generationDbPath(connectionsDir, gen!))).toBeDefined();
      if (sqliteStore instanceof SqliteConnectionsStore) sqliteStore.close();
    },
  );
});
