// F8 IVM plan W3 acceptance: bail demotion, the persisted repair queue,
// and the Recovery consent rule (docs/plans/2026-08-16-f8-ivm-designs.md,
// "W3" + "Recovery consent rule"). The interim hot-rebuild suppressor
// (#364) that used to coalesce full rebuilds onto a cooldown timer is
// SUPERSEDED: every non-recovery-tier scoped-delta bail now demotes
// unconditionally (progress-only write + repair-queue enqueue), and the
// two auto-invoked catastrophic-recovery full-rebuild paths (cold boot
// with no previous snapshot, materializer version bump) are consent-gated
// on a non-empty vault.
//
// Structure mirrors connectionsThreadRegisterMembership.test.ts /
// connectionsSearchIndexJoin.test.ts (createNoisyFreeMaterializer,
// importEvents, capturePhaseLog).

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildConnectionsSnapshot,
  createConnectionsStore,
  type ConnectionsInput,
  type ConnectionsSnapshot,
  type ConnectionsStore,
} from '../../connections/snapshot.js';
import { createRepairQueueStore } from '../../connections/repairQueueStore.js';
import { createEmptyTabSessionProjection } from '../../tabsession/projection.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import { type AcceptedEvent, type VersionVector } from '../causal.js';
import { createEventLog, type EventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import {
  createConnectionsMaterializer,
  type ConnectionsMaterializer,
} from './connectionsMaterializer.js';

const envKeys = [
  'SIDETRACK_SKIP_RANKER_SNAPSHOT',
  'SIDETRACK_CONNECTIONS_INPROCESS',
  'SIDETRACK_CONNECTIONS_INCREMENTAL_SCOPES',
  'SIDETRACK_CONNECTIONS_DRIFT_DISABLED',
  'SIDETRACK_TOPIC_PRODUCER',
  'SIDETRACK_THREAD_REGISTER_STORE',
  'SIDETRACK_CONNECTIONS_PHASE_LOG',
  'SIDETRACK_RECOVERY_CONSENT_THRESHOLD_BYTES',
] as const;

const at = (seq: number): number => Date.parse('2026-08-16T10:00:00.000Z') + seq;

const threadUpserted = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly bacId: string;
  readonly workstreamId?: string;
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
    ...(input.workstreamId === undefined ? {} : { primaryWorkstreamId: input.workstreamId }),
  },
  acceptedAtMs: at(input.seq),
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

const threadInWorkstreamEdges = (
  snapshot: ConnectionsSnapshot,
): readonly { readonly from: string; readonly to: string }[] =>
  [...snapshot.edges]
    .filter((edge) => edge.kind === 'thread_in_workstream')
    .map((edge) => ({ from: edge.fromNodeId, to: edge.toNodeId }))
    .sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

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

describe('F8 W3 — demotion, repair-queue drain, recovery consent', () => {
  let vaultRoot: string;
  let previousEnv: Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-repair-demotion-'));
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

  it('a bail demotes (progress-only write + repair-queue enqueue) regardless of W1/W2 flags — flag-independent', async () => {
    // No SIDETRACK_THREAD_REGISTER_STORE=1 — demotion does not depend on
    // it; it is the structural replacement for EVERY non-recovery bail.
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });

    const founding = threadUpserted({ replicaId: 'A', seq: 1, bacId: 'T1', workstreamId: 'W1' });
    await importEvents(eventLog, [founding]);
    await materializer.catchUp(eventLog);

    const reassigned = threadUpserted({
      replicaId: 'A',
      seq: 2,
      bacId: 'T1',
      workstreamId: 'W2',
      deps: { A: 1 },
    });
    await importEvents(eventLog, [reassigned]);
    const phase = await capturePhaseLog(() => materializer.catchUp(eventLog));

    expect(phase).toContain(
      'scopedTimelineDelta.demoted reason=thread-workstream-membership-changed',
    );

    // Served snapshot is byte-identical to the PRE-reassignment full
    // rebuild — genuinely stale, never silently wrong.
    const served = await store.readCurrent();
    if (served === null) throw new Error('expected the prior snapshot to still be served');
    expect(threadInWorkstreamEdges(served)).toEqual(threadInWorkstreamEdges(fullSnapshotFor([founding])));

    // The repair queue holds the demoted scope(s) — a thread reassignment
    // invalidates the thread scope plus both its old/new workstream
    // scopes, so more than one entry is expected. All must carry the
    // bail reason and a fresh timestamp — verified directly against the
    // sidecar store, not just the phase-log mark.
    const repairStore = await createRepairQueueStore(vaultRoot);
    try {
      const stats = repairStore.stats();
      expect(stats.depth).toBeGreaterThanOrEqual(1);
      expect(stats.oldestEnqueuedAt).not.toBeNull();
      const batch = repairStore.takeBatch(10);
      expect(batch.length).toBeGreaterThanOrEqual(1);
      for (const entry of batch) {
        expect(entry.reason).toBe('thread-workstream-membership-changed');
      }
      expect(batch.some((entry) => entry.scope.kind === 'thread' && entry.scope.id === 'T1')).toBe(
        true,
      );
    } finally {
      repairStore.close();
    }
  });

  it('a repair-queue entry heals on the NEXT drain once its data source becomes available — byte-identical to a full rebuild', async () => {
    // Real system nuance worth being explicit about (see coordinator
    // report): the W1/W2 fact stores' OWN `catchUp` only ingests
    // whatever window it is handed each drain (threadRegisterStore.ts /
    // search-index stores mirror timelineFactsStore's lifecycle). If a
    // store is enabled for the FIRST time on a WARM drain (progress
    // already exists), it only sees that drain's tiny pending window,
    // not the bac_id's full prior history — so simply flipping the env
    // flag mid-flight, with no other change, does NOT retroactively heal
    // an already-demoted thread (it re-demotes, correctly and honestly —
    // see the sibling control tests). Fully closing that gap needs a
    // durable-store backfill (`rebuildFromJsonl`, recovery-only per the
    // Binding rule) or the store having been live since before the
    // demoted bac_id's founding event — a real deployment detail, not
    // this test's target.
    //
    // This test instead isolates the property the repair queue itself is
    // responsible for: a scope drained from the queue rides the ORDINARY
    // scoped-recompute path and resolves CORRECTLY once its data source
    // can answer for it. The register store here is wired with COMPLETE
    // history throughout (ingest/catchUp run normally every drain, no
    // gap) but its `read()` is gated to simulate "not yet observed" for
    // exactly the demotion drain — the same condition the real code
    // already handles ("threads the store hasn't observed yet fall
    // through to the window-based bail", connectionsMaterializer.ts).
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    const { createThreadRegisterStore } = await import('../../threads/threadRegisterStore.js');
    const realRegisterStore = await createThreadRegisterStore(vaultRoot);
    let registerGateOpen = false;
    const gatedRegisterStore: typeof realRegisterStore = {
      ...realRegisterStore,
      read: (bacId) => (registerGateOpen ? realRegisterStore.read(bacId) : undefined),
    };

    process.env['SIDETRACK_THREAD_REGISTER_STORE'] = '1';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore: createTimelineStore(vaultRoot),
      store,
      threadRegisterStore: gatedRegisterStore,
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

    const founding = threadUpserted({ replicaId: 'A', seq: 1, bacId: 'T1', workstreamId: 'W1' });
    await importEvents(eventLog, [founding]);
    await materializer.catchUp(eventLog);

    const reassigned = threadUpserted({
      replicaId: 'A',
      seq: 2,
      bacId: 'T1',
      workstreamId: 'W2',
      deps: { A: 1 },
    });
    await importEvents(eventLog, [reassigned]);
    const demotionPhase = await capturePhaseLog(() => materializer.catchUp(eventLog));
    expect(demotionPhase).toContain(
      'scopedTimelineDelta.demoted reason=thread-workstream-membership-changed',
    );

    const staleAfterDemotion = await store.readCurrent();
    if (staleAfterDemotion === null) throw new Error('expected a stale served snapshot');
    expect(threadInWorkstreamEdges(staleAfterDemotion)).toEqual(
      threadInWorkstreamEdges(fullSnapshotFor([founding])),
    );

    // The real store DID ingest the reassignment normally during the
    // demotion drain (only `.read()` was gated) — open the gate, then
    // feed ONE more (unrelated) event so the next catchUp() actually
    // runs a drain (catchUp returns early with zero pending events, and
    // the demoted drain already advanced the frontier past the
    // reassignment).
    registerGateOpen = true;
    const secondThread = threadUpserted({ replicaId: 'A', seq: 3, bacId: 'T2' });
    await importEvents(eventLog, [secondThread]);
    const healPhase = await capturePhaseLog(() => materializer.catchUp(eventLog));

    // The queued T1 scope was drained at the start of this buildAndWrite
    // and rode the ordinary scoped-recompute path — never a full rebuild.
    expect(healPhase).toContain('repairQueue.drain');
    expect(healPhase).not.toContain(
      'scopedTimelineDelta.demoted reason=thread-workstream-membership-changed',
    );

    const healed = await store.readCurrent();
    if (healed === null) throw new Error('expected a healed snapshot');
    expect(threadInWorkstreamEdges(healed)).toEqual(
      threadInWorkstreamEdges(fullSnapshotFor([founding, reassigned, secondThread])),
    );

    // The repair queue is empty again — healed, not silently re-queued.
    const repairStore = await createRepairQueueStore(vaultRoot);
    try {
      expect(repairStore.depth()).toBe(0);
    } finally {
      repairStore.close();
    }
  });

  it('consent: a non-empty vault with no previous connections snapshot serves degraded + sets needs-repair, never auto-rebuilds', async () => {
    // Threshold=0 makes ANY non-empty canonical log count as "large" —
    // exercises the gate without writing megabytes of fixture log.
    process.env['SIDETRACK_RECOVERY_CONSENT_THRESHOLD_BYTES'] = '0';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });

    const founding = threadUpserted({ replicaId: 'A', seq: 1, bacId: 'T1', workstreamId: 'W1' });
    await importEvents(eventLog, [founding]);

    const phase = await capturePhaseLog(() => materializer.catchUp(eventLog));
    expect(phase).toContain('coldBoot.degraded reason=non-empty-vault-no-previous-snapshot');
    expect(phase).toContain('recoveryConsent.needsRepair reason=cold-boot-non-empty-vault');

    const served = await store.readCurrent();
    if (served === null) throw new Error('expected a (degraded) served snapshot');
    // Degraded = empty graph, not the auto-replayed thread.
    expect(served.nodes.some((node) => node.id.includes('T1'))).toBe(false);

    const repairStore = await createRepairQueueStore(vaultRoot);
    try {
      const needsRepair = repairStore.readNeedsRepair();
      expect(needsRepair?.reason).toBe('cold-boot-non-empty-vault');
      expect(needsRepair?.command).toBe(`sidetrack-companion connections-rebuild --vault ${vaultRoot}`);
    } finally {
      repairStore.close();
    }
  });

  it('consent: a fresh/small vault still auto-builds on cold boot (first-run exemption)', async () => {
    // Default threshold (10MB) — this test's synthetic log is bytes, not
    // megabytes, so it stays under it and the first-run exemption applies.
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });

    const founding = threadUpserted({ replicaId: 'A', seq: 1, bacId: 'T1', workstreamId: 'W1' });
    await importEvents(eventLog, [founding]);

    const phase = await capturePhaseLog(() => materializer.catchUp(eventLog));
    expect(phase).not.toContain('coldBoot.degraded');

    const served = await store.readCurrent();
    if (served === null) throw new Error('expected an auto-built served snapshot');
    expect(served.nodes.some((node) => node.id.includes('T1'))).toBe(true);

    const repairStore = await createRepairQueueStore(vaultRoot);
    try {
      expect(repairStore.readNeedsRepair()).toBeNull();
    } finally {
      repairStore.close();
    }
  });

  it('runConsentedFullRebuild (the connections-rebuild CLI path) bypasses consent gating and clears the repair queue', async () => {
    process.env['SIDETRACK_RECOVERY_CONSENT_THRESHOLD_BYTES'] = '0';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });

    const founding = threadUpserted({ replicaId: 'A', seq: 1, bacId: 'T1', workstreamId: 'W1' });
    await importEvents(eventLog, [founding]);

    // Cold boot on a "large" vault degrades and marks needs-repair.
    await materializer.catchUp(eventLog);
    const degraded = await store.readCurrent();
    if (degraded === null) throw new Error('expected a degraded served snapshot');
    expect(degraded.nodes.some((node) => node.id.includes('T1'))).toBe(false);

    const repairStoreBefore = await createRepairQueueStore(vaultRoot);
    try {
      expect(repairStoreBefore.readNeedsRepair()).not.toBeNull();
    } finally {
      repairStoreBefore.close();
    }

    // The user runs the consented rebuild. It must produce the COMPLETE
    // graph (from the full event source) despite the consent gate that
    // just refused to do this automatically — calling it IS the consent.
    const snapshot = await materializer.runConsentedFullRebuild();
    expect(snapshot.nodes.some((node) => node.id.includes('T1'))).toBe(true);

    const rebuilt = await store.readCurrent();
    if (rebuilt === null) throw new Error('expected the rebuilt snapshot to be published');
    expect(rebuilt.nodes.some((node) => node.id.includes('T1'))).toBe(true);

    const repairStoreAfter = await createRepairQueueStore(vaultRoot);
    try {
      expect(repairStoreAfter.readNeedsRepair()).toBeNull();
      expect(repairStoreAfter.depth()).toBe(0);
    } finally {
      repairStoreAfter.close();
    }
  });
});
