// F8 W4 acceptance: the workstream-parent store kills the unconditional
// full-rebuild bail on ANY workstream CRUD (docs/plans/
// 2026-08-16-f8-ivm-designs.md, "Root causes" item 3 / "W4"). Root
// cause: invalidation.ts unconditionally emits {kind:'workstreamTree'}
// for WORKSTREAM_UPSERTED/WORKSTREAM_DELETED, and that kind sits in the
// connections materializer's SCOPED_DELTA_FULL_REBUILD_INVALIDATION_
// KINDS — forcing a bail (post-W3: an unconditional demotion) on every
// workstream create/rename/reparent/delete, however small the actual
// change.
//
// These tests prove: with SIDETRACK_WORKSTREAM_PARENT_STORE=1, a scoped
// drain that reparents (or deletes) a workstream produces
// workstream_parent_of + thread_in_workstream + workstream node rows
// byte-identical to a full rebuild, via the TRUE scoped-delta path
// (`replaceScopeRows scopedTimelineDelta`) — with no
// `scopedTimelineDelta.demoted` mark and no `buildConnectionsSnapshot
// base` mark on that drain. A companion control proves the flag actually
// gates this: with it off, the identical scenario still demotes today
// (rides W3's repair queue).
//
// NOTE on scope (mirrors connectionsThreadRegisterMembership.test.ts):
// the served snapshot in this system never garbage-collects a node once
// created via some OTHER scope's edge reference, so node-row equivalence
// below is checked as "every workstream node a full rebuild produces is
// present, byte-identical, in the served snapshot" (a superset check),
// not full node-set identity.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildConnectionsSnapshot,
  createConnectionsStore,
  type ConnectionsInput,
  type ConnectionsSnapshot,
  type ConnectionsStore,
  type ThreadVaultRecord,
  type WorkstreamVaultRecord,
} from '../../connections/snapshot.js';
import { createEmptyTabSessionProjection } from '../../tabsession/projection.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
import { WORKSTREAM_DELETED, WORKSTREAM_UPSERTED } from '../../workstreams/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import { type AcceptedEvent, type VersionVector } from '../causal.js';
import { createEventLog, type EventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createConnectionsMaterializer, type ConnectionsMaterializer } from './connectionsMaterializer.js';

const envKeys = [
  'SIDETRACK_SKIP_RANKER_SNAPSHOT',
  'SIDETRACK_CONNECTIONS_INPROCESS',
  'SIDETRACK_CONNECTIONS_INCREMENTAL_SCOPES',
  'SIDETRACK_CONNECTIONS_DRIFT_DISABLED',
  'SIDETRACK_TOPIC_PRODUCER',
  'SIDETRACK_WORKSTREAM_PARENT_STORE',
  'SIDETRACK_CONNECTIONS_PHASE_LOG',
] as const;

const at = (seq: number): number => Date.parse('2026-08-16T10:00:00.000Z') + seq;

const workstreamUpserted = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly bacId: string;
  readonly title: string;
  readonly parentId?: string;
  readonly deps?: VersionVector;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}.${String(input.seq)}.workstream`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: input.deps ?? {},
  aggregateId: input.bacId,
  type: WORKSTREAM_UPSERTED,
  payload: {
    bac_id: input.bacId,
    title: input.title,
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
  },
  acceptedAtMs: at(input.seq),
});

const workstreamDeleted = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly bacId: string;
  readonly deps?: VersionVector;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}.${String(input.seq)}.workstream-deleted`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: input.deps ?? {},
  aggregateId: input.bacId,
  type: WORKSTREAM_DELETED,
  payload: { bac_id: input.bacId },
  acceptedAtMs: at(input.seq),
});

const threadUpserted = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly bacId: string;
  readonly workstreamId: string;
  readonly deps?: VersionVector;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}.${String(input.seq)}.thread`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: input.deps ?? {},
  aggregateId: input.bacId,
  type: THREAD_UPSERTED,
  payload: {
    bac_id: input.bacId,
    provider: 'chatgpt',
    threadUrl: `https://thread.example.test/${input.bacId}`,
    title: `${input.bacId} title`,
    lastSeenAt: '2026-08-16T10:00:00.000Z',
    primaryWorkstreamId: input.workstreamId,
  },
  acceptedAtMs: at(input.seq),
});

const writeWorkstreamVaultRecord = async (
  vaultRoot: string,
  record: WorkstreamVaultRecord,
): Promise<void> => {
  const dir = join(vaultRoot, '_BAC', 'workstreams');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${record.bac_id}.json`), JSON.stringify(record), 'utf8');
};

const removeWorkstreamVaultRecord = async (vaultRoot: string, bacId: string): Promise<void> => {
  await rm(join(vaultRoot, '_BAC', 'workstreams', `${bacId}.json`), { force: true });
};

const writeThreadVaultRecord = async (vaultRoot: string, record: ThreadVaultRecord): Promise<void> => {
  const dir = join(vaultRoot, '_BAC', 'threads');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${record.bac_id}.json`), JSON.stringify(record), 'utf8');
};

const emptyInputWithVaultRecords = (
  events: readonly AcceptedEvent[],
  input: {
    readonly threads?: readonly ThreadVaultRecord[];
    readonly workstreams?: readonly WorkstreamVaultRecord[];
  } = {},
): ConnectionsInput => ({
  events,
  threads: input.threads ?? [],
  workstreams: input.workstreams ?? [],
  dispatches: [],
  queueItems: [],
  reminders: [],
  codingSessions: [],
  timelineDays: [],
  tabSessionProjection: createEmptyTabSessionProjection(),
  urlProjection: { schemaVersion: 1, byCanonicalUrl: new Map() },
});

const workstreamParentOfEdges = (
  snapshot: ConnectionsSnapshot,
): readonly { readonly from: string; readonly to: string }[] =>
  [...snapshot.edges]
    .filter((edge) => edge.kind === 'workstream_parent_of')
    .map((edge) => ({ from: edge.fromNodeId, to: edge.toNodeId }))
    .sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

const threadInWorkstreamEdges = (
  snapshot: ConnectionsSnapshot,
): readonly { readonly from: string; readonly to: string }[] =>
  [...snapshot.edges]
    .filter((edge) => edge.kind === 'thread_in_workstream')
    .map((edge) => ({ from: edge.fromNodeId, to: edge.toNodeId }))
    .sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

const workstreamNodesById = (snapshot: ConnectionsSnapshot): ReadonlyMap<string, ConnectionsSnapshot['nodes'][number]> =>
  new Map(snapshot.nodes.filter((node) => node.kind === 'workstream').map((node) => [node.id, node]));

// Every workstream node a full rebuild produces must be present, BYTE-
// IDENTICAL, in the served (possibly-scoped) snapshot. Not a full
// node-SET identity check — see this file's header for why.
const expectWorkstreamNodesMatch = (
  served: ConnectionsSnapshot,
  full: ConnectionsSnapshot,
): void => {
  const servedById = workstreamNodesById(served);
  for (const node of workstreamNodesById(full).values()) {
    expect(servedById.get(node.id)).toEqual(node);
  }
};

const liveMaterializers: ConnectionsMaterializer[] = [];

const createNoisyFreeMaterializer = (input: {
  readonly vaultRoot: string;
  readonly eventLog: EventLog;
  readonly store: ConnectionsStore;
}): ConnectionsMaterializer => {
  const materializer = createConnectionsMaterializer({
    vaultRoot: input.vaultRoot,
    eventLog: input.eventLog,
    timelineStore: createTimelineStore(input.vaultRoot),
    store: input.store,
    rankerRetrainer: () =>
      Promise.resolve({
        status: 'skipped',
        reason: 'no-labels',
        fingerprint: { hash: 'empty', labelCount: 0, positiveLabelCount: 0, negativeLabelCount: 0 },
        newLabelCount: 0,
      }),
    diagnosticsStore: { write: async () => undefined },
    diagnosticsLogger: () => {},
  });
  liveMaterializers.push(materializer);
  return materializer;
};

const importEvents = async (eventLog: EventLog, events: readonly AcceptedEvent[]): Promise<void> => {
  for (const accepted of events) await eventLog.importPeerEvent(accepted);
};

// Captures every console.warn line emitted DURING fn (the phase-log
// channel this codebase's whole materializer uses — see
// connectionsThreadRegisterMembership.test.ts's identical pattern).
const capturePhaseLog = async (fn: () => Promise<void>): Promise<string> => {
  const output: string[] = [];
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((message?: unknown) => {
    output.push(String(message ?? ''));
  });
  try {
    await fn();
  } finally {
    warnSpy.mockRestore();
  }
  return output.join('\n');
};

describe('F8 W4 — workstream-parent store kills the workstreamTree bail', () => {
  let vaultRoot: string;
  let previousEnv: Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-workstream-tree-scoping-'));
    previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;
    process.env['SIDETRACK_SKIP_RANKER_SNAPSHOT'] = '1';
    process.env['SIDETRACK_CONNECTIONS_INPROCESS'] = '1';
    process.env['SIDETRACK_CONNECTIONS_DRIFT_DISABLED'] = '1';
    process.env['SIDETRACK_TOPIC_PRODUCER'] = 'union-find';
    process.env['SIDETRACK_CONNECTIONS_PHASE_LOG'] = '1';
  });

  afterEach(async () => {
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const materializer of liveMaterializers.splice(0)) {
      await materializer.awaitIdle();
    }
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('reparent: scoped drain moving B from parent A to parent C matches a full rebuild without demotion or a base rebuild', async () => {
    process.env['SIDETRACK_WORKSTREAM_PARENT_STORE'] = '1';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });

    // Founding tree: A and C are roots; B starts under A; thread T1 lives
    // under B ("threads under B" per the task's scenario).
    const foundA = workstreamUpserted({ replicaId: 'R', seq: 1, bacId: 'A', title: 'Workstream A' });
    const foundC = workstreamUpserted({ replicaId: 'R', seq: 2, bacId: 'C', title: 'Workstream C' });
    const foundB = workstreamUpserted({
      replicaId: 'R',
      seq: 3,
      bacId: 'B',
      title: 'Workstream B',
      parentId: 'A',
    });
    const foundT1 = threadUpserted({ replicaId: 'R', seq: 4, bacId: 'T1', workstreamId: 'B' });
    await importEvents(eventLog, [foundA, foundC, foundB, foundT1]);

    // Vault records mirror what the founding writes would have produced.
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'A', title: 'Workstream A', children: ['B'] });
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'C', title: 'Workstream C', children: [] });
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'B', title: 'Workstream B', parentId: 'A' });
    await writeThreadVaultRecord(vaultRoot, {
      bac_id: 'T1',
      title: 'T1 title',
      threadUrl: 'https://thread.example.test/T1',
      provider: 'chatgpt',
      lastSeenAt: '2026-08-16T10:00:00.000Z',
      primaryWorkstreamId: 'B',
    });
    await materializer.catchUp(eventLog);

    // Reparent B from A to C — the vault write (children[] bookkeeping)
    // lands alongside the event, matching production's "richer source"
    // invariant (snapshot.ts Pass 2's comment).
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'A', title: 'Workstream A', children: [] });
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'C', title: 'Workstream C', children: ['B'] });
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'B', title: 'Workstream B', parentId: 'C' });
    const reparented = workstreamUpserted({
      replicaId: 'R',
      seq: 5,
      bacId: 'B',
      title: 'Workstream B',
      parentId: 'C',
      deps: { R: 3 },
    });
    await importEvents(eventLog, [reparented]);
    const phase = await capturePhaseLog(() => materializer.catchUp(eventLog));

    expect(phase).not.toContain('scopedTimelineDelta.demoted');
    expect(phase).not.toContain('buildConnectionsSnapshot base');
    expect(phase).toContain('replaceScopeRows scopedTimelineDelta');

    const served = await store.readCurrent();
    if (served === null) throw new Error('expected scoped incremental snapshot');
    const full = buildConnectionsSnapshot(
      emptyInputWithVaultRecords([foundA, foundC, foundB, foundT1, reparented], {
        threads: [
          {
            bac_id: 'T1',
            title: 'T1 title',
            threadUrl: 'https://thread.example.test/T1',
            provider: 'chatgpt',
            lastSeenAt: '2026-08-16T10:00:00.000Z',
            primaryWorkstreamId: 'B',
          },
        ],
        workstreams: [
          { bac_id: 'A', title: 'Workstream A', children: [] },
          { bac_id: 'C', title: 'Workstream C', children: ['B'] },
          { bac_id: 'B', title: 'Workstream B', parentId: 'C' },
        ],
      }),
    );

    expect(workstreamParentOfEdges(served)).toEqual(workstreamParentOfEdges(full));
    expect(threadInWorkstreamEdges(served)).toEqual(threadInWorkstreamEdges(full));
    // Sanity: the reparent really did move the edge (old A->B is gone,
    // new C->B exists) — otherwise this test would pass vacuously.
    expect(workstreamParentOfEdges(full)).toEqual([{ from: 'workstream:C', to: 'workstream:B' }]);
    expectWorkstreamNodesMatch(served, full);
  });

  it('delete: scoped drain deleting a leaf workstream matches a full rebuild without demotion or a base rebuild', async () => {
    process.env['SIDETRACK_WORKSTREAM_PARENT_STORE'] = '1';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });

    const foundA = workstreamUpserted({ replicaId: 'R', seq: 1, bacId: 'A', title: 'Workstream A' });
    const foundD = workstreamUpserted({
      replicaId: 'R',
      seq: 2,
      bacId: 'D',
      title: 'Workstream D',
      parentId: 'A',
    });
    await importEvents(eventLog, [foundA, foundD]);
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'A', title: 'Workstream A', children: ['D'] });
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'D', title: 'Workstream D', parentId: 'A' });
    await materializer.catchUp(eventLog);

    // Delete D — the HTTP route refuses delete-with-children, so D (a
    // leaf) is the only legal target; the vault write drops D's file and
    // A's children[] bookkeeping removes D.
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'A', title: 'Workstream A', children: [] });
    await removeWorkstreamVaultRecord(vaultRoot, 'D');
    const deletedEvent = workstreamDeleted({ replicaId: 'R', seq: 3, bacId: 'D', deps: { R: 2 } });
    await importEvents(eventLog, [deletedEvent]);
    const phase = await capturePhaseLog(() => materializer.catchUp(eventLog));

    expect(phase).not.toContain('scopedTimelineDelta.demoted');
    expect(phase).not.toContain('buildConnectionsSnapshot base');
    expect(phase).toContain('replaceScopeRows scopedTimelineDelta');

    const served = await store.readCurrent();
    if (served === null) throw new Error('expected scoped incremental snapshot');
    const full = buildConnectionsSnapshot(
      emptyInputWithVaultRecords([foundA, foundD, deletedEvent], {
        workstreams: [{ bac_id: 'A', title: 'Workstream A', children: [] }],
      }),
    );

    expect(workstreamParentOfEdges(served)).toEqual(workstreamParentOfEdges(full));
    expect(workstreamParentOfEdges(full)).toEqual([]);
    expectWorkstreamNodesMatch(served, full);
  });

  it('control: with the store disabled, the same reparent DEMOTES instead of bailing to a base rebuild (F8 W3)', async () => {
    // No SIDETRACK_WORKSTREAM_PARENT_STORE=1 — proves the flag (not some
    // unrelated fast path) is what changes drain behavior above.
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });

    const foundA = workstreamUpserted({ replicaId: 'R', seq: 1, bacId: 'A', title: 'Workstream A' });
    const foundC = workstreamUpserted({ replicaId: 'R', seq: 2, bacId: 'C', title: 'Workstream C' });
    const foundB = workstreamUpserted({
      replicaId: 'R',
      seq: 3,
      bacId: 'B',
      title: 'Workstream B',
      parentId: 'A',
    });
    await importEvents(eventLog, [foundA, foundC, foundB]);
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'A', title: 'Workstream A', children: ['B'] });
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'C', title: 'Workstream C', children: [] });
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'B', title: 'Workstream B', parentId: 'A' });
    await materializer.catchUp(eventLog);

    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'A', title: 'Workstream A', children: [] });
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'C', title: 'Workstream C', children: ['B'] });
    await writeWorkstreamVaultRecord(vaultRoot, { bac_id: 'B', title: 'Workstream B', parentId: 'C' });
    const reparented = workstreamUpserted({
      replicaId: 'R',
      seq: 4,
      bacId: 'B',
      title: 'Workstream B',
      parentId: 'C',
      deps: { R: 3 },
    });
    await importEvents(eventLog, [reparented]);
    const phase = await capturePhaseLog(() => materializer.catchUp(eventLog));

    expect(phase).toContain('scopedTimelineDelta.demoted');

    // Demotion serves the PRIOR snapshot unchanged — the served graph
    // must still show the OLD A->B edge (the reparent has NOT taken
    // effect), proving no rebuild silently applied it either.
    const served = await store.readCurrent();
    if (served === null) throw new Error('expected the prior snapshot to still be served');
    expect(workstreamParentOfEdges(served)).toEqual([{ from: 'workstream:A', to: 'workstream:B' }]);
  });
});
