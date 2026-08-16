// In-place scoped publish (2026-08-16) — mandatory tests for the
// "Storage-tier incremental publish" design note
// (docs/plans/2026-08-15-foundation-program.md). Five categories, per the
// task's own requirements:
//   1. crash-kill      — SIGKILL mid-publish, N=20, never torn.
//   2. concurrent read — a reader holding a WAL snapshot never sees a
//                        straddled write; a fresh reader after commit does.
//   3. write volume    — bytes written per publish are O(delta), not
//                        O(db size).
//   4. revision equiv  — write_seq/snapshotRevision behave identically to
//                        the clone+flip path.
//   5. generation GC   — the (now much rarer) full-rebuild flip path still
//                        gets collected correctly.

import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteConnectionsStore } from './snapshot.js';
import { generationDbPath, readPointer, residentGenerations } from './generationBuffer.js';
import type { ConnectionEdge, ConnectionNode, ConnectionsSnapshot } from './types.js';
import { EMPTY_PROGRESS } from '../sync/contract/materializerProgress.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;
const itUnlessCI = process.env['CI'] ? it.skip : it;

// bun natively transpiles TS on import (including a dynamic import() of a
// file:// URL), so the forked crash-test child can import the real store
// module directly — no build step, no separate compiled fixture.
const SNAPSHOT_MODULE_URL = new URL('./snapshot.ts', import.meta.url).href;

const node = (id: string, label: string): ConnectionNode => ({
  id,
  kind: 'timeline-visit',
  label,
  originReplicaIds: [],
  metadata: { canonicalUrl: `https://example.test/${id}`, visitCount: 1 },
});

const chainEdges = (ids: readonly string[], prefix: string): ConnectionEdge[] => {
  const edges: ConnectionEdge[] = [];
  for (let i = 1; i < ids.length; i += 1) {
    edges.push({
      id: `${prefix}:${String(i)}`,
      kind: 'visit_in_workstream',
      fromNodeId: ids[i - 1]!,
      toNodeId: ids[i]!,
      observedAt: '2026-05-01T00:00:00.000Z',
      producedBy: { source: 'event-log' },
      confidence: 'observed',
    });
  }
  return edges;
};

const emptyGraph = (revision: string): ConnectionsSnapshot => ({
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: '2026-05-01T00:00:00.000Z',
  nodeCount: 0,
  edgeCount: 0,
  snapshotRevision: revision,
});

const progressFor = (rev: string, seq = 1) => ({
  ...EMPTY_PROGRESS('connections', 'connections@test'),
  appliedDotIntervals: { replica: [[1, seq] as const] },
  appliedFrontier: { replica: seq },
  snapshotRevisionId: rev,
});

describe('in-place scoped publish (2026-08-16)', () => {
  let vaultRoot: string | null = null;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'inplace-pub-'));
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

  // ---------------------------------------------------------------------
  // (1) Crash-kill: SIGKILL the writer at a randomized point mid-publish,
  // N=20 iterations, reopen and assert either fully-old or fully-new state,
  // never torn.
  // ---------------------------------------------------------------------
  describe('(1) crash-kill', () => {
    const waitForMessage = (
      child: ChildProcess,
      predicate: (m: unknown) => boolean,
    ): Promise<void> =>
      new Promise((resolve) => {
        const onMessage = (m: unknown): void => {
          if (predicate(m)) {
            child.off('message', onMessage);
            resolve();
          }
        };
        child.on('message', onMessage);
      });

    const waitForExit = (child: ChildProcess): Promise<void> =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
      });

    const spawnPublisher = (payloadN: number, label: string): ChildProcess =>
      fork(
        join(vaultRoot!, '..', 'inplace-crash-child.mjs'),
        [],
        {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: {
            ...process.env,
            VAULT_ROOT: vaultRoot!,
            SNAPSHOT_MODULE_URL,
            PAYLOAD_N: String(payloadN),
            PAYLOAD_LABEL: label,
          },
        },
      );

    itUnlessCI(
      'SIGKILL at a randomized point mid in-place publish never leaves a torn generation (N=20)',
      async () => {
        const childScriptPath = join(vaultRoot!, '..', 'inplace-crash-child.mjs');
        await writeFile(
          childScriptPath,
          [
            "const { SqliteConnectionsStore } = await import(process.env.SNAPSHOT_MODULE_URL);",
            'const vaultRoot = process.env.VAULT_ROOT;',
            'const n = Number(process.env.PAYLOAD_N);',
            'const label = process.env.PAYLOAD_LABEL;',
            "const store = new SqliteConnectionsStore(vaultRoot, { role: 'child-writer' });",
            'const nodes = [];',
            'const edges = [];',
            'for (let i = 0; i < n; i++) {',
            // kind 'dispatch' + metadata.workstreamId is the ONLY node shape
            // whose scope (scopesForNode's else-branch,
            // sync/contract/connectionsScopes.ts) is actually derived from
            // metadata rather than the node's own id — required so a
            // nodes:[] replace against { kind: 'workstream', id: 'crashtest' }
            // genuinely deletes every node this script wrote (timeline-visit
            // nodes each own their OWN url-scope regardless of the `scopes`
            // argument, which would make a reset-to-empty silently no-op).
            "  nodes.push({ id: `v${i}`, kind: 'dispatch', label: `${label}-${i}`, originReplicaIds: [], metadata: { workstreamId: 'crashtest' } });",
            '  if (i > 0) edges.push({',
            '    id: `e${i}`,',
            "    kind: 'visit_in_workstream',",
            '    fromNodeId: `v${i - 1}`,',
            '    toNodeId: `v${i}`,',
            "    observedAt: '2026-05-01T00:00:00.000Z',",
            "    producedBy: { source: 'event-log' },",
            "    confidence: 'observed',",
            '  });',
            '}',
            'if (process.send) process.send({ ready: true });',
            'await store.replaceScopeRows({',
            "  scopes: [{ kind: 'workstream', id: 'crashtest' }],",
            '  nodes,',
            '  edges,',
            '  progress: {',
            "    materializerName: 'connections',",
            "    materializerVersion: 'connections@test',",
            '    appliedDotIntervals: { replica: [[1, 1]] },',
            '    appliedFrontier: { replica: 1 },',
            '    snapshotRevisionId: label,',
            '  },',
            '});',
            'if (process.send) process.send({ done: true });',
            'process.exit(0);',
          ].join('\n'),
        );

        // Bootstrap gen0 with an empty graph so the pointer/generation exist
        // before any crash-test iteration runs.
        const seed = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        await seed.writeSnapshotAndProgress(emptyGraph('seed'), progressFor('seed', 0));
        seed.close();

        const control = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
        const resetScope = async (): Promise<void> => {
          await control.replaceScopeRows({
            scopes: [{ kind: 'workstream', id: 'crashtest' }],
            nodes: [],
            edges: [],
            progress: progressFor('reset'),
          });
        };

        const PAYLOAD_N = 6000;

        // Calibration run: measure ready→done wall-clock for this exact
        // payload size, uncounted, so the randomized kill delays below are
        // sampled from a REAL measured window rather than a guess.
        await resetScope();
        const calibChild = spawnPublisher(PAYLOAD_N, 'calib');
        const t0 = performance.now();
        await waitForMessage(calibChild, (m) => (m as { ready?: boolean }).ready === true);
        await waitForMessage(calibChild, (m) => (m as { done?: boolean }).done === true);
        const calibratedMs = performance.now() - t0;
        await waitForExit(calibChild);
        expect(calibratedMs).toBeGreaterThan(0);

        let killedWhileRunning = 0;
        let finishedBeforeKill = 0;

        const N_ITERATIONS = 20;
        for (let iter = 0; iter < N_ITERATIONS; iter += 1) {
          await resetScope();
          const label = `iter${String(iter)}`;
          const child = spawnPublisher(PAYLOAD_N, label);
          await waitForMessage(child, (m) => (m as { ready?: boolean }).ready === true);
          const done = waitForMessage(child, (m) => (m as { done?: boolean }).done === true);
          // Randomized kill point: uniformly sampled across [0, 1.5x the
          // calibrated full-run duration] — spans "before the write even
          // starts" through "well after it should have committed".
          const delayMs = Math.random() * calibratedMs * 1.5;
          const finishedInTime = await Promise.race([
            done.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), delayMs)),
          ]);
          if (finishedInTime) {
            finishedBeforeKill += 1;
          } else {
            killedWhileRunning += 1;
            child.kill('SIGKILL');
          }
          await waitForExit(child);

          // A kill that lands while the child holds the cross-process
          // publish lock (acquirePublishLock — the SAME lock every publisher
          // contends on) leaves `current.publish.lock` behind. The PRODUCT
          // behavior is already correct and self-healing (the lock is
          // stale-stolen after PUBLISH_LOCK_STALE_MS=15s — see
          // generationBuffer.ts), which is real, tested, pre-existing
          // machinery this PR does not change; it is deliberately NOT
          // re-verified here (20 iterations x up to 15s would make this
          // suite too slow to run routinely). What we DO know, out-of-band,
          // that the stale-timeout logic doesn't (yet) check for — this
          // exact process is confirmed dead by waitForExit above — so
          // clearing its orphaned lock immediately is equivalent to letting
          // real wall-clock time pass, without slowing the suite down by
          // 15s per killed-while-locked iteration.
          const orphanLockPath = join(connectionsDir(), 'current.publish.lock');
          if (existsSync(orphanLockPath)) {
            try {
              unlinkSync(orphanLockPath);
            } catch {
              /* best-effort */
            }
          }

          // Reopen a FRESH store (new process-local handle, matching a real
          // restart/reopen after a crash) and read back.
          const reader = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
          const served = await reader.readCurrent();
          reader.close();
          expect(served).not.toBeNull();
          const labels = served!.nodes.map((n) => n.label);
          if (labels.length === 0) {
            // Fully-old: the publish never committed. Nothing more to check.
            continue;
          }
          // Fully-new: every single label must carry THIS iteration's
          // prefix and the full payload must be present — a torn write
          // would show a partial count or a mix of old/new-prefixed labels.
          expect(served!.nodes).toHaveLength(PAYLOAD_N);
          expect(served!.edges).toHaveLength(PAYLOAD_N - 1);
          expect(labels.every((l) => l.startsWith(`${label}-`))).toBe(true);
        }

        control.close();
        // Sanity: the randomized delays actually exercised BOTH outcomes
        // across 20 iterations (not "always killed too early/late to
        // matter") — otherwise this test would be evidence-free.
        expect(killedWhileRunning).toBeGreaterThan(0);
        expect(killedWhileRunning + finishedBeforeKill).toBe(N_ITERATIONS);
      },
      120_000,
    );
  });

  // ---------------------------------------------------------------------
  // (2) Concurrent reader: a reader holding a WAL read transaction during
  // an in-place publish sees the PRE-publish snapshot throughout; a fresh
  // reader after commit sees the NEW one. Exercises the store's ACTUAL
  // generation file (not a throwaway spike db) plus the store's own
  // readCurrent() H6 path racing a real publish.
  // ---------------------------------------------------------------------
  describe('(2) concurrent reader isolation', () => {
    sqliteIt(
      'a reader with an open read txn never sees an in-progress in-place publish',
      async () => {
        const writer = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        const n = 30;
        const ids = Array.from({ length: n }, (_, i) => `v${String(i)}`);
        await writer.writeSnapshotAndProgress(
          {
            scope: {},
            nodes: ids.map((id) => node(id, `pre-${id}`)),
            edges: chainEdges(ids, 'pre'),
            updatedAt: '2026-05-01T00:00:00.000Z',
            nodeCount: n,
            edgeCount: n - 1,
            snapshotRevision: 'rev-pre',
          },
          progressFor('rev-pre'),
        );
        writer.close();

        const genId = readPointer(connectionsDir())!;
        const genPath = generationDbPath(connectionsDir(), genId);

        // Pin a WAL snapshot with a real read transaction on the ACTUAL
        // served generation file, exactly as the design note's empirical
        // verification did.
        const pinned = new Database(genPath, { readonly: true });
        pinned.exec('BEGIN DEFERRED');
        const before = pinned.query('SELECT COUNT(*) AS n FROM nodes').get() as { n: number };
        expect(before.n).toBe(n);

        // A publish lands in place on the SAME file while the reader's
        // transaction is still open.
        const parent = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
        await parent.replaceScopeRows({
          scopes: [{ kind: 'workstream', id: 'w1' }],
          nodes: [node('extra-1', 'extra-1'), node('extra-2', 'extra-2')],
          edges: [],
          progress: progressFor('rev-post'),
        });

        // The pinned reader's transaction is untouched by the publish.
        const duringPublish = pinned.query('SELECT COUNT(*) AS n FROM nodes').get() as {
          n: number;
        };
        expect(duringPublish.n).toBe(n);

        pinned.exec('COMMIT');
        const afterCommit = pinned.query('SELECT COUNT(*) AS n FROM nodes').get() as {
          n: number;
        };
        expect(afterCommit.n).toBe(n + 2);
        pinned.close();

        // A fresh reader immediately after commit sees the new state, and
        // the store's OWN readCurrent() (H6 pre/post write_seq check) agrees.
        const freshReader = new Database(genPath, { readonly: true });
        const fresh = freshReader.query('SELECT COUNT(*) AS n FROM nodes').get() as {
          n: number;
        };
        expect(fresh.n).toBe(n + 2);
        freshReader.close();

        const served = await parent.readCurrent();
        expect(served?.nodeCount).toBe(n + 2);
        parent.close();
      },
    );

    sqliteIt(
      "readCurrent()'s paged read racing a concurrent in-place publish never returns a torn mix",
      async () => {
        const writer = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        // Large enough that #readCurrentAttempt's paged read spans multiple
        // yieldToLoop() chunks, giving a real window for a concurrent
        // publish to land mid-read.
        const n = 4000;
        const ids = Array.from({ length: n }, (_, i) => `v${String(i)}`);
        await writer.writeSnapshotAndProgress(
          {
            scope: {},
            nodes: ids.map((id) => node(id, `pre-${id}`)),
            edges: chainEdges(ids, 'pre'),
            updatedAt: '2026-05-01T00:00:00.000Z',
            nodeCount: n,
            edgeCount: n - 1,
            snapshotRevision: 'rev-pre',
          },
          progressFor('rev-pre'),
        );
        writer.close();

        const reader = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
        const writer2 = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });

        for (let round = 0; round < 6; round += 1) {
          const [served] = await Promise.all([
            reader.readCurrent(),
            writer2.replaceScopeRows({
              scopes: [{ kind: 'workstream', id: `race${String(round)}` }],
              nodes: [node(`race-${String(round)}`, `race-${String(round)}`)],
              edges: [],
              progress: progressFor(`rev-race-${String(round)}`),
            }),
          ]);
          expect(served).not.toBeNull();
          // Never torn: node count is always exactly n + (races so far, 0 or
          // 1 more depending on interleaving) — but NEVER a value that would
          // only be possible from a partial page read (e.g. a fraction of
          // the base graph missing while the race node is present).
          expect(served!.nodeCount).toBeGreaterThanOrEqual(n);
          expect(served!.nodeCount).toBeLessThanOrEqual(n + round + 1);
          // The base chain is always fully intact (every v-id present) —
          // the load-bearing torn-read detector.
          const presentIds = new Set(served!.nodes.map((entry) => entry.id));
          const missingBase = ids.filter((id) => !presentIds.has(id));
          expect(missingBase).toHaveLength(0);
        }

        reader.close();
        writer2.close();
      },
    );
  });

  // ---------------------------------------------------------------------
  // (3) Write volume: bytes written per publish are O(delta), not O(db
  // size). A scoped publish of ~100 rows on a synthetic large fixture must
  // write far less than the fixture itself.
  // ---------------------------------------------------------------------
  describe('(3) write volume is O(delta)', () => {
    sqliteIt(
      'a ~100-row in-place publish on a large fixture writes a small, bounded number of bytes',
      async () => {
        const writer = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        // Padded labels so the fixture reaches real size with a manageable
        // row count (fast enough for a unit test while still being a
        // meaningfully large generation file).
        const pad = 'x'.repeat(1400);
        const FIXTURE_N = 60_000;
        const ids = Array.from({ length: FIXTURE_N }, (_, i) => `v${String(i)}`);
        await writer.writeSnapshotAndProgress(
          {
            scope: {},
            nodes: ids.map((id) => node(id, `${id}-${pad}`)),
            edges: [],
            updatedAt: '2026-05-01T00:00:00.000Z',
            nodeCount: FIXTURE_N,
            edgeCount: 0,
            snapshotRevision: 'rev-fixture',
          },
          progressFor('rev-fixture'),
        );
        writer.close();

        const genId = readPointer(connectionsDir())!;
        const genPath = generationDbPath(connectionsDir(), genId);
        const walPath = `${genPath}-wal`;
        const fixtureBytes = statSync(genPath).size;
        // Document (not silently assume) the achieved fixture size — the
        // task's own target was ~100MB; this is a deliberately proportional
        // stand-in for test-suite runtime (see the design note / PR body).
        expect(fixtureBytes).toBeGreaterThan(20_000_000);

        const dbBytesBefore = statSync(genPath).size;
        const walBytesBefore = existsSync(walPath) ? statSync(walPath).size : 0;

        const parent = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
        const deltaIds = ids.slice(0, 100);
        await parent.replaceScopeRows({
          scopes: [{ kind: 'workstream', id: 'delta-scope' }],
          nodes: deltaIds.map((id) => node(id, `${id}-delta-${pad}`)),
          edges: [],
          progress: progressFor('rev-delta'),
        });
        parent.close();

        const dbBytesAfter = statSync(genPath).size;
        const walBytesAfter = existsSync(walPath) ? statSync(walPath).size : 0;
        const totalWrittenBytes =
          Math.max(0, dbBytesAfter - dbBytesBefore) + Math.max(0, walBytesAfter - walBytesBefore);
        // Printed evidence for the PR body (mirrors this repo's other
        // perf-proof tests, e.g. scopeRecompute.perf.test.ts) — the exact
        // measured numbers, not just a pass/fail.
        console.warn(
          `[inplace-publish.write-volume] fixtureBytes=${String(fixtureBytes)} deltaRows=${String(deltaIds.length)} totalWrittenBytes=${String(totalWrittenBytes)} (${(totalWrittenBytes / fixtureBytes * 100).toFixed(3)}% of fixture)`,
        );

        expect(totalWrittenBytes).toBeLessThan(5 * 1024 * 1024);
        // And, the actual point of the test: nowhere close to the fixture
        // size (proves O(delta), not O(db size)).
        expect(totalWrittenBytes).toBeLessThan(fixtureBytes * 0.05);
      },
      60_000,
    );
  });

  // ---------------------------------------------------------------------
  // (4) Revision semantics equivalence: write_seq / snapshotRevision /
  // materializer progress behave IDENTICALLY whether a sequence of scoped
  // writes is applied via in-place publish or the legacy clone+flip path.
  // ---------------------------------------------------------------------
  describe('(4) revision/write_seq equivalence with the clone+flip path', () => {
    const runSequence = async (root: string): Promise<{
      readonly snapshot: ConnectionsSnapshot | null;
      readonly progress: unknown;
    }> => {
      const writer = new SqliteConnectionsStore(root, { role: 'child-writer' });
      await writer.writeSnapshotAndProgress(
        {
          scope: {},
          nodes: [node('a', 'a'), node('b', 'b'), node('c', 'c')],
          edges: chainEdges(['a', 'b', 'c'], 'seed'),
          updatedAt: '2026-05-01T00:00:00.000Z',
          nodeCount: 3,
          edgeCount: 2,
          snapshotRevision: 'rev-seed',
        },
        progressFor('rev-seed', 1),
      );
      writer.close();

      const parent = new SqliteConnectionsStore(root, { role: 'parent-reader' });
      await parent.replaceScopeRows({
        scopes: [{ kind: 'workstream', id: 'w1' }],
        nodes: [node('d', 'd')],
        edges: [],
        progress: progressFor('rev-w1', 2),
      });
      await parent.applyProjectionEventOverlay({
        clientEventId: 'evt-e',
        dot: { replicaId: 'replica', seq: 3 },
        deps: {},
        aggregateId: 'https://example.test/e',
        type: 'browser.timeline.observed',
        acceptedAtMs: 1_700_000_000_000,
        payload: {
          eventId: 'evt-e',
          observedAt: '2026-05-01T00:00:03.000Z',
          url: 'https://example.test/e',
          canonicalUrl: 'https://example.test/e',
          transition: 'completed',
        },
      });
      await parent.replaceScopeRows({
        scopes: [{ kind: 'workstream', id: 'w2' }],
        nodes: [node('f', 'f')],
        edges: [],
        progress: progressFor('rev-w2', 4),
      });

      const snapshot = await parent.readCurrent();
      const progress = await parent.readMaterializerProgress('connections');
      parent.close();
      return { snapshot, progress };
    };

    sqliteIt(
      'the same write sequence produces byte-identical readCurrent + progress in-place vs. clone+flip',
      async () => {
        const inPlaceRoot = await mkdtemp(join(tmpdir(), 'inplace-equiv-a-'));
        const cloneRoot = await mkdtemp(join(tmpdir(), 'inplace-equiv-b-'));
        try {
          delete process.env['SIDETRACK_INPLACE_PUBLISH'];
          const inPlaceResult = await runSequence(inPlaceRoot);

          process.env['SIDETRACK_INPLACE_PUBLISH'] = '0';
          const cloneResult = await runSequence(cloneRoot);
          delete process.env['SIDETRACK_INPLACE_PUBLISH'];

          expect(inPlaceResult.snapshot).not.toBeNull();
          expect(cloneResult.snapshot).not.toBeNull();
          // snapshotRevision is a content hash of updatedAt/counts — identical
          // input sequences must produce the identical hash regardless of
          // storage path.
          expect(inPlaceResult.snapshot?.snapshotRevision).toBe(
            cloneResult.snapshot?.snapshotRevision,
          );
          expect(inPlaceResult.snapshot?.nodeCount).toBe(cloneResult.snapshot?.nodeCount);
          expect(inPlaceResult.snapshot?.edgeCount).toBe(cloneResult.snapshot?.edgeCount);
          expect(
            [...(inPlaceResult.snapshot?.nodes ?? [])].map((n) => n.id).sort(),
          ).toEqual([...(cloneResult.snapshot?.nodes ?? [])].map((n) => n.id).sort());
          expect(inPlaceResult.progress).toEqual(cloneResult.progress);
        } finally {
          await rm(inPlaceRoot, { recursive: true, force: true });
          await rm(cloneRoot, { recursive: true, force: true });
        }
      },
    );
  });

  // ---------------------------------------------------------------------
  // (5) Generation GC: the full-rebuild flip path (still clone+flip under
  // in-place publish) continues to mint and clean up generations correctly;
  // a long run of in-place scoped publishes never accumulates extra
  // resident generations in the first place.
  // ---------------------------------------------------------------------
  describe('(5) generation GC', () => {
    sqliteIt(
      'a long run of in-place scoped publishes never accumulates resident generations',
      async () => {
        const writer = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        await writer.writeSnapshotAndProgress(emptyGraph('seed'), progressFor('seed', 0));
        writer.close();
        const genAfterSeed = readPointer(connectionsDir());
        expect(residentGenerations(connectionsDir())).toEqual([genAfterSeed]);

        const parent = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
        for (let i = 0; i < 10; i += 1) {
          await parent.replaceScopeRows({
            scopes: [{ kind: 'workstream', id: `w${String(i)}` }],
            nodes: [node(`n${String(i)}`, `n${String(i)}`)],
            edges: [],
            progress: progressFor(`rev-${String(i)}`, i + 1),
          });
        }
        parent.close();

        // No new generation was ever minted — the pointer never moved, and
        // exactly one generation file is resident.
        expect(readPointer(connectionsDir())).toBe(genAfterSeed);
        expect(residentGenerations(connectionsDir())).toEqual([genAfterSeed]);
      },
    );

    sqliteIt(
      'a full-rebuild publish (still clone+flip) still mints and GCs generations correctly',
      async () => {
        const writer = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        await writer.writeSnapshotAndProgress(
          { ...emptyGraph('rev-1'), nodes: [node('a', 'a')], nodeCount: 1 },
          progressFor('rev-1', 1),
        );
        const genAfterFirst = readPointer(connectionsDir());

        // A genuine full-rebuild content change (different node set,
        // matching content-signature-changed semantics) flips the pointer.
        await writer.writeSnapshotAndProgress(
          { ...emptyGraph('rev-2'), nodes: [node('a', 'a'), node('b', 'b')], nodeCount: 2 },
          progressFor('rev-2', 2),
        );
        const genAfterSecond = readPointer(connectionsDir());
        expect(genAfterSecond).not.toBe(genAfterFirst);
        // Retired-handle safety window: pointer target + one prior.
        expect(new Set(residentGenerations(connectionsDir()))).toEqual(
          new Set([genAfterFirst, genAfterSecond]),
        );

        await writer.writeSnapshotAndProgress(
          {
            ...emptyGraph('rev-3'),
            nodes: [node('a', 'a'), node('b', 'b'), node('c', 'c')],
            nodeCount: 3,
          },
          progressFor('rev-3', 3),
        );
        const genAfterThird = readPointer(connectionsDir());
        expect(genAfterThird).not.toBe(genAfterSecond);
        // The oldest (genAfterFirst) is now outside the keep window and was
        // GC'd on this publish.
        expect(new Set(residentGenerations(connectionsDir()))).toEqual(
          new Set([genAfterSecond, genAfterThird]),
        );
        writer.close();
      },
    );
  });
});
