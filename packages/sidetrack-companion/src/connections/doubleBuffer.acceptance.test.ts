// M4 double-buffer acceptance tests (D6 a-e), reading back the SERVED
// artifact per the debugging doctrine (rule 10). These drive the REAL store
// write/publish path and read back through the published generation / the
// store's read methods — not the layer under change.

import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteConnectionsStore } from './snapshot.js';
import { readPointer, generationDbPath, residentGenerations } from './generationBuffer.js';
import {
  __resetResolverCacheDeferQueue,
  flushResolverCacheWrites,
  pendingResolverCacheWriteCount,
  queueResolverCacheWrite,
  resolverCacheDeferStats,
} from '../http/resolverCacheDefer.js';
import {
  edgeIdFor,
  type ConnectionEdge,
  type ConnectionNode,
  type ConnectionsSnapshot,
} from './types.js';
import { EMPTY_PROGRESS } from '../sync/contract/materializerProgress.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const node = (id: string): ConnectionNode => ({
  id,
  kind: 'timeline-visit',
  label: id,
  originReplicaIds: [],
  metadata: { canonicalUrl: `https://example.test/${id}`, visitCount: 1 },
});

const edge = (from: string, to: string): ConnectionEdge => ({
  id: edgeIdFor('visit_in_workstream', from, to),
  kind: 'visit_in_workstream',
  fromNodeId: from,
  toNodeId: to,
  observedAt: '2026-05-01T00:00:00.000Z',
  producedBy: { source: 'event-log' },
  confidence: 'observed',
});

// A synthetic graph of N timeline-visit nodes chained by edges — big enough
// that a full write is non-trivial but fast in a unit test.
const buildGraph = (n: number, revision: string): ConnectionsSnapshot => {
  const nodes: ConnectionNode[] = [];
  const edges: ConnectionEdge[] = [];
  for (let i = 0; i < n; i += 1) {
    nodes.push(node(`v${i}`));
    if (i > 0) edges.push(edge(`v${i - 1}`, `v${i}`));
  }
  return {
    scope: {},
    nodes,
    edges,
    updatedAt: '2026-05-01T00:00:02.000Z',
    nodeCount: n,
    edgeCount: edges.length,
    snapshotRevision: revision,
  };
};

const progressFor = (rev: string) => ({
  ...EMPTY_PROGRESS('connections', 'connections@test'),
  appliedDotIntervals: { replica: [[1, 1] as const] },
  appliedFrontier: { replica: 1 },
  snapshotRevisionId: rev,
});

describe('M4 double-buffer acceptance', () => {
  let vaultRoot: string | null = null;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'm4-dbuf-'));
  });
  afterEach(async () => {
    delete process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'];
    delete process.env['SIDETRACK_INPLACE_PUBLISH'];
    if (vaultRoot !== null) {
      await rm(vaultRoot, { recursive: true, force: true });
      vaultRoot = null;
    }
  });

  const connectionsDir = (): string => join(vaultRoot!, '_BAC', 'connections');

  // The core split: a child-writer publishes a generation; a parent-reader
  // reads it back READONLY through the pointer. The served artifact (the
  // parent's readCurrent) must equal what the child wrote.
  sqliteIt('parent-reader reads back the child-writer published generation', async () => {
    const child = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    const parent = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    await child.writeSnapshotAndProgress(buildGraph(20, 'rev-1'), progressFor('rev-1'));

    const served = await parent.readCurrent();
    expect(served?.nodeCount).toBe(20);
    expect(served?.snapshotRevision).toBe('rev-1');
    // The parent handle is READONLY on the published gen — no current.db lock.
    const diag = parent.doubleBufferDiagnostics();
    expect(diag.enabled).toBe(true);
    expect(diag.role).toBe('parent-reader');
    expect(diag.generation).toBe(readPointer(connectionsDir()));
    child.close();
    parent.close();
  });

  // S1 — acceptance at the SERVED artifact. Graph-inert ticks may advance the
  // materializer frontier, but they must not clone/checkpoint/pointer-publish a
  // ~300 MB graph generation. A real same-sized row mutation must still publish
  // exactly once; snapshotRevision alone is deliberately held constant here to
  // prove the strong content signature, not the weak count hash, makes the call.
  sqliteIt(
    'unchanged ticks skip full publish; one real content delta publishes once and stays atomic',
    async () => {
      const writer = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
      const parent = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
      const progressThrough = (end: number) => ({
        ...EMPTY_PROGRESS('connections', 'connections@test'),
        appliedDotIntervals: { replica: [[1, end] as const] },
        appliedFrontier: { replica: end },
        snapshotRevisionId: 'rev-stable',
      });

      await writer.writeSnapshotAndProgress(buildGraph(24, 'rev-stable'), progressThrough(1));
      const firstGeneration = readPointer(connectionsDir());
      expect(firstGeneration).not.toBeNull();
      expect(residentGenerations(connectionsDir())).toEqual([firstGeneration]);
      expect((await parent.readCurrent())?.nodes).toHaveLength(24);
      const swapsAfterInitialPublish = writer.doubleBufferDiagnostics().swapCount;

      // Four active-minute acknowledgements: same served graph, advancing
      // canonical event frontier. They persist via the generation-bound
      // checkpoint and leave POINTER + resident generation count untouched.
      // The production engagement/content lane calls writeMaterializerProgress
      // directly; exercise that exact hot path first.
      await writer.writeMaterializerProgress(progressThrough(2));
      // Repeated full-snapshot callers are gated too (defence in depth for a
      // graph-inert event that reaches the general materializer seam).
      for (let end = 3; end <= 5; end += 1) {
        await writer.writeSnapshotAndProgress(buildGraph(24, 'rev-stable'), progressThrough(end));
      }
      expect(readPointer(connectionsDir())).toBe(firstGeneration);
      expect(residentGenerations(connectionsDir())).toEqual([firstGeneration]);
      expect(writer.doubleBufferDiagnostics()).toMatchObject({
        swapCount: swapsAfterInitialPublish,
        unchangedPublishSkipCount: 4,
        progressCheckpointCount: 4,
      });
      expect(await writer.readMaterializerProgress('connections')).toMatchObject({
        appliedFrontier: { replica: 5 },
        snapshotRevisionId: 'rev-stable',
      });
      expect((await parent.readCurrent())?.nodes).toHaveLength(24);

      // Same weak revision/counts/freshness, one changed served row. The strong
      // signature must detect it and publish once, atomically.
      //
      // 2026-08-16 (in-place child-drain channel widening): a full
      // content-replace write now applies IN PLACE once a generation
      // already exists (exactly like a scoped delta always has) — no new
      // generation, no pointer flip, no swap. The published content is
      // still correctly and atomically updated (asserted below via the
      // parent's readCurrent, not via generation identity).
      const changedBase = buildGraph(24, 'rev-stable');
      const changed: ConnectionsSnapshot = {
        ...changedBase,
        nodes: changedBase.nodes.map((entry) =>
          entry.id === 'v0' ? { ...entry, label: 'v0 changed' } : entry,
        ),
      };
      await writer.writeSnapshotAndProgress(changed, progressThrough(6));
      const changedGeneration = readPointer(connectionsDir());
      expect(changedGeneration).toBe(firstGeneration);
      expect(writer.doubleBufferDiagnostics().swapCount).toBe(swapsAfterInitialPublish);
      expect(writer.doubleBufferDiagnostics().inPlacePublishCount).toBeGreaterThan(0);

      // The parent's next request observes one complete generation: all rows
      // plus the mutation, never a partial/torn SQLite copy.
      const served = await parent.readCurrent();
      expect(served?.nodes).toHaveLength(24);
      expect(served?.edges).toHaveLength(23);
      expect(served?.nodes.find((entry) => entry.id === 'v0')?.label).toBe('v0 changed');
      expect(await parent.readMaterializerProgress('connections')).toMatchObject({
        appliedFrontier: { replica: 6 },
      });

      writer.close();
      parent.close();
    },
  );

  // Acceptance (a) — class elimination: a reader reads the published gen with
  // ms-scale latency WHILE a writer holds a long BEGIN IMMEDIATE on a SEPARATE
  // shadow file. (In the single-file model this would be SQLITE_BUSY.) The
  // whole batch of reads must stay well under the 250ms api.stall threshold —
  // there is NO cross-file lock contention.
  sqliteIt('reads stay ms-scale while a writer holds a long lock on a separate shadow', async () => {
    const child = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    const parent = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    await child.writeSnapshotAndProgress(buildGraph(200, 'rev-1'), progressFor('rev-1'));
    // Warm the parent onto the published gen.
    expect((await parent.readCurrent())?.nodeCount).toBe(200);

    // Simulate a long-held writer lock on a SEPARATE shadow file (the next
    // drain's private generation), mirroring production where the child holds
    // BEGIN IMMEDIATE on its shadow for the whole render.
    const publishedGen = readPointer(connectionsDir())!;
    const shadowPath = generationDbPath(connectionsDir(), 'shadow-lock-test');
    const { copyFileSync } = await import('node:fs');
    copyFileSync(generationDbPath(connectionsDir(), publishedGen), shadowPath);
    const writer = new Database(shadowPath, { readwrite: true });
    writer.exec('PRAGMA busy_timeout = 100');
    writer.exec('BEGIN IMMEDIATE');
    writer.query('INSERT OR REPLACE INTO metadata (key, data) VALUES (?, ?)').run('probe', 'x');
    try {
      let worstMs = 0;
      for (let i = 0; i < 30; i += 1) {
        const t0 = performance.now();
        const sub = await parent.readResolverSubgraphForUrl('https://example.test/v100');
        const dt = performance.now() - t0;
        worstMs = Math.max(worstMs, dt);
        expect(sub).not.toBeNull();
      }
      // Comfortably under the 250ms single-tick api.stall threshold: no lock
      // contention because the reader and writer are on different files.
      expect(worstMs).toBeLessThan(200);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
    child.close();
    parent.close();
  });

  // Acceptance (b) — a reader mid-request across a swap gets a consistent
  // answer (old OR new generation), never torn. The parent reopens onto the
  // new generation on its NEXT request; an in-flight read on the old gen
  // completes against the intact old file.
  //
  // 2026-08-16 (in-place child-drain channel widening): a second full write
  // against an EXISTING generation now applies in place by default (no
  // swap at all — see the widened "(5) generation GC" / "unchanged ticks"
  // coverage for that behavior). This test's OWN subject is the pointer-
  // swap + reader-reopen mechanism itself, which is retained (first-boot,
  // kill switch, any future structural migration) and must still work —
  // force the clone+CAS-flip path to genuinely exercise it.
  sqliteIt('reader gets a consistent (old-or-new) answer across a publish swap', async () => {
    process.env['SIDETRACK_INPLACE_PUBLISH'] = '0';
    const child = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    const parent = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    await child.writeSnapshotAndProgress(buildGraph(10, 'rev-1'), progressFor('rev-1'));
    const first = await parent.readCurrent();
    expect(first?.snapshotRevision).toBe('rev-1');
    const genBefore = parent.doubleBufferDiagnostics().generation;

    // A fresh child publishes rev-2 (a new generation).
    const child2 = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    await child2.writeSnapshotAndProgress(buildGraph(15, 'rev-2'), progressFor('rev-2'));

    // Parent's NEXT read reopens onto the new generation — a consistent new
    // answer (never a torn mix). The reopen is counted as a swap.
    const second = await parent.readCurrent();
    expect(second?.snapshotRevision).toBe('rev-2');
    expect(second?.nodeCount).toBe(15);
    const diag = parent.doubleBufferDiagnostics();
    expect(diag.generation).not.toBe(genBefore);
    expect(diag.swapCount).toBeGreaterThanOrEqual(1);
    child.close();
    child2.close();
    parent.close();
  });

  // Acceptance (c) — a crash between shadow-build and pointer-flip: the
  // POINTER still names the prior valid generation, so a fresh parent boot
  // serves the OLD (valid) generation, never a half-built one.
  sqliteIt('boot serves the prior valid generation when a publish did not complete', async () => {
    const child = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    await child.writeSnapshotAndProgress(buildGraph(12, 'rev-1'), progressFor('rev-1'));
    child.close();
    const goodGen = readPointer(connectionsDir());

    // Simulate a crashed child: a shadow file exists but the pointer was never
    // flipped to it (createShadowGeneration + a write, no publish).
    const { createShadowGeneration } = await import('./generationBuffer.js');
    const shadow = createShadowGeneration(connectionsDir(), 'crashed-shadow');
    const shadowDb = new Database(shadow.path, { readwrite: true });
    shadowDb.query('INSERT OR REPLACE INTO metadata (key, data) VALUES (?, ?)').run(
      'current',
      '{"corrupt":"half-built"}',
    );
    shadowDb.close();

    // A fresh parent boot serves the OLD valid generation (rev-1), not the
    // orphaned shadow — the pointer never named it.
    expect(readPointer(connectionsDir())).toBe(goodGen);
    const parent = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    const served = await parent.readCurrent();
    expect(served?.snapshotRevision).toBe('rev-1');
    expect(served?.nodeCount).toBe(12);
    parent.close();
  });

  // D3 — the resolver cache lives in its OWN db (resolver-cache.db), off the
  // graph read path. A generation swap must NOT wipe cache entries (the
  // last-writer race is gone), and the cache round-trips independently.
  sqliteIt('resolver cache survives a graph generation swap (lives in its own db)', async () => {
    const parent = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    const child = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    await child.writeSnapshotAndProgress(buildGraph(8, 'rev-1'), progressFor('rev-1'));

    await parent.cacheResolverResult('visit:a', 'rev-1', { action: 'inbox' });
    expect(await parent.getCachedResolverResult('visit:a', 'rev-1')).toEqual({ action: 'inbox' });

    // The resolver cache lives in resolver-cache.db, not the graph generation.
    expect(existsSync(join(connectionsDir(), 'resolver-cache.db'))).toBe(true);

    // A child publishes a new generation. The cache entry (same revision) must
    // still be readable — the swap did not touch resolver-cache.db.
    const child2 = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    await child2.writeSnapshotAndProgress(buildGraph(9, 'rev-2'), progressFor('rev-2'));
    await parent.readCurrent(); // triggers the reopen onto rev-2

    expect(await parent.getCachedResolverResult('visit:a', 'rev-1')).toEqual({ action: 'inbox' });
    parent.close();
    child.close();
    child2.close();
  });

  // Acceptance (e) — a scoped-delta write publishes via the same shadow+swap
  // path and lands a small, correct change readable through the pointer.
  sqliteIt('scoped-delta publishes via shadow+swap and is read back through the pointer', async () => {
    const child = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    const parent = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    await child.writeSnapshotAndProgress(buildGraph(6, 'rev-1'), progressFor('rev-1'));
    expect((await parent.readCurrent())?.nodeCount).toBe(6);

    // A scoped delta that relabels one node.
    const relabeled: ConnectionNode = { ...node('v0'), label: 'v0 patched' };
    const scopedChild = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    await scopedChild.replaceScopeRows({
      scopes: [{ kind: 'workstream', id: 'main' }],
      nodes: [relabeled],
      edges: [],
      progress: progressFor('rev-scoped'),
    });

    const served = await parent.readCurrent();
    expect(served?.nodes.find((n) => n.id === 'v0')?.label).toBe('v0 patched');
    // Node count preserved (scoped delta patched, didn't rebuild).
    expect(served?.nodeCount).toBe(6);
    child.close();
    scopedChild.close();
    parent.close();
  });

  // Acceptance (a/b) HARDENING — two concurrent parent-side write shadows
  // (mirrors the two independent overlay queues: projection + foreground-nav)
  // publishing across back-to-back swaps WHILE a canary-cadence read loop runs.
  // Asserts ZERO thrown errors and a consistent (never-torn) readback — the GC
  // must not unlink a gen a live reader/shadow still holds (major: GC of a live
  // gen), and the CAS must serialize the two flips (blocker: pointer clobber).
  sqliteIt('concurrent parent write-shadows + a read loop across publishes throw ZERO errors', async () => {
    const child = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    const parent = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    await child.writeSnapshotAndProgress(buildGraph(40, 'rev-1'), progressFor('rev-1'));
    expect((await parent.readCurrent())?.nodeCount).toBe(40);

    let readErrors = 0;
    let readLoopRunning = true;
    const readLoop = (async (): Promise<void> => {
      while (readLoopRunning) {
        try {
          const sub = await parent.readResolverSubgraphForUrl('https://example.test/v20');
          if (sub === null) throw new Error('null subgraph mid-swap');
        } catch {
          readErrors += 1;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    // Fire many concurrent parent-side scoped-delta publishes (two "queues"
    // interleave) across several rounds — each is a shadow+CAS publish.
    for (let round = 0; round < 4; round += 1) {
      await Promise.all([
        parent.replaceScopeRows({
          scopes: [{ kind: 'workstream', id: 'q1' }],
          nodes: [{ ...node('v0'), label: `q1-${String(round)}` }],
          edges: [],
          progress: progressFor(`rev-q1-${String(round)}`),
        }),
        parent.replaceScopeRows({
          scopes: [{ kind: 'workstream', id: 'q2' }],
          nodes: [{ ...node('v1'), label: `q2-${String(round)}` }],
          edges: [],
          progress: progressFor(`rev-q2-${String(round)}`),
        }),
      ]);
    }

    readLoopRunning = false;
    await readLoop;
    expect(readErrors).toBe(0);
    // The served graph is intact and readable (node count preserved).
    const served = await parent.readCurrent();
    expect(served?.nodeCount).toBe(40);
    child.close();
    parent.close();
  });

  // Acceptance (a) — a concurrent parent overlay-publish and a fresh child full
  // publish do NOT clobber each other's pointer: the CAS discards the loser and
  // the winning (newer) graph survives. The drain must never be silently lost.
  sqliteIt('a parent scoped-delta racing a child full publish does not lose the child drain', async () => {
    const child = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    const parent = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    await child.writeSnapshotAndProgress(buildGraph(10, 'rev-1'), progressFor('rev-1'));
    await parent.readCurrent();

    // Concurrently: a fresh child publishes a full 30-node drain, and the parent
    // applies a scoped delta seeded from the OLD gen. Under CAS one wins the
    // pointer; the other is discarded — but the FULL DRAIN (30 nodes) must not
    // vanish. Because the parent's scoped delta seeds from rev-1 and the child
    // publishes a new gen, the parent's stale flip is rejected (superseded), so
    // the child's 30-node drain survives.
    const child2 = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    await Promise.all([
      child2.writeSnapshotAndProgress(buildGraph(30, 'rev-2'), progressFor('rev-2')),
      parent.replaceScopeRows({
        scopes: [{ kind: 'workstream', id: 'race' }],
        nodes: [{ ...node('v0'), label: 'raced' }],
        edges: [],
        progress: progressFor('rev-raced'),
      }),
    ]);

    const served = await parent.readCurrent();
    // The full 30-node drain is NOT lost. (A pre-CAS blind flip could have
    // reverted to the parent's 10-node-seeded shadow.)
    expect(served?.nodeCount).toBeGreaterThanOrEqual(30);
    child.close();
    child2.close();
    parent.close();
  });

  // Blocker (rollback): after generations ADVANCE >=2 times, flipping the kill
  // switch must serve the LATEST published gen, not the frozen migration seed.
  sqliteIt('kill-switch downgrade after >=2 gen advances serves the latest gen, not the seed', async () => {
    // Boot double-buffer, migrate a legacy seed, then advance generations.
    process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'] = '0';
    const seedStore = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    await seedStore.putCurrent(buildGraph(5, 'rev-seed'));
    seedStore.close();
    delete process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'];

    // Under double-buffer, advance the published gen twice (rev-2 then rev-3).
    const c1 = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    await c1.writeSnapshotAndProgress(buildGraph(20, 'rev-2'), progressFor('rev-2'));
    c1.close();
    const c2 = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    await c2.writeSnapshotAndProgress(buildGraph(30, 'rev-3'), progressFor('rev-3'));
    c2.close();

    // Now DOWNGRADE. The legacy open must reconcile current.db to rev-3 (30),
    // not serve the frozen rev-seed (5).
    process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'] = '0';
    const downgraded = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    const served = await downgraded.readCurrent();
    expect(served?.snapshotRevision).toBe('rev-3');
    expect(served?.nodeCount).toBe(30);
    downgraded.close();
  });

  // Kill-switch (D6): SIDETRACK_CONNECTIONS_DOUBLE_BUFFER=0 reverts to the
  // legacy single-file current.db with in-place writes+reads. No POINTER, no
  // generation files — the byte-for-byte pre-M4 behavior.
  sqliteIt('kill-switch reverts to legacy single-file current.db', async () => {
    process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'] = '0';
    const store = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    await store.putCurrent(buildGraph(5, 'rev-legacy'));
    expect((await store.readCurrent())?.snapshotRevision).toBe('rev-legacy');
    // Legacy path: current.db exists, no POINTER.
    expect(existsSync(join(connectionsDir(), 'current.db'))).toBe(true);
    expect(readPointer(connectionsDir())).toBeNull();
    expect(store.doubleBufferDiagnostics().enabled).toBe(false);
    store.close();
  });

  // Migration (§7): a pre-M4 legacy current.db is migrated to gen0 on first
  // boot and read back identically; legacy current.db is retained.
  sqliteIt('migrates a pre-M4 legacy current.db to a published generation on boot', async () => {
    // Write a legacy current.db with the kill-switch on.
    process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'] = '0';
    const legacyStore = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    await legacyStore.putCurrent(buildGraph(7, 'rev-legacy'));
    legacyStore.close();
    delete process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'];

    // Boot with double-buffer ON: the legacy db migrates to gen0 + POINTER.
    const store = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    const served = await store.readCurrent();
    expect(served?.snapshotRevision).toBe('rev-legacy');
    expect(served?.nodeCount).toBe(7);
    expect(readPointer(connectionsDir())).not.toBeNull();
    // Legacy current.db retained as a rollback seed.
    expect(existsSync(join(connectionsDir(), 'current.db'))).toBe(true);
    store.close();
  });

  // F4 (blob diet) migration — a pre-F4 projection_accumulators:<name> blob
  // (the whole url/tabSession accumulator serialized as one JSON value under
  // a metadata key) must be decomposed into the per-key row tables on first
  // writable open, with the metadata key rewritten down to just the small
  // progress tag. "NO backward compatibility — replace the representation
  // outright" per docs/plans/2026-08-16-f8-ivm-designs.md; this is the one
  // permitted migration step.
  sqliteIt(
    'migrates a pre-F4 projection_accumulators blob to per-key rows on boot',
    async () => {
      process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'] = '0';
      const legacyStore = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
      await legacyStore.putCurrent(buildGraph(4, 'rev-legacy-blob'));
      legacyStore.close();

      // Inject a pre-F4 legacy blob directly — simulates a vault last
      // written by pre-F4 code, before the per-key row tables existed.
      const legacyDbPath = join(connectionsDir(), 'current.db');
      const rawDb = new Database(legacyDbPath, { readwrite: true });
      const legacyBlob = {
        materializerName: 'connections',
        materializerVersion: 'connections@test',
        appliedDotIntervals: { replica: [[1, 3]] },
        appliedFrontier: { replica: 3 },
        urlAccumulator: {
          schemaVersion: 1,
          byCanonicalUrl: {
            'https://legacy.test/a': {
              canonicalUrl: 'https://legacy.test/a',
              firstSeenAt: '2026-05-01T00:00:00.000Z',
              lastSeenAt: '2026-05-01T00:00:00.000Z',
              visitCount: 1,
              tabSessionIds: [],
              attributionHistory: [],
            },
          },
          observationCursors: {},
        },
        tabSessionAccumulator: {
          schemaVersion: 1,
          bySessionId: {
            'ts-legacy': {
              tabSessionId: 'ts-legacy',
              openedAt: '2026-05-01T00:00:00.000Z',
              lastActivityAt: '2026-05-01T00:00:00.000Z',
              attributionHistory: [],
            },
          },
          openSessionsByTabId: {},
        },
      };
      rawDb
        .query(
          'INSERT INTO metadata (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data',
        )
        .run('projection_accumulators:connections', JSON.stringify(legacyBlob));
      rawDb.close();
      delete process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'];

      // Boot with double-buffer ON: legacy current.db (graph + legacy blob)
      // migrates to gen0.
      const store = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
      const served = await store.readCurrent();
      expect(served?.snapshotRevision).toBe('rev-legacy-blob');

      const migrated = await store.readProjectionAccumulatorState('connections');
      expect(migrated?.materializerVersion).toBe('connections@test');
      expect(migrated?.appliedFrontier).toEqual({ replica: 3 });
      expect(migrated?.appliedDotIntervals).toEqual({ replica: [[1, 3]] });
      expect(migrated?.urlAccumulator.byCanonicalUrl['https://legacy.test/a']?.visitCount).toBe(1);
      expect(migrated?.tabSessionAccumulator.bySessionId['ts-legacy']?.tabSessionId).toBe(
        'ts-legacy',
      );
      store.close();
    },
  );

  // -------------------------------------------------------------------------
  // Deferred resolver-cache write ACROSS a generation publish (2026-07-29 P0).
  //
  // Deferral moves the sqlite write off the request path, which also moves it
  // across an unbounded amount of wall clock — and a drain publishes a whole
  // new generation in that window. If the enqueue had captured a store (or,
  // worse, a Database), the flush would write through a handle whose file the
  // publish may have unlinked, and bun:sqlite answers that with the literal
  // message "disk I/O error": not a lock, not corruption, so nothing retries
  // it. The queue therefore stores a THUNK resolved at flush time; this test
  // pins that by rotating both the generation AND the store object between the
  // enqueue and the flush.
  // -------------------------------------------------------------------------
  // 2026-08-16 (in-place child-drain channel widening): this test's subject
  // is resolver-cache independence across a GENUINE generation swap (D3) —
  // force the clone+CAS-flip path so child2's publish actually swaps rather
  // than applying in place against the existing generation (its default
  // behavior now, covered elsewhere).
  sqliteIt('a deferred resolver-cache write flushed after a generation publish lands via the CURRENT store', async () => {
    process.env['SIDETRACK_INPLACE_PUBLISH'] = '0';
    __resetResolverCacheDeferQueue();
    const child = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    await child.writeSnapshotAndProgress(buildGraph(6, 'rev-1'), progressFor('rev-1'));
    child.close();
    const genAtEnqueue = readPointer(connectionsDir());

    // The store the "request" was served by.
    let liveStore = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    expect((await liveStore.readSnapshotMetadata())?.snapshotRevision).toBe('rev-1');

    // Enqueue exactly as the batch-resolve route does: a thunk, never a bound
    // writer. Reading `liveStore` INSIDE the thunk is the whole contract.
    queueResolverCacheWrite(
      () =>
        async (visitId, revision, value): Promise<void> =>
          await liveStore.cacheResolverResult(visitId, revision, value),
      'https://defer.test/a',
      'cache-rev-1',
      { action: 'inbox' },
    );
    expect(pendingResolverCacheWriteCount()).toBe(1);

    // ...now a drain publishes a NEW generation and the parent rotates onto it,
    // all while the write is still sitting in the queue.
    const child2 = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
    await child2.writeSnapshotAndProgress(buildGraph(9, 'rev-2'), progressFor('rev-2'));
    child2.close();
    const genAtFlush = readPointer(connectionsDir());
    expect(genAtFlush).not.toBe(genAtEnqueue);

    liveStore.close();
    liveStore = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
    expect((await liveStore.readSnapshotMetadata())?.snapshotRevision).toBe('rev-2');

    await flushResolverCacheWrites();

    // No "disk I/O error" (or anything else) — the flush bound to the store
    // that is live NOW, not the one the request saw.
    expect(resolverCacheDeferStats().writeFailures).toBe(0);
    expect(resolverCacheDeferStats().droppedNoWriter).toBe(0);
    expect(pendingResolverCacheWriteCount()).toBe(0);
    // Read back through the CURRENT store (doctrine rule 10 — assert the
    // served artifact, not the layer under change).
    expect(await liveStore.getCachedResolverResult('https://defer.test/a', 'cache-rev-1')).toEqual({
      action: 'inbox',
    });
    liveStore.close();
    __resetResolverCacheDeferQueue();
  });

  sqliteIt('a deferred write whose store is gone at flush time is dropped, not thrown', async () => {
    __resetResolverCacheDeferQueue();
    // Shutdown ordering: the queue can outlive the store. Dropping is the
    // contract (a lost cache write costs one recompute) and it must be
    // COUNTED, not silent — the same absent==zero discipline as every other
    // degradation counter in this package.
    queueResolverCacheWrite(() => null, 'https://defer.test/gone', 'cache-rev-1', { a: 1 });
    await flushResolverCacheWrites();
    expect(resolverCacheDeferStats().droppedNoWriter).toBe(1);
    expect(resolverCacheDeferStats().writeFailures).toBe(0);
    expect(pendingResolverCacheWriteCount()).toBe(0);
    __resetResolverCacheDeferQueue();
  });
});
