import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore, type ConnectionsSnapshot } from '../../connections/snapshot.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import {
  compareConnectionsDrift,
  createConnectionsMaterializer,
  MATERIALIZER_VERSION,
} from './connectionsMaterializer.js';
import { addDotsToIntervals, intervalsContainDot } from './materializerProgress.js';

const threadEvent = (seq: number): AcceptedEvent => ({
  clientEventId: `thread-${String(seq)}`,
  dot: { replicaId: 'replica-progress', seq },
  deps: {},
  aggregateId: `thread-${String(seq)}`,
  type: THREAD_UPSERTED,
  payload: {
    bac_id: `thread_${String(seq)}`,
    provider: 'chatgpt',
    title: `Thread ${String(seq)}`,
    threadUrl: `https://example.test/thread-${String(seq)}`,
    lastSeenAt: '2026-05-22T10:00:00.000Z',
  },
  acceptedAtMs: Date.parse('2026-05-22T10:00:00.000Z') + seq,
});

const emptySnapshot = (nodes: ConnectionsSnapshot['nodes'] = []): ConnectionsSnapshot => ({
  scope: { kind: 'current' },
  nodes,
  edges: [],
  updatedAt: '2026-05-22T10:00:00.000Z',
  nodeCount: nodes.length,
  edgeCount: 0,
  snapshotRevision: 'rev',
});

describe('connections materializer progress', () => {
  let vaultRoot: string;
  let previousSkipRankerSnapshot: string | undefined;
  let previousConnectionsInprocess: string | undefined;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-connections-progress-'));
    previousSkipRankerSnapshot = process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
    previousConnectionsInprocess = process.env['SIDETRACK_CONNECTIONS_INPROCESS'];
    process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = '1';
    process.env['SIDETRACK_CONNECTIONS_INPROCESS'] = '1';
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
    if (previousSkipRankerSnapshot === undefined)
      delete process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'];
    else process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = previousSkipRankerSnapshot;
    if (previousConnectionsInprocess === undefined)
      delete process.env['SIDETRACK_CONNECTIONS_INPROCESS'];
    else process.env['SIDETRACK_CONNECTIONS_INPROCESS'] = previousConnectionsInprocess;
  });

  it('writes progress on first catchUp and no-ops on a subsequent catchUp', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    let writeCount = 0;
    const recordingStore = {
      ...store,
      writeSnapshotAndProgress: async (
        ...args: Parameters<typeof store.writeSnapshotAndProgress>
      ) => {
        writeCount += 1;
        await store.writeSnapshotAndProgress(...args);
      },
    };
    await eventLog.importPeerEvent(threadEvent(1));
    const materializer = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store: recordingStore,
    });

    await materializer.catchUp(eventLog);
    expect(writeCount).toBe(1);
    const progress = await store.readMaterializerProgress('connections');
    expect(progress?.materializerVersion).toBe(MATERIALIZER_VERSION);
    expect(
      progress === null
        ? false
        : intervalsContainDot(progress.appliedDotIntervals, threadEvent(1).dot),
    ).toBe(true);

    await materializer.catchUp(eventLog);
    expect(writeCount).toBe(1);
  });

  it('updates progress after new events arrive', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    await eventLog.importPeerEvent(threadEvent(1));
    const materializer = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
    });
    await materializer.catchUp(eventLog);

    for (let seq = 2; seq <= 6; seq += 1) {
      await eventLog.importPeerEvent(threadEvent(seq));
    }

    const before = await store.readMaterializerProgress('connections');
    const pendingBefore =
      before === null
        ? []
        : (await eventLog.readMerged()).filter(
            (event) => !intervalsContainDot(before.appliedDotIntervals, event.dot),
          );
    expect(pendingBefore).toHaveLength(5);

    await materializer.catchUp(eventLog);
    const after = await store.readMaterializerProgress('connections');
    for (let seq = 1; seq <= 6; seq += 1) {
      expect(
        after === null
          ? false
          : intervalsContainDot(after.appliedDotIntervals, threadEvent(seq).dot),
      ).toBe(true);
    }
  });

  it('forces a full rebuild when persisted materializer version mismatches', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    await eventLog.importPeerEvent(threadEvent(1));
    const materializer = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
    });
    await materializer.catchUp(eventLog);

    const snapshot = await store.readCurrent();
    const progress = await store.readMaterializerProgress('connections');
    if (snapshot === null || progress === null)
      throw new Error('expected seeded snapshot progress');
    await store.writeSnapshotAndProgress(snapshot, {
      ...progress,
      materializerVersion: 'connections@old',
    });

    await materializer.catchUp(eventLog);
    const after = await store.readMaterializerProgress('connections');
    expect(after?.materializerVersion).toBe(MATERIALIZER_VERSION);
  });

  it('survives in-memory accumulator reset by relying on persisted progress', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    await eventLog.importPeerEvent(threadEvent(1));

    const first = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });
    await first.catchUp(eventLog);
    const second = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });
    await second.catchUp(eventLog);

    expect(second.health().status).toBe('healthy');
    const progress = await store.readMaterializerProgress('connections');
    expect(
      progress === null
        ? false
        : intervalsContainDot(progress.appliedDotIntervals, threadEvent(1).dot),
    ).toBe(true);
  });

  it('reports clean drift comparison for matching shadow state', () => {
    const event = threadEvent(1);
    const snapshot = emptySnapshot();
    const report = compareConnectionsDrift({
      checkedAt: '2026-05-22T10:00:00.000Z',
      materializerVersion: MATERIALIZER_VERSION,
      liveSnapshot: snapshot,
      shadowSnapshot: snapshot,
      liveProgress: {
        materializerName: 'connections',
        materializerVersion: MATERIALIZER_VERSION,
        appliedDotIntervals: addDotsToIntervals({}, [event.dot]),
        appliedFrontier: { 'replica-progress': 1 },
        snapshotRevisionId: 'rev',
      },
      shadowEvents: [event],
    });

    expect(report.conclusion).toBe('clean');
    expect(report.nodeDiff).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(report.edgeDiff).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('reports drift when the live snapshot has a manual node mismatch', () => {
    const event = threadEvent(1);
    const liveSnapshot = emptySnapshot([
      {
        id: 'thread:manual',
        kind: 'thread',
        label: 'Manual',
        metadata: {},
      },
    ]);
    const shadowSnapshot = emptySnapshot();
    const report = compareConnectionsDrift({
      checkedAt: '2026-05-22T10:00:00.000Z',
      materializerVersion: MATERIALIZER_VERSION,
      liveSnapshot,
      shadowSnapshot,
      liveProgress: {
        materializerName: 'connections',
        materializerVersion: MATERIALIZER_VERSION,
        appliedDotIntervals: addDotsToIntervals({}, [event.dot]),
        appliedFrontier: { 'replica-progress': 1 },
        snapshotRevisionId: 'rev',
      },
      shadowEvents: [event],
    });

    expect(report.conclusion).toBe('drift');
    expect(report.nodeDiff).toEqual({ added: 0, removed: 1, changed: 0 });
  });
});
