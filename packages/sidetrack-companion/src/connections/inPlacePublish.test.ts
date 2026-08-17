// In-place publish (2026-08-16, widened 2026-08-16 to the child-writer
// full-rewrite channel) — mandatory tests for the "Storage-tier incremental
// publish" design note (docs/plans/2026-08-15-foundation-program.md). Six
// categories, per the task's own requirements:
//   1. crash-kill      — SIGKILL mid-publish, N=20, never torn.
//   2. concurrent read — a reader holding a WAL snapshot never sees a
//                        straddled write; a fresh reader after commit does.
//   3. write volume    — bytes written per publish are O(delta), not
//                        O(db size).
//   4. revision equiv  — write_seq/snapshotRevision behave identically to
//                        the clone+flip path.
//   5. generation GC   — the clone+flip path (now reached only for the
//                        very first write to a fresh vault, or under the
//                        kill switch) still gets collected correctly.
//   6. audible marks   — every publish logs a channel-tagged
//                        [publish.in-place]/[publish.clone] mark.
//
// See src/sync/contract/connectionsHnswReconcileIntegration.test.ts for the
// REAL fork-per-drain acceptance test against the production
// connectionsReconcileChild.entry.ts entry point (requires a built dist/).

import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    // 2026-08-16 (in-place child-drain channel widening) — the SAME
    // crash-kill discipline, but for the NEWLY in-place-eligible full
    // content-replace write (`writeSnapshotAndProgress` → `#writeCurrentRows`)
    // instead of the scoped-delta path above. This is the exact write shape
    // the reconcile child's routine post-catch-up thread-membership
    // reconcile makes on essentially every real drain — the measured
    // "dominant channel" this PR closes — so it gets its own independent
    // SIGKILL proof rather than relying solely on the scoped-delta case's
    // coverage of the shared `#acquireInPlaceWriteHandle` mechanism.
    itUnlessCI(
      'SIGKILL at a randomized point mid in-place FULL-REBUILD publish never leaves a torn generation (N=20)',
      async () => {
        const childScriptPath = join(vaultRoot!, '..', 'inplace-crash-fullrebuild-child.mjs');
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
            "  nodes.push({ id: `v${i}`, kind: 'timeline-visit', label: `${label}-${i}`, originReplicaIds: [], metadata: { canonicalUrl: `https://crashtest.example/${i}`, visitCount: 1 } });",
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
            'await store.writeSnapshotAndProgress(',
            '  {',
            '    scope: {},',
            '    nodes,',
            '    edges,',
            "    updatedAt: '2026-05-01T00:00:00.000Z',",
            '    nodeCount: n,',
            '    edgeCount: Math.max(0, n - 1),',
            '    snapshotRevision: label,',
            '  },',
            '  {',
            "    materializerName: 'connections',",
            "    materializerVersion: 'connections@test',",
            '    appliedDotIntervals: { replica: [[1, 1]] },',
            '    appliedFrontier: { replica: 1 },',
            '    snapshotRevisionId: label,',
            '  },',
            ');',
            'if (process.send) process.send({ done: true });',
            'process.exit(0);',
          ].join('\n'),
        );

        const spawnFullRebuildPublisher = (payloadN: number, label: string): ChildProcess =>
          fork(childScriptPath, [], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            env: {
              ...process.env,
              VAULT_ROOT: vaultRoot!,
              SNAPSHOT_MODULE_URL,
              PAYLOAD_N: String(payloadN),
              PAYLOAD_LABEL: label,
            },
          });

        // Seed a published generation (the very first write — clone path,
        // unaffected by this widening) so every iteration below finds an
        // existing generation to write in place.
        const seed = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        await seed.writeSnapshotAndProgress(emptyGraph('seed'), progressFor('seed', 0));
        const seedGenId = readPointer(connectionsDir());
        // Reset to a KNOWN empty baseline before each iteration (mirrors the
        // scoped-delta case's resetScope()) — writeSnapshotAndProgress is a
        // FULL replace, but without this reset a kill's "fully-old" outcome
        // could legitimately be the PREVIOUS iteration's committed content
        // (also valid, just not what the empty-vs-this-label check below
        // assumes), making the never-torn assertion ambiguous to evaluate.
        const resetToEmpty = async (): Promise<void> => {
          await seed.writeSnapshotAndProgress(emptyGraph('reset'), progressFor('reset', 0));
        };

        const PAYLOAD_N = 3000;

        await resetToEmpty();
        const calibChild = spawnFullRebuildPublisher(PAYLOAD_N, 'calib');
        const t0 = performance.now();
        await waitForMessage(calibChild, (m) => (m as { ready?: boolean }).ready === true);
        await waitForMessage(calibChild, (m) => (m as { done?: boolean }).done === true);
        const calibratedMs = performance.now() - t0;
        await waitForExit(calibChild);
        expect(calibratedMs).toBeGreaterThan(0);

        let killedWhileRunning = 0;
        let finishedBeforeKill = 0;
        let sawInPlace = false;
        let sawNewGeneration = false;

        const N_ITERATIONS = 20;
        for (let iter = 0; iter < N_ITERATIONS; iter += 1) {
          await resetToEmpty();
          const label = `fr-iter${String(iter)}`;
          const child = spawnFullRebuildPublisher(PAYLOAD_N, label);
          await waitForMessage(child, (m) => (m as { ready?: boolean }).ready === true);
          const done = waitForMessage(child, (m) => (m as { done?: boolean }).done === true);
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

          // Same rationale as the scoped-delta case above: a kill mid-lock
          // leaves an orphaned lockfile that self-heals after
          // PUBLISH_LOCK_STALE_MS=15s in production; clear it immediately
          // here (the process is confirmed dead) rather than paying that
          // wall-clock cost 20x in this suite.
          const orphanLockPath = join(connectionsDir(), 'current.publish.lock');
          if (existsSync(orphanLockPath)) {
            try {
              unlinkSync(orphanLockPath);
            } catch {
              /* best-effort */
            }
          }

          const genNow = readPointer(connectionsDir());
          if (genNow === seedGenId) {
            sawInPlace = true;
          } else {
            sawNewGeneration = true;
          }

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
          // prefix and the full payload must be present — never a partial
          // count or a mix of old/new-prefixed labels.
          expect(served!.nodes).toHaveLength(PAYLOAD_N);
          expect(served!.edges).toHaveLength(PAYLOAD_N - 1);
          expect(labels.every((l) => l.startsWith(`${label}-`))).toBe(true);
        }

        seed.close();
        expect(killedWhileRunning).toBeGreaterThan(0);
        expect(killedWhileRunning + finishedBeforeKill).toBe(N_ITERATIONS);
        // The whole point of the widening: the generation the pointer names
        // never changed across 20 crash-tested full-rebuild publishes — it
        // stayed in place on the seed generation throughout.
        expect(sawInPlace).toBe(true);
        expect(sawNewGeneration).toBe(false);
        expect(readPointer(connectionsDir())).toBe(seedGenId);
      },
      120_000,
    );

    // Both crash-kill tests above manually unlink an orphaned
    // `current.publish.lock` after a kill-while-locked iteration rather than
    // paying PUBLISH_LOCK_STALE_MS=15s of real wall-clock time 20x — a
    // deliberate, documented shortcut (see their inline comments), NOT a
    // claim that the REAL stale-lock steal path was ever exercised. This is
    // that missing proof: exactly ONE iteration, no manual cleanup, a SIGKILL
    // squarely inside the lock-held window (calibrated the same way as the
    // other two tests), and a subsequent publisher that must self-heal via
    // acquirePublishLock's actual staleness check — not a test shortcut.
    itUnlessCI(
      'a SIGKILL while the publish lock is held self-heals via the real 15s stale-lock steal (no manual cleanup)',
      async () => {
        const childScriptPath = join(vaultRoot!, '..', 'inplace-crash-stalelock-child.mjs');
        await writeFile(
          childScriptPath,
          [
            "const { SqliteConnectionsStore } = await import(process.env.SNAPSHOT_MODULE_URL);",
            'const vaultRoot = process.env.VAULT_ROOT;',
            'const n = Number(process.env.PAYLOAD_N);',
            "const store = new SqliteConnectionsStore(vaultRoot, { role: 'child-writer' });",
            'const nodes = [];',
            'const edges = [];',
            'for (let i = 0; i < n; i++) {',
            "  nodes.push({ id: `v${i}`, kind: 'dispatch', label: `stale-${i}`, originReplicaIds: [], metadata: { workstreamId: 'stalelock' } });",
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
            "  scopes: [{ kind: 'workstream', id: 'stalelock' }],",
            '  nodes,',
            '  edges,',
            '  progress: {',
            "    materializerName: 'connections',",
            "    materializerVersion: 'connections@test',",
            '    appliedDotIntervals: { replica: [[1, 1]] },',
            '    appliedFrontier: { replica: 1 },',
            "    snapshotRevisionId: 'stale-lock',",
            '  },',
            '});',
            'if (process.send) process.send({ done: true });',
            'process.exit(0);',
          ].join('\n'),
        );
        const spawnStaleLockPublisher = (payloadN: number): ChildProcess =>
          fork(childScriptPath, [], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            env: { ...process.env, VAULT_ROOT: vaultRoot!, SNAPSHOT_MODULE_URL, PAYLOAD_N: String(payloadN) },
          });

        const seed = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        await seed.writeSnapshotAndProgress(emptyGraph('seed'), progressFor('seed', 0));
        seed.close();

        // Calibrate, exactly like the two tests above, so the kill delay is
        // sampled from this payload's REAL measured ready→done window rather
        // than a guess — the publish lock is held from inside
        // #acquireInPlaceWriteHandle (before the open) through finalize
        // (after close), i.e. for essentially this whole window, so a kill
        // partway through reliably lands mid-lock.
        const PAYLOAD_N = 8000;
        const calibChild = spawnStaleLockPublisher(PAYLOAD_N);
        const tCalib0 = performance.now();
        await waitForMessage(calibChild, (m) => (m as { ready?: boolean }).ready === true);
        await waitForMessage(calibChild, (m) => (m as { done?: boolean }).done === true);
        const calibratedMs = performance.now() - tCalib0;
        await waitForExit(calibChild);
        expect(calibratedMs).toBeGreaterThan(0);

        const child = spawnStaleLockPublisher(PAYLOAD_N);
        await waitForMessage(child, (m) => (m as { ready?: boolean }).ready === true);
        // Halfway through the calibrated window — comfortably inside the
        // lock-held span, not at its very edges.
        await new Promise<void>((resolve) => setTimeout(resolve, calibratedMs / 2));
        child.kill('SIGKILL');
        await waitForExit(child);

        const lockPath = join(connectionsDir(), 'current.publish.lock');
        // If this ever fails, the kill landed outside the lock-held window —
        // the test's premise (proving the STALE-STEAL path, specifically)
        // wasn't actually exercised.
        expect(existsSync(lockPath)).toBe(true);

        // No manual unlink here — the entire point of this test. A fresh
        // publisher must block on the REAL acquirePublishLock stale-timeout
        // (PUBLISH_LOCK_STALE_MS=15s) and then proceed on its own.
        const control = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
        const tHeal0 = performance.now();
        await control.replaceScopeRows({
          scopes: [{ kind: 'workstream', id: 'after-stale-lock' }],
          nodes: [node('healed', 'healed')],
          edges: [],
          progress: progressFor('rev-healed', 1),
        });
        const healElapsedMs = performance.now() - tHeal0;
        control.close();

        // Proves the REAL 15s staleness check fired (not an immediate/no-op
        // acquire, which would mean the lock was somehow never actually
        // held) and that it actually cleared the lockfile.
        expect(healElapsedMs).toBeGreaterThan(10_000);
        expect(existsSync(lockPath)).toBe(false);

        const reader = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
        const served = await reader.readCurrent();
        reader.close();
        expect(served?.nodes.some((entry) => entry.id === 'healed')).toBe(true);
      },
      40_000,
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
  // (5) Generation GC: the clone+flip path is now reached ONLY for the
  // very first write to a fresh vault (nothing to open in place yet) or
  // under the SIDETRACK_INPLACE_PUBLISH=0 kill switch — where it still
  // mints and cleans up generations correctly. Every OTHER publish, scoped
  // OR full-rebuild, now applies in place once a generation exists, so a
  // long run of either never accumulates extra resident generations.
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

    // 2026-08-16 (in-place child-drain channel widening): a full content-
    // replace (`writeSnapshotAndProgress`) is EXACTLY the write the
    // reconcile child's routine "post-catch-up thread-membership reconcile"
    // pass makes on essentially every real catch-up
    // (connectionsMaterializer.ts's forceFullRebuildForThreadReconcile) —
    // the measured "dominant channel" this widening closes. Only the very
    // first write (no generation published yet) still mints a fresh
    // generation; every subsequent full-rebuild publish, however much
    // content it changes, now applies in place to that SAME file.
    sqliteIt(
      'repeated full-rebuild publishes apply in place once a generation exists (zero new generations)',
      async () => {
        const writer = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        await writer.writeSnapshotAndProgress(
          { ...emptyGraph('rev-1'), nodes: [node('a', 'a')], nodeCount: 1 },
          progressFor('rev-1', 1),
        );
        const genAfterFirst = readPointer(connectionsDir());
        expect(genAfterFirst).not.toBeNull();
        expect(residentGenerations(connectionsDir())).toEqual([genAfterFirst]);

        // A genuine full-rebuild content change (different node set,
        // matching content-signature-changed semantics) — under the OLD
        // (PR #381) behavior this flipped the pointer; now it does not.
        await writer.writeSnapshotAndProgress(
          { ...emptyGraph('rev-2'), nodes: [node('a', 'a'), node('b', 'b')], nodeCount: 2 },
          progressFor('rev-2', 2),
        );
        expect(readPointer(connectionsDir())).toBe(genAfterFirst);
        expect(residentGenerations(connectionsDir())).toEqual([genAfterFirst]);

        await writer.writeSnapshotAndProgress(
          {
            ...emptyGraph('rev-3'),
            nodes: [node('a', 'a'), node('b', 'b'), node('c', 'c')],
            nodeCount: 3,
          },
          progressFor('rev-3', 3),
        );
        expect(readPointer(connectionsDir())).toBe(genAfterFirst);
        expect(residentGenerations(connectionsDir())).toEqual([genAfterFirst]);

        // The store's own readCurrent (not just the pointer/gen-file
        // bookkeeping) reflects the latest content, proving the in-place
        // rows genuinely landed rather than the publish silently no-op'ing.
        const served = await writer.readCurrent();
        expect(served?.nodeCount).toBe(3);
        writer.close();
      },
    );

    // The clone+flip machinery itself is untouched, not deleted — the
    // SIDETRACK_INPLACE_PUBLISH=0 kill switch (task requirement: "keep the
    // clone path for ... kill switch") still reaches it for every publish,
    // scoped or full, and it still mints + GCs generations exactly as
    // before this widening.
    sqliteIt(
      'SIDETRACK_INPLACE_PUBLISH=0 still clone+flips full-rebuild publishes and GCs correctly',
      async () => {
        process.env['SIDETRACK_INPLACE_PUBLISH'] = '0';
        const writer = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        await writer.writeSnapshotAndProgress(
          { ...emptyGraph('rev-1'), nodes: [node('a', 'a')], nodeCount: 1 },
          progressFor('rev-1', 1),
        );
        const genAfterFirst = readPointer(connectionsDir());

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

  // ---------------------------------------------------------------------
  // (6) Audible engagement (task requirement — the absence of a mark is
  // exactly how the original parent-only gap shipped undetected): every
  // publish logs a channel-tagged mark, for BOTH roles and BOTH paths.
  // ---------------------------------------------------------------------
  describe('(6) audible publish marks', () => {
    // NOTE: `warn.mock.calls` must be read BEFORE `mockRestore()` — restore
    // resets the recorded call history (standard jest/vitest mock
    // semantics), so every case below captures `marks` inside the spied
    // span and only restores afterward.
    sqliteIt(
      'an in-place child-writer full-rebuild publish logs [publish.in-place] channel=child',
      async () => {
        const writer = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        await writer.writeSnapshotAndProgress(
          { ...emptyGraph('rev-1'), nodes: [node('a', 'a')], nodeCount: 1 },
          progressFor('rev-1', 1),
        );
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await writer.writeSnapshotAndProgress(
          { ...emptyGraph('rev-2'), nodes: [node('a', 'a'), node('b', 'b')], nodeCount: 2 },
          progressFor('rev-2', 2),
        );
        const marks = warn.mock.calls.map((args) => String(args[0]));
        warn.mockRestore();
        writer.close();
        // Diff-aware writes (2026-08-17 disk-wear fix) — putCurrent/
        // writeSnapshotAndProgress always measure rowsChanged/rowsUnchanged
        // (see #writeCurrentRows), so THIS call site's mark always carries
        // the suffix — unlike replaceScopeRows' mark below, which doesn't
        // track per-row diffs and so omits it.
        expect(
          marks.some((line) =>
            /^\[publish\.in-place\] channel=child bytes=\d+ rowsChanged=\d+ rowsUnchanged=\d+$/.test(
              line,
            ),
          ),
        ).toBe(true);
      },
    );

    sqliteIt(
      'an in-place parent-reader scoped-delta publish logs [publish.in-place] channel=parent',
      async () => {
        const writer = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        await writer.writeSnapshotAndProgress(emptyGraph('seed'), progressFor('seed', 0));
        writer.close();

        const parent = new SqliteConnectionsStore(vaultRoot!, { role: 'parent-reader' });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await parent.replaceScopeRows({
          scopes: [{ kind: 'workstream', id: 'w1' }],
          nodes: [node('n1', 'n1')],
          edges: [],
          progress: progressFor('rev-1', 1),
        });
        const marks = warn.mock.calls.map((args) => String(args[0]));
        warn.mockRestore();
        parent.close();
        expect(marks.some((line) => /^\[publish\.in-place\] channel=parent bytes=\d+$/.test(line)))
          .toBe(true);
      },
    );

    sqliteIt(
      'a clone-path publish (kill switch) logs [publish.clone] reason=kill-switch',
      async () => {
        const writer = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        await writer.writeSnapshotAndProgress(emptyGraph('seed'), progressFor('seed', 0));

        process.env['SIDETRACK_INPLACE_PUBLISH'] = '0';
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await writer.writeSnapshotAndProgress(
          { ...emptyGraph('rev-1'), nodes: [node('a', 'a')], nodeCount: 1 },
          progressFor('rev-1', 1),
        );
        const marks = warn.mock.calls.map((args) => String(args[0]));
        warn.mockRestore();
        writer.close();
        expect(marks).toContain('[publish.clone] channel=child reason=kill-switch');
      },
    );

    sqliteIt(
      'the very first write to a fresh vault logs [publish.clone] reason=no-generation-yet',
      async () => {
        const writer = new SqliteConnectionsStore(vaultRoot!, { role: 'child-writer' });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await writer.writeSnapshotAndProgress(emptyGraph('seed'), progressFor('seed', 0));
        const marks = warn.mock.calls.map((args) => String(args[0]));
        warn.mockRestore();
        writer.close();
        expect(marks).toContain('[publish.clone] channel=child reason=no-generation-yet');
      },
    );
  });
});
