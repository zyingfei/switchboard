import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildConnectionsSnapshot,
  createConnectionsStore,
  SqliteConnectionsStore,
  type ConnectionsInput,
  type ConnectionsSnapshot,
  type ConnectionsStore,
} from '../../connections/snapshot.js';
import { nodeIdFor } from '../../connections/types.js';
import { createEmptyTabSessionProjection } from '../../tabsession/projection.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import { WORKSTREAM_UPSERTED } from '../../workstreams/events.js';
import { mergeRegister, type AcceptedEvent, type VersionVector } from '../causal.js';
import { createEventLog, type EventLog } from '../eventLog.js';
import { loadOrCreateReplica, type ReplicaContext } from '../replicaId.js';
import { createSyncContractRunner } from './runner.js';
import {
  createConnectionsMaterializer,
  MATERIALIZER_VERSION,
  type ConnectionsMaterializer,
} from './connectionsMaterializer.js';
import {
  addDotsToIntervals,
  EMPTY_PROGRESS,
  intervalsContainDot,
  type MaterializerProgress,
} from './materializerProgress.js';

const envKeys = [
  'SIDETRACK_SKIP_RANKER_SNAPSHOT',
  'SIDETRACK_CONNECTIONS_INPROCESS',
  'SIDETRACK_CONNECTIONS_INCREMENTAL_SCOPES',
  'SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY',
  'SIDETRACK_CONNECTIONS_DRIFT_DISABLED',
  'SIDETRACK_TOPIC_PRODUCER',
  'SIDETRACK_SIMILARITY_THRESHOLD',
  'SIDETRACK_SIMILARITY_TOP_K',
  'SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS',
] as const;

const at = (seq: number): number => Date.parse('2026-05-22T10:00:00.000Z') + seq;

const event = (input: {
  readonly type: string;
  readonly replicaId: string;
  readonly seq: number;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly deps?: VersionVector;
  readonly acceptedAtMs?: number;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}.${String(input.seq)}.${input.type}.${input.aggregateId}`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: input.deps ?? {},
  aggregateId: input.aggregateId,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? at(input.seq),
});

const workstreamUpserted = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly bacId: string;
  readonly title: string;
  readonly deps?: VersionVector;
  readonly acceptedAtMs?: number;
}): AcceptedEvent =>
  event({
    type: WORKSTREAM_UPSERTED,
    replicaId: input.replicaId,
    seq: input.seq,
    deps: input.deps,
    aggregateId: input.bacId,
    acceptedAtMs: input.acceptedAtMs,
    payload: { bac_id: input.bacId, title: input.title },
  });

const threadUpserted = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly bacId: string;
  readonly title: string;
  readonly deps?: VersionVector;
  readonly acceptedAtMs?: number;
}): AcceptedEvent =>
  event({
    type: THREAD_UPSERTED,
    replicaId: input.replicaId,
    seq: input.seq,
    deps: input.deps,
    aggregateId: input.bacId,
    acceptedAtMs: input.acceptedAtMs,
    payload: {
      bac_id: input.bacId,
      provider: 'chatgpt',
      threadUrl: `https://thread.example.test/${input.bacId}`,
      title: input.title,
      lastSeenAt: '2026-05-22T10:00:00.000Z',
    },
  });

const emptyInput = (events: readonly AcceptedEvent[]): ConnectionsInput => ({
  events,
  threads: [],
  workstreams: [],
  dispatches: [],
  queueItems: [],
  reminders: [],
  codingSessions: [],
  timelineDays: [],
  tabSessionProjection: createEmptyTabSessionProjection(),
  urlProjection: { schemaVersion: 1, byCanonicalUrl: new Map() },
});

const fullSnapshotFor = (events: readonly AcceptedEvent[]): ConnectionsSnapshot =>
  buildConnectionsSnapshot(emptyInput(events));

const eventSequence = (replicaId: string): readonly AcceptedEvent[] => [
  workstreamUpserted({ replicaId, seq: 1, bacId: 'W1', title: 'Planning' }),
  threadUpserted({
    replicaId,
    seq: 2,
    bacId: 'T1',
    title: 'First thread',
    deps: { [replicaId]: 1 },
  }),
  workstreamUpserted({
    replicaId,
    seq: 3,
    bacId: 'W2',
    title: 'Follow-up',
    deps: { [replicaId]: 2 },
  }),
  threadUpserted({
    replicaId,
    seq: 4,
    bacId: 'T2',
    title: 'Second thread',
    deps: { [replicaId]: 3 },
  }),
];

const normalizeGeneratedSnapshot = (snapshot: ConnectionsSnapshot): ConnectionsSnapshot => ({
  ...snapshot,
  updatedAt: '<updatedAt>',
  snapshotRevision: '<snapshotRevision>',
});

const normalizeReplicaIds = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeReplicaIds);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'replicaId') {
      out[key] = '<replica>';
    } else if (key === 'originReplicaIds') {
      out[key] = ['<replica>'];
    } else {
      out[key] = normalizeReplicaIds(child);
    }
  }
  return out;
};

const normalizeProgress = (progress: MaterializerProgress | null): unknown => {
  if (progress === null) return null;
  return {
    ...progress,
    appliedDotIntervals: '<dot-intervals>',
    appliedFrontier: '<frontier>',
    snapshotRevisionId: '<snapshotRevisionId>',
  };
};

const createNoisyFreeMaterializer = (input: {
  readonly vaultRoot: string;
  readonly eventLog: EventLog;
  readonly store: ConnectionsStore;
  readonly embed?: (texts: readonly string[]) => Promise<readonly Float32Array[]>;
}): ConnectionsMaterializer =>
  createConnectionsMaterializer({
    vaultRoot: input.vaultRoot,
    eventLog: input.eventLog,
    timelineStore: createTimelineStore(input.vaultRoot),
    store: input.store,
    ...(input.embed === undefined ? {} : { embed: input.embed }),
    rankerRetrainer: () =>
      Promise.resolve({
        status: 'skipped',
        reason: 'no-labels',
        fingerprint: {
          hash: 'empty',
          labelCount: 0,
          positiveLabelCount: 0,
          negativeLabelCount: 0,
        },
        newLabelCount: 0,
      }),
    diagnosticsStore: { write: async () => undefined },
    diagnosticsLogger: () => {},
  });

const importEvents = async (
  eventLog: EventLog,
  events: readonly AcceptedEvent[],
): Promise<void> => {
  for (const accepted of events) await eventLog.importPeerEvent(accepted);
};

const appendLocalSequence = async (
  eventLog: EventLog,
  replica: ReplicaContext,
): Promise<readonly AcceptedEvent[]> => {
  const out: AcceptedEvent[] = [];
  for (const source of eventSequence(replica.replicaId)) {
    const accepted = await eventLog.appendClientObserved({
      clientEventId: source.clientEventId,
      aggregateId: source.aggregateId,
      type: source.type,
      payload: source.payload,
      baseVector: source.deps,
    });
    out.push(accepted);
  }
  return out;
};

const timelineObserved = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly index: number;
}): AcceptedEvent =>
  event({
    type: BROWSER_TIMELINE_OBSERVED,
    replicaId: input.replicaId,
    seq: input.seq,
    aggregateId: `visit-${String(input.index)}`,
    payload: {
      eventId: `visit-${String(input.index)}`,
      observedAt: new Date(at(input.seq)).toISOString(),
      url: `https://v${String(input.index)}.example.test/p${String(input.index)}`,
      canonicalUrl: `https://v${String(input.index)}.example.test/p${String(input.index)}`,
      title: `visit-${String(input.index)}`,
      provider: 'generic',
      transition: 'activated',
      payloadVersion: 1,
      dimensions: { engagement: { focusedWindowMs: 10_000 } },
    },
  });

const unitVector = (values: readonly number[]): Float32Array => {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return Float32Array.from(values.map((value) => value / norm));
};

const deterministicSimilarityVectors = (count: number): ReadonlyMap<number, Float32Array> => {
  const vectors = new Map<number, Float32Array>();
  for (let index = 0; index < count; index += 1) {
    const group = Math.floor(index / 10);
    const slot = index % 10;
    vectors.set(
      index,
      unitVector([
        group === 0 ? 1 : 0,
        group === 1 ? 1 : 0,
        group === 2 ? 1 : 0,
        group === 3 ? 1 : 0,
        group === 4 ? 1 : 0,
        slot / 100,
      ]),
    );
  }
  return vectors;
};

const embedFromVisitTitle = (
  vectors: ReadonlyMap<number, Float32Array>,
): ((texts: readonly string[]) => Promise<readonly Float32Array[]>) => {
  const fallback = Float32Array.from([1, 0, 0, 0, 0, 0]);
  return async (texts) =>
    texts.map((text) => {
      const match = /visit-(\d+)/u.exec(text);
      if (match === null) return fallback;
      return vectors.get(Number(match[1])) ?? fallback;
    });
};

const similarityRows = (
  snapshot: ConnectionsSnapshot,
): ReadonlyArray<{ readonly pair: string; readonly cosine: number }> =>
  snapshot.edges
    .filter((edge) => edge.kind === 'visit_resembles_visit')
    .map((edge) => {
      const cosine = edge.metadata?.['cosine'];
      if (typeof cosine !== 'number') throw new Error('missing similarity cosine metadata');
      return {
        pair: `${edge.fromNodeId}\u0000${edge.toNodeId}`,
        cosine,
      };
    })
    .sort((left, right) => left.pair.localeCompare(right.pair));

const materializeSimilarityFixture = async (input: {
  readonly root: string;
  readonly flag: 'on' | 'off';
  readonly count: number;
}): Promise<ConnectionsSnapshot> => {
  process.env['SIDETRACK_CONNECTIONS_INCREMENTAL_SIMILARITY'] =
    input.flag === 'on' ? '1' : '0';
  process.env['SIDETRACK_SIMILARITY_THRESHOLD'] = '0.9';
  process.env['SIDETRACK_SIMILARITY_TOP_K'] = '50';
  process.env['SIDETRACK_SIMILARITY_MIN_ENGAGEMENT_MS'] = '0';
  const replica = await loadOrCreateReplica(input.root);
  const eventLog = createEventLog(input.root, replica);
  const store = createConnectionsStore(input.root);
  const vectors = deterministicSimilarityVectors(input.count);
  const materializer = createNoisyFreeMaterializer({
    vaultRoot: input.root,
    eventLog,
    store,
    embed: embedFromVisitTitle(vectors),
  });
  await importEvents(
    eventLog,
    Array.from({ length: input.count }, (_, index) =>
      timelineObserved({ replicaId: 'sim', seq: index + 1, index }),
    ),
  );
  await materializer.catchUp(eventLog);
  const snapshot = await store.readCurrent();
  if (snapshot === null) throw new Error('expected similarity snapshot');
  return snapshot;
};

const createDeterministicEventLog = (vaultPath: string, replica: ReplicaContext): EventLog => {
  let callCount = 0;
  return createEventLog(vaultPath, replica, {
    now: () => {
      callCount += 1;
      return new Date(at(Math.ceil(callCount / 2)));
    },
  });
};

const materialize = async (
  vaultRoot: string,
  events: readonly AcceptedEvent[],
): Promise<{
  readonly store: ConnectionsStore;
  readonly eventLog: EventLog;
  readonly materializer: ConnectionsMaterializer;
  readonly snapshot: ConnectionsSnapshot;
  readonly progress: MaterializerProgress;
}> => {
  const replica = await loadOrCreateReplica(vaultRoot);
  const eventLog = createEventLog(vaultRoot, replica);
  const store = createConnectionsStore(vaultRoot);
  await importEvents(eventLog, events);
  const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });
  await materializer.catchUp(eventLog);
  const snapshot = await store.readCurrent();
  const progress = await store.readMaterializerProgress('connections');
  if (snapshot === null || progress === null) {
    throw new Error('expected materialized snapshot and progress');
  }
  return { store, eventLog, materializer, snapshot, progress };
};

describe('connections Class B integration invariants', () => {
  let vaultRoot: string;
  let previousEnv: Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-connections-classb-'));
    previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;
    process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = '1';
    process.env['SIDETRACK_CONNECTIONS_INPROCESS'] = '1';
    process.env['SIDETRACK_CONNECTIONS_DRIFT_DISABLED'] = '1';
    process.env['SIDETRACK_TOPIC_PRODUCER'] = 'union-find';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('local event incremental output equals full rebuild', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createDeterministicEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });
    const localEvents = await appendLocalSequence(eventLog, replica);

    await materializer.catchUp(eventLog);

    const incremental = await store.readCurrent();
    if (incremental === null) throw new Error('expected incremental snapshot');
    expect(normalizeGeneratedSnapshot(incremental)).toEqual(
      normalizeGeneratedSnapshot(fullSnapshotFor(localEvents)),
    );
  });

  it('peer-imported event incremental output equals local-origin output except dot replica progress', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'sidetrack-connections-classb-local-'));
    try {
      const replica = await loadOrCreateReplica(localRoot);
      const localLog = createDeterministicEventLog(localRoot, replica);
      const localStore = createConnectionsStore(localRoot);
      const localMaterializer = createNoisyFreeMaterializer({
        vaultRoot: localRoot,
        eventLog: localLog,
        store: localStore,
      });
      await appendLocalSequence(localLog, replica);
      await localMaterializer.catchUp(localLog);

      const peer = await materialize(vaultRoot, eventSequence('peer'));
      const localSnapshot = await localStore.readCurrent();
      const localProgress = await localStore.readMaterializerProgress('connections');
      if (localSnapshot === null || localProgress === null) {
        throw new Error('expected local snapshot and progress');
      }

      expect(normalizeReplicaIds(normalizeGeneratedSnapshot(peer.snapshot))).toEqual(
        normalizeReplicaIds(normalizeGeneratedSnapshot(localSnapshot)),
      );
      expect(normalizeProgress(peer.progress)).toEqual(normalizeProgress(localProgress));
      expect(peer.progress.appliedDotIntervals).toEqual({ peer: [[1, 4]] });
    } finally {
      await rm(localRoot, { recursive: true, force: true });
    }
  });

  it('stale browser baseVector {} is concurrent and does not dominate peer state', async () => {
    const peer = workstreamUpserted({
      replicaId: 'B',
      seq: 5,
      bacId: 'W',
      title: 'peer',
      deps: { B: 4 },
      acceptedAtMs: 500,
    });
    const stale = workstreamUpserted({
      replicaId: 'A',
      seq: 1,
      bacId: 'W',
      title: 'browser-stale',
      deps: {},
      acceptedAtMs: 100,
    });
    const expected = mergeRegister([
      { value: 'peer', event: peer },
      { value: 'browser-stale', event: stale },
    ]);
    const { snapshot } = await materialize(vaultRoot, [peer, stale]);
    const node = snapshot.nodes.find((candidate) => candidate.id === nodeIdFor('workstream', 'W'));

    expect(expected.status).toBe('conflict');
    expect(node?.label).toBe('browser-stale');
    expect(node?.metadata['causalRegister']).toMatchObject({
      status: 'conflict',
      candidates: [
        { value: expect.objectContaining({ title: 'browser-stale' }), event: { replicaId: 'A' } },
        { value: expect.objectContaining({ title: 'peer' }), event: { replicaId: 'B' } },
      ],
    });
  });

  it('out-of-order gapped peer dots are not skipped', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });
    const initial = [5, 3, 4, 1].map((seq) =>
      threadUpserted({ replicaId: 'B', seq, bacId: `T${String(seq)}`, title: `Thread ${seq}` }),
    );
    await importEvents(eventLog, initial);

    await materializer.catchUp(eventLog);
    const firstProgress = await store.readMaterializerProgress('connections');
    expect(firstProgress?.appliedDotIntervals['B']).toEqual([
      [1, 1],
      [3, 5],
    ]);
    const b2 = threadUpserted({ replicaId: 'B', seq: 2, bacId: 'T2', title: 'Thread 2' });
    expect(firstProgress?.appliedDotIntervals).toBeDefined();
    expect(intervalsContainDot(firstProgress!.appliedDotIntervals, b2.dot)).toBe(false);

    await eventLog.importPeerEvent(b2);
    await materializer.catchUp(eventLog);

    const finalProgress = await store.readMaterializerProgress('connections');
    expect(finalProgress?.appliedDotIntervals['B']).toEqual([[1, 5]]);
  });

  it('crash after graph write but before progress write does not corrupt state', async () => {
    const { Database } = (await import('bun:sqlite')) as typeof import('bun:sqlite');
    const originalQuery = Database.prototype.query;
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
    const store = new SqliteConnectionsStore(vaultRoot);
    const snapshot = fullSnapshotFor([
      threadUpserted({ replicaId: 'A', seq: 1, bacId: 'T1', title: 'T1' }),
    ]);
    const progress = {
      ...EMPTY_PROGRESS('connections', MATERIALIZER_VERSION),
      appliedDotIntervals: addDotsToIntervals({}, [{ replicaId: 'A', seq: 1 }]),
      appliedFrontier: { A: 1 },
      snapshotRevisionId: snapshot.snapshotRevision ?? null,
    };

    await expect(store.writeSnapshotAndProgress(snapshot, progress)).rejects.toThrow(
      'simulated progress write crash',
    );

    expect(await store.readCurrent()).toBeNull();
    expect(await store.readMaterializerProgress('connections')).toBeNull();
    store.close();
  });

  it('crash impossible because progress + rows commit together', async () => {
    const store = new SqliteConnectionsStore(vaultRoot);
    const snapshot = fullSnapshotFor([
      threadUpserted({ replicaId: 'A', seq: 1, bacId: 'T1', title: 'T1' }),
    ]);
    const progress = {
      ...EMPTY_PROGRESS('connections', MATERIALIZER_VERSION),
      appliedDotIntervals: addDotsToIntervals({}, [{ replicaId: 'A', seq: 1 }]),
      appliedFrontier: { A: 1 },
      snapshotRevisionId: snapshot.snapshotRevision ?? null,
    };

    await store.writeSnapshotAndProgress(snapshot, progress);

    expect(await store.readCurrent()).toEqual(snapshot);
    expect(await store.readMaterializerProgress('connections')).toEqual(progress);
    store.close();
  });

  it('relay reconnect awaits catchUp and leaves health accurate', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });
    const runner = createSyncContractRunner();
    runner.register(materializer);
    await importEvents(
      eventLog,
      Array.from({ length: 100 }, (_, index) =>
        threadUpserted({
          replicaId: 'B',
          seq: index + 1,
          bacId: `T${String(index + 1)}`,
          title: `Thread ${String(index + 1)}`,
        }),
      ),
    );
    const before = Date.now();

    await runner.onRelayReconnected(eventLog);

    const health = materializer.health();
    const progress = await store.readMaterializerProgress('connections');
    expect(health.pending).toBe(false);
    expect(
      health.lastSuccessAt === null ? 0 : Date.parse(health.lastSuccessAt),
    ).toBeGreaterThanOrEqual(before);
    expect(progress?.appliedFrontier).toEqual({ B: 100 });
  });

  it('child-process drain uses persisted state, not in-memory-only accumulators', async () => {
    const events = eventSequence('B');
    const first = await materialize(vaultRoot, events);
    const preResetSnapshot = await first.store.readCurrent();
    const preResetProgress = await first.store.readMaterializerProgress('connections');
    if (preResetSnapshot === null || preResetProgress === null) {
      throw new Error('expected pre-reset state');
    }
    let writeCount = 0;
    const recordingStore: ConnectionsStore = {
      ...first.store,
      writeSnapshotAndProgress: async (...args) => {
        writeCount += 1;
        await first.store.writeSnapshotAndProgress(...args);
      },
      replaceScopeRows:
        first.store.replaceScopeRows === undefined
          ? undefined
          : async (...args) => {
              writeCount += 1;
              await first.store.replaceScopeRows!(...args);
            },
    };
    const resetMaterializer = createNoisyFreeMaterializer({
      vaultRoot,
      eventLog: first.eventLog,
      store: recordingStore,
    });

    await resetMaterializer.catchUp(first.eventLog);

    expect(writeCount).toBe(0);
    expect(await first.store.readCurrent()).toEqual(preResetSnapshot);
    expect(await first.store.readMaterializerProgress('connections')).toEqual(preResetProgress);
  });

  it('HNSW path produces the same similarity edges as pairwise for deterministic embeddings', async () => {
    const pairwiseRoot = await mkdtemp(join(tmpdir(), 'sidetrack-connections-pairwise-'));
    try {
      const hnswSnapshot = await materializeSimilarityFixture({
        root: vaultRoot,
        flag: 'on',
        count: 50,
      });
      const pairwiseSnapshot = await materializeSimilarityFixture({
        root: pairwiseRoot,
        flag: 'off',
        count: 50,
      });
      const hnswRows = similarityRows(hnswSnapshot);
      const pairwiseRows = similarityRows(pairwiseSnapshot);

      expect(hnswRows.map((row) => row.pair)).toEqual(pairwiseRows.map((row) => row.pair));
      for (let i = 0; i < hnswRows.length; i += 1) {
        expect(Math.abs(hnswRows[i]!.cosine - pairwiseRows[i]!.cosine)).toBeLessThanOrEqual(1e-6);
      }
    } finally {
      await rm(pairwiseRoot, { recursive: true, force: true });
    }
  });

  it('falls back to pairwise similarity when incremental similarity is disabled', async () => {
    const snapshot = await materializeSimilarityFixture({
      root: vaultRoot,
      flag: 'off',
      count: 12,
    });

    expect(similarityRows(snapshot).length).toBeGreaterThan(0);
  });
});
