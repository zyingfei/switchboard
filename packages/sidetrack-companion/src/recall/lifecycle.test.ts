import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRecallActivityTracker } from './activity.js';
import { createRecallLifecycle } from './lifecycle.js';
import { writeIndex } from './indexFile.js';

const FAKE_DIM = 384;

const seedEvents = async (vaultRoot: string, count: number): Promise<void> => {
  const dir = join(vaultRoot, '_BAC', 'events');
  await mkdir(dir, { recursive: true });
  const lines = Array.from({ length: count }, (_, ordinal) =>
    JSON.stringify({
      bac_id: 'thread_x',
      capturedAt: '2026-05-04T00:00:00.000Z',
      turns: [{ ordinal, role: 'user', text: `seed turn ${String(ordinal)}` }],
    }),
  );
  await writeFile(join(dir, '2026-05-04.jsonl'), `${lines.join('\n')}\n`);
};

describe('recall lifecycle', () => {
  it('reports missing when no index file is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-missing-'));
    try {
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'test/model',
        rebuilder: () => Promise.resolve({ indexed: 0 }),
        log: () => undefined,
        warn: () => undefined,
      });
      const report = await lifecycle.report();
      expect(report.status).toBe('missing');
      expect(report.entryCount).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports stale when the index header model differs from the current one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-stale-'));
    try {
      const indexPath = join(root, '_BAC', 'recall', 'index.bin');
      const embedding = new Float32Array(FAKE_DIM);
      embedding[0] = 1;
      await writeIndex(
        indexPath,
        [{ id: 'turn_a', threadId: 'thread_a', capturedAt: '2026-05-04T00:00:00.000Z', embedding }],
        'old/model',
      );
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'new/model',
        rebuilder: () => Promise.resolve({ indexed: 1 }),
        log: () => undefined,
        warn: () => undefined,
      });
      const report = await lifecycle.report();
      expect(report.status).toBe('stale');
      expect(report.modelId).toBe('old/model');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ensureFresh schedules a background rebuild when stale and resolves to ready after it completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-rebuild-'));
    try {
      await seedEvents(root, 2);
      let calls = 0;
      const rebuilder = async (): Promise<{ readonly indexed: number }> => {
        calls += 1;
        const indexPath = join(root, '_BAC', 'recall', 'index.bin');
        const embedding = new Float32Array(FAKE_DIM);
        embedding[0] = 1;
        await writeIndex(
          indexPath,
          [
            { id: 'turn_a', threadId: 't', capturedAt: '2026-05-04T00:00:00.000Z', embedding },
            { id: 'turn_b', threadId: 't', capturedAt: '2026-05-04T00:00:00.000Z', embedding },
          ],
          'fresh/model',
        );
        return { indexed: 2 };
      };
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'fresh/model',
        rebuilder,
        log: () => undefined,
        warn: () => undefined,
      });
      const before = await lifecycle.ensureFresh();
      expect(before.status).toBe('missing');
      expect(lifecycle.isRebuilding()).toBe(true);
      await lifecycle.waitForRebuild();
      const after = await lifecycle.report();
      expect(after.status).toBe('ready');
      expect(after.entryCount).toBe(2);
      expect(after.lastRebuildIndexed).toBe(2);
      expect(calls).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records rebuild activity for health diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-activity-'));
    try {
      await seedEvents(root, 1);
      const activity = createRecallActivityTracker(() => new Date('2026-05-05T00:00:00.000Z'));
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'fresh/model',
        rebuilder: () => Promise.resolve({ indexed: 1 }),
        log: () => undefined,
        warn: () => undefined,
        activity,
      });
      lifecycle.scheduleRebuild('manual');
      await lifecycle.waitForRebuild();

      expect(activity.report()).toMatchObject({
        lastIndexedAt: '2026-05-05T00:00:00.000Z',
        lastIndexedCount: 1,
        recent: [
          { kind: 'rebuild-finished', count: 1 },
          { kind: 'rebuild-started', reason: 'manual' },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('captures rebuilder errors without crashing the process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-error-'));
    try {
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'fresh/model',
        rebuilder: () => Promise.reject(new Error('embedder boom')),
        log: () => undefined,
        warn: () => undefined,
      });
      lifecycle.scheduleRebuild('manual');
      await lifecycle.waitForRebuild();
      const report = await lifecycle.report();
      expect(report.lastError).toBe('embedder boom');
      expect(report.status).toBe('missing');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('flips status to stale when entry count lags the event log past the drift tolerance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-drift-'));
    try {
      await seedEvents(root, 10);
      const indexPath = join(root, '_BAC', 'recall', 'index.bin');
      const embedding = new Float32Array(FAKE_DIM);
      embedding[0] = 1;
      // Index has 5 entries, event log has 10 turns -> 50% drift,
      // well past the default 5% tolerance.
      await writeIndex(
        indexPath,
        Array.from({ length: 5 }, (_, i) => ({
          id: `t:${String(i)}`,
          threadId: 't',
          capturedAt: '2026-05-04T00:00:00.000Z',
          embedding,
        })),
        'fresh/model',
      );
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'fresh/model',
        rebuilder: () => Promise.resolve({ indexed: 10 }),
        log: () => undefined,
        warn: () => undefined,
      });
      const report = await lifecycle.report();
      expect(report.status).toBe('stale');
      expect(report.drift.eventTurnCount).toBe(10);
      expect(report.drift.entryCount).toBe(5);
      expect(report.drift.pct).toBeGreaterThan(0.4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('drift counter walks the per-replica log so cross-replica peer-synced events count toward eventTurnCount', async () => {
    // Pre-PR-#93 captures live in `_BAC/events/`. Post-PR-#93 captures
    // (especially peer-synced events) live ONLY under
    // `_BAC/log/<replicaId>/`. countTurnsInEventLog used to read just
    // the legacy path, so a vault that received 10 peer-synced
    // captures would report eventTurnCount=0, drift=0, "ready" — and
    // never auto-rebuild even though the index covers nothing the
    // peer sent. This test guards against regression.
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-peer-drift-'));
    try {
      const { createEventLog } = await import('../sync/eventLog.js');
      const { loadOrCreateReplica } = await import('../sync/replicaId.js');
      const replica = await loadOrCreateReplica(root);
      const eventLog = createEventLog(root, replica);
      // Simulate a peer-synced capture by importing a foreign-replica
      // event under a different replicaId. importPeerEvent is the
      // exact code path the relay client takes when relaying a peer
      // event into our log.
      await eventLog.importPeerEvent({
        clientEventId: 'peer-evt-1',
        dot: { replicaId: 'remote-replica-aaaaaa', seq: 1 },
        deps: {},
        aggregateId: 'thread_remote',
        type: 'capture.recorded',
        payload: {
          bac_id: 'thread_remote',
          capturedAt: '2026-05-04T00:00:00.000Z',
          turns: [
            { ordinal: 0, role: 'user', text: 'peer turn 1' },
            { ordinal: 1, role: 'assistant', text: 'peer turn 2' },
          ],
        },
        acceptedAtMs: 1_780_000_000_000,
      });
      const indexPath = join(root, '_BAC', 'recall', 'index.bin');
      // Empty index: should drift hard against the 2 peer turns.
      await writeIndex(indexPath, [], 'fresh/model');
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'fresh/model',
        rebuilder: () => Promise.resolve({ indexed: 0 }),
        eventLog,
        log: () => undefined,
        warn: () => undefined,
      });
      const report = await lifecycle.report();
      expect(report.eventTurnCount).toBe(2);
      // The drift status flips to 'stale' because entryCount=0 with
      // eventTurnCount > 0 — the same condition that triggers an
      // auto-rebuild on the actual lifecycle.
      expect(report.status).toBe('stale');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not flag drift when entry count meets or exceeds the event log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-no-drift-'));
    try {
      await seedEvents(root, 5);
      const indexPath = join(root, '_BAC', 'recall', 'index.bin');
      const embedding = new Float32Array(FAKE_DIM);
      embedding[0] = 1;
      // Peer entries can land before this replica captures the same
      // turns locally — entryCount > eventTurnCount must still read
      // as 'ready', not 'stale'.
      await writeIndex(
        indexPath,
        Array.from({ length: 7 }, (_, i) => ({
          id: `t:${String(i)}`,
          threadId: 't',
          capturedAt: '2026-05-04T00:00:00.000Z',
          embedding,
        })),
        'fresh/model',
      );
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'fresh/model',
        rebuilder: () => Promise.resolve({ indexed: 7 }),
        log: () => undefined,
        warn: () => undefined,
      });
      const report = await lifecycle.report();
      expect(report.status).toBe('ready');
      expect(report.drift.pct).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('appendEntry writes through the mutex (back-compat low-level path used by POST /v1/recall/index)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-append-'));
    try {
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'fresh/model',
        rebuilder: () => Promise.resolve({ indexed: 0 }),
        embedder: () => Promise.resolve([]),
        log: () => undefined,
        warn: () => undefined,
      });
      const embedding = new Float32Array(FAKE_DIM);
      embedding[0] = 1;
      await lifecycle.appendEntry({
        id: 'thread1:0',
        threadId: 'thread1',
        capturedAt: '2026-05-04T00:00:00.000Z',
        embedding,
      });
      const { readIndex } = await import('./indexFile.js');
      const indexFile = await readIndex(join(root, '_BAC', 'recall', 'index.bin'));
      expect(indexFile?.items.map((item) => item.id)).toEqual(['thread1:0']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serialises rebuild and appendEntry so concurrent calls cannot interleave', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-mutex-'));
    try {
      const events: string[] = [];
      const slowRebuilder = async (): Promise<{ readonly indexed: number }> => {
        events.push('rebuild:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('rebuild:end');
        return { indexed: 0 };
      };
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'fresh/model',
        rebuilder: slowRebuilder,
        embedder: () => Promise.resolve([]),
        log: () => undefined,
        warn: () => undefined,
      });
      lifecycle.scheduleRebuild('manual');
      const embedding = new Float32Array(FAKE_DIM);
      embedding[0] = 1;
      const appendPromise = (async () => {
        events.push('append:queued');
        await lifecycle.appendEntry({
          id: 't:0',
          threadId: 't',
          capturedAt: '2026-05-04T00:00:00.000Z',
          embedding,
        });
        events.push('append:done');
      })();
      await lifecycle.waitForRebuild();
      await appendPromise;

      const rebuildEnd = events.indexOf('rebuild:end');
      const appendDone = events.indexOf('append:done');
      // Mutex invariant: appendEntry waits for the rebuild to
      // finish before its own write commits. Even though both got
      // scheduled near-concurrently, the enqueueWrite lane forces
      // FIFO ordering.
      expect(rebuildEnd).toBeGreaterThan(-1);
      expect(appendDone).toBeGreaterThan(rebuildEnd);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('tombstoneByThread emits a recall.tombstone.target event AND mutates the index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-tombstone-'));
    try {
      const { createEventLog } = await import('../sync/eventLog.js');
      const { loadOrCreateReplica } = await import('../sync/replicaId.js');
      const replica = await loadOrCreateReplica(root);
      const eventLog = createEventLog(root, replica);
      const indexPath = join(root, '_BAC', 'recall', 'index.bin');
      const embedding = new Float32Array(FAKE_DIM);
      embedding[0] = 1;
      await writeIndex(
        indexPath,
        [{ id: 't:0', threadId: 't', capturedAt: '2026-05-04T00:00:00.000Z', embedding }],
        'fresh/model',
      );
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'fresh/model',
        rebuilder: () => Promise.resolve({ indexed: 0 }),
        replica: { replicaId: replica.replicaId, nextSeq: replica.nextSeq },
        eventLog,
        log: () => undefined,
        warn: () => undefined,
      });
      const result = await lifecycle.tombstoneByThread('t');
      expect(result.tombstoned).toBe(1);
      const merged = await eventLog.readMerged();
      expect(
        merged
          .filter((event) => event.type === 'recall.tombstone.target')
          .map((event) => (event.payload as { readonly threadId?: string }).threadId),
      ).toEqual(['t']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('counts captured turns across multiple jsonl files for coverage hints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recall-lifecycle-coverage-'));
    try {
      await seedEvents(root, 3);
      const lifecycle = createRecallLifecycle({
        vaultRoot: root,
        companionVersion: '0.0.0-test',
        currentModelId: 'test/model',
        rebuilder: () => Promise.resolve({ indexed: 0 }),
        log: () => undefined,
        warn: () => undefined,
      });
      const report = await lifecycle.report();
      expect(report.eventTurnCount).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
