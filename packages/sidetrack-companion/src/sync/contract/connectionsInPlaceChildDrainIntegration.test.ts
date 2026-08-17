// Real fork-per-drain acceptance test for the "in-place child-drain
// channel" widening (2026-08-16, docs/plans/2026-08-15-foundation-program.md
// "Storage-tier incremental publish" design note's 2026-08-16 addendum).
// Unlike
// connections/inPlacePublish.test.ts (which calls SqliteConnectionsStore
// methods directly, bypassing the materializer), this test drives the ACTUAL
// production entry point — a real forked `connectionsReconcileChild.entry.js`
// process running the real ConnectionsMaterializer.catchUp() against a real
// event log — the exact process production spawns with
// SIDETRACK_CONNECTIONS_CHILD=1. Requires a built dist/ (see
// connectionsHnswReconcileIntegration.test.ts, which pioneers this harness
// for HNSW; this file reuses the same runReconcileInChild client).
//
// What it proves that the lower-level unit tests cannot: the materializer's
// OWN branch selection (scoped-delta vs full-rebuild — connectionsMaterializer.ts,
// out of bounds for this task) still lands on a channel that
// SqliteConnectionsStore now applies in place once a generation exists,
// end to end, through the real IPC handoff — not just that the store method
// CAN publish in place when called directly.

import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteConnectionsStore } from '../../connections/snapshot.js';
import { generationDbPath, readPointer, residentGenerations } from '../../connections/generationBuffer.js';
import type { ConnectionNode, ConnectionsSnapshot } from '../../connections/types.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createEventLog, type EventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { MATERIALIZER_VERSION } from './connectionsMaterializer.js';
import { runReconcileInChild, setReconcileChildScriptOverride } from './connectionsReconcileChildClient.js';

const itUnlessCI = process.env['CI'] ? it.skip : it;

const childEntryPath = (): string =>
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'dist',
    'sync',
    'contract',
    'connectionsReconcileChild.entry.js',
  );

const connectionsDir = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'connections');

const appendVisit = async (
  eventLog: EventLog,
  input: { readonly index: number; readonly observedAt: string },
): ReturnType<EventLog['appendClientObserved']> =>
  eventLog.appendClientObserved({
    clientEventId: `inplace-real-child-${String(input.index)}`,
    aggregateId: `inplace-real-child-${String(input.index)}`,
    type: BROWSER_TIMELINE_OBSERVED,
    baseVector: {},
    payload: {
      eventId: `inplace-real-child-${String(input.index)}`,
      observedAt: input.observedAt,
      url: `https://inplace-real-child.test/${String(input.index)}`,
      canonicalUrl: `https://inplace-real-child.test/${String(input.index)}`,
      title: `real child drain fixture visit ${String(input.index)}`,
      provider: 'generic',
      transition: 'activated',
      payloadVersion: 1,
      dimensions: { engagement: { focusedWindowMs: 10_000 } },
    },
  });

const padNode = (id: string, pad: string): ConnectionNode => ({
  id,
  kind: 'timeline-visit',
  label: `${id}-${pad}`,
  originReplicaIds: [],
  metadata: { canonicalUrl: `https://inplace-fixture-pad.test/${id}`, visitCount: 1 },
});

describe('in-place publish — real child-drain acceptance (2026-08-16-2)', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'inplace-real-child-'));
    process.env['SIDETRACK_TEST_EMBEDDER'] = '1';
    process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = '1';
    delete process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'];
    setReconcileChildScriptOverride(childEntryPath());
  });

  afterEach(async () => {
    setReconcileChildScriptOverride(undefined);
    delete process.env['SIDETRACK_TEST_EMBEDDER'];
    delete process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
    delete process.env['SIDETRACK_INPLACE_PUBLISH'];
    await rm(vaultRoot, { recursive: true, force: true });
  });

  itUnlessCI(
    'a real forked reconcile child applying a ~100-event scoped delta against a large fixture publishes in place: zero new generation files, bytes O(delta)',
    async () => {
      const replica = await loadOrCreateReplica(vaultRoot);
      const eventLog = createEventLog(vaultRoot, replica);

      // Bootstrap: a small batch of REAL events through the REAL production
      // entry point, establishing genuine materializer progress and the
      // first published generation. The very first write to a fresh vault
      // is a retained clone case (nothing to open in place yet) — expected
      // and not what this test measures.
      for (let i = 0; i < 20; i += 1) {
        await appendVisit(eventLog, {
          index: i,
          observedAt: new Date(Date.parse('2026-05-22T10:00:00.000Z') + i * 1000).toISOString(),
        });
      }
      const bootstrap = await runReconcileInChild({ vaultRoot, seq: 1 });
      expect(bootstrap.ok).toBe(true);

      const dir = connectionsDir(vaultRoot);
      const genId = readPointer(dir);
      expect(genId).not.toBeNull();

      // Inflate the SAME published generation to a realistic large-fixture
      // size via a direct row write — fast (no re-running the real
      // materializer's embedding/similarity/ranker pipeline just to pad
      // bytes) and preserves the real materializer's own progress/frontier
      // EXACTLY as it left them (read back and written verbatim, no new
      // events consumed), so the next real catch-up still sees a coherent,
      // version-matched state to resume from.
      const inflator = new SqliteConnectionsStore(vaultRoot, { role: 'child-writer' });
      const priorProgress = await inflator.readMaterializerProgress('connections');
      const priorSnapshot = await inflator.readCurrent();
      expect(priorProgress).not.toBeNull();
      expect(priorProgress?.materializerVersion).toBe(MATERIALIZER_VERSION);
      expect(priorSnapshot).not.toBeNull();
      const pad = 'x'.repeat(1400);
      const PAD_N = 60_000;
      const padNodes: ConnectionNode[] = Array.from({ length: PAD_N }, (_unused, i) =>
        padNode(`pad-${String(i)}`, pad),
      );
      const inflatedSnapshot: ConnectionsSnapshot = {
        ...priorSnapshot!,
        nodes: [...priorSnapshot!.nodes, ...padNodes],
        nodeCount: priorSnapshot!.nodeCount + PAD_N,
      };
      await inflator.writeSnapshotAndProgress(inflatedSnapshot, priorProgress!);
      inflator.close();

      const genPath = generationDbPath(dir, genId!);
      const walPath = `${genPath}-wal`;
      const fixtureBytes = statSync(genPath).size;
      // Document (not silently assume) the achieved fixture size — the
      // task's own target was ~100MB; proportional stand-in for test-suite
      // runtime, same discipline as inPlacePublish.test.ts's write-volume case.
      expect(fixtureBytes).toBeGreaterThan(50_000_000);

      const residentBefore = residentGenerations(dir);
      const dbBytesBefore = statSync(genPath).size;
      const walBytesBefore = existsSync(walPath) ? statSync(walPath).size : 0;

      // The channel under test: append a small (~100-event) REAL delta and
      // run the ACTUAL production reconcile child again — this is the
      // steady-state child-drain path, driven end to end through the real
      // IPC handoff, not a direct store-method call.
      const DELTA_N = 100;
      for (let i = 20; i < 20 + DELTA_N; i += 1) {
        await appendVisit(eventLog, {
          index: i,
          observedAt: new Date(Date.parse('2026-05-22T10:05:00.000Z') + i * 1000).toISOString(),
        });
      }
      const steadyState = await runReconcileInChild({ vaultRoot, seq: 2 });
      expect(steadyState.ok).toBe(true);

      const residentAfter = residentGenerations(dir);
      const dbBytesAfter = statSync(genPath).size;
      const walBytesAfter = existsSync(walPath) ? statSync(walPath).size : 0;

      // Zero new generation files: the pointer still names the SAME
      // generation, and the resident set is byte-identical to before.
      expect(readPointer(dir)).toBe(genId);
      expect(residentAfter).toEqual(residentBefore);

      const totalWrittenBytes =
        Math.max(0, dbBytesAfter - dbBytesBefore) + Math.max(0, walBytesAfter - walBytesBefore);
      console.warn(
        `[inplace-real-child.write-volume] fixtureBytes=${String(fixtureBytes)} deltaEvents=${String(DELTA_N)} totalWrittenBytes=${String(totalWrittenBytes)} (${(totalWrittenBytes / fixtureBytes * 100).toFixed(3)}% of fixture)`,
      );
      expect(totalWrittenBytes).toBeLessThan(5 * 1024 * 1024);
    },
    120_000,
  );
});
