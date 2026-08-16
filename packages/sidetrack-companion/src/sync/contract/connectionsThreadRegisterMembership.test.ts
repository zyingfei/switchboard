// F8 W1 acceptance: the thread register store kills the scoped-delta
// "thread-workstream-membership-changed" bail (docs/plans/
// 2026-08-16-f8-ivm-designs.md). Root cause: the scoped drain path
// resolves `thread_in_workstream` from `projectThread(threadId,
// scopedDeltaEvents)` — a drain WINDOW, not the thread's full history.
// A window missing an earlier thread.upserted resolves an incomplete
// (or outright wrong) register regardless of whether real membership
// changed, and `threadDeltaFullBuildReason` conservatively bails —
// which lands as an in-memory full/widened re-derivation of the graph
// (`buildConnectionsSnapshot base`, possibly a `baseRebuild.widenedEvents`
// full-log read) even on drains that still end up WRITING through
// `replaceScopeRows` (a separate, later "publish narrowly" optimization
// — see connectionsMaterializer.ts's `scopeIncrementalEnabled` block).
// So `replaceScopeRows` being called is NOT sufficient proof the cheap
// scoped-delta path ran; the phase-log marks are the reliable signal
// (confirmed empirically below via the disabled-flag control).
//
// These tests prove: with SIDETRACK_THREAD_REGISTER_STORE=1, a scoped
// drain whose window carries a genuine (or window-incomplete-looking)
// membership change produces a thread_in_workstream edge set
// byte-identical to a full rebuild, via the TRUE scoped-delta path
// (`replaceScopeRows scopedTimelineDelta`) — with no
// `buildConnectionsSnapshot base` mark on that drain. A companion
// control proves the flag actually gates this: with it off, the
// identical scenario still bails (and re-derives the base snapshot)
// today.
//
// NOTE on scope: the edge SET is the equivalence target (per the F8
// design doc's exit criterion), not full ConnectionsSnapshot identity.
// A served snapshot in this system never garbage-collects a node once
// created (confirmed by direct inspection: an orphaned `workstream:W1`
// node with zero remaining edges survives even a genuine FULL rebuild
// today, flag on or off) — an orthogonal, pre-existing gap, not
// something W1 introduces or is scoped to fix.

import { mkdtemp, rm } from 'node:fs/promises';
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
import { createEmptyTabSessionProjection } from '../../tabsession/projection.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
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
  'SIDETRACK_THREAD_REGISTER_STORE',
  'SIDETRACK_CONNECTIONS_PHASE_LOG',
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

// Captures every console.warn line emitted DURING fn (the phase-log
// channel this codebase's whole materializer uses — see
// connectionsClassBIntegration.test.ts's identical pattern) without
// silencing it for the rest of the suite.
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

describe('F8 W1 — thread register store kills the membership bail', () => {
  let vaultRoot: string;
  let previousEnv: Record<(typeof envKeys)[number], string | undefined>;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-thread-register-membership-'));
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

  it('scoped drain reassigning a thread to a new workstream matches a full rebuild without a base rebuild', async () => {
    process.env['SIDETRACK_THREAD_REGISTER_STORE'] = '1';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });

    const founding = threadUpserted({ replicaId: 'A', seq: 1, bacId: 'T1', workstreamId: 'W1' });
    await importEvents(eventLog, [founding]);
    await materializer.catchUp(eventLog);

    // Drain 2's window carries ONLY the reassignment — the founding
    // upsert (which set W1) has already scrolled out of the drain
    // window. The OLD gate bails to a full/widened re-derivation on
    // ANY divergence from the previous served snapshot's {W1}; the
    // register store instead supplies the thread's complete history so
    // the scoped path can be trusted.
    const reassigned = threadUpserted({
      replicaId: 'A',
      seq: 2,
      bacId: 'T1',
      workstreamId: 'W2',
      deps: { A: 1 },
    });
    await importEvents(eventLog, [reassigned]);
    const phase = await capturePhaseLog(() => materializer.catchUp(eventLog));

    expect(phase).not.toContain('thread-workstream-membership-changed');
    expect(phase).not.toContain('buildConnectionsSnapshot base');
    expect(phase).toContain('replaceScopeRows scopedTimelineDelta');

    const incremental = await store.readCurrent();
    if (incremental === null) throw new Error('expected scoped incremental snapshot');
    const full = fullSnapshotFor([founding, reassigned]);
    expect(threadInWorkstreamEdges(incremental)).toEqual(threadInWorkstreamEdges(full));
    // Every node a from-scratch full rebuild would emit is present in the
    // scoped result too (a superset check — the served store additionally
    // retains the now-edgeless workstream:W1 node, the orphan-node gap
    // documented at the top of this file, not a W1 regression).
    const incrementalNodeIds = new Set(incremental.nodes.map((node) => node.id));
    for (const node of full.nodes) expect(incrementalNodeIds.has(node.id)).toBe(true);
  });

  it('scoped drain surfacing a real register conflict matches a full rebuild without a base rebuild', async () => {
    process.env['SIDETRACK_THREAD_REGISTER_STORE'] = '1';
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createConnectionsStore(vaultRoot);
    const materializer = createNoisyFreeMaterializer({ vaultRoot, eventLog, store });

    const founding = threadUpserted({ replicaId: 'A', seq: 1, bacId: 'T1', workstreamId: 'W1' });
    await importEvents(eventLog, [founding]);
    await materializer.catchUp(eventLog);

    // A CONCURRENT upsert from replica B: deps={} does not observe A's
    // founding event. Fed ALONE (the window), this resolves trivially
    // to a confident single value W2 — silently WRONG relative to the
    // true state, which is an unresolved conflict {W1, W2}. Only the
    // register store (which has both events) can tell the two apart.
    const concurrent = threadUpserted({ replicaId: 'B', seq: 1, bacId: 'T1', workstreamId: 'W2' });
    await importEvents(eventLog, [concurrent]);
    const phase = await capturePhaseLog(() => materializer.catchUp(eventLog));

    expect(phase).not.toContain('buildConnectionsSnapshot base');
    expect(phase).toContain('replaceScopeRows scopedTimelineDelta');

    const incremental = await store.readCurrent();
    if (incremental === null) throw new Error('expected scoped incremental snapshot');
    const full = fullSnapshotFor([founding, concurrent]);
    const fullEdges = threadInWorkstreamEdges(full);
    // Sanity: this scenario really is a conflict (both W1 and W2 survive
    // in the full rebuild) — otherwise the test wouldn't be exercising
    // the window-incompleteness bug at all.
    expect(fullEdges).toHaveLength(2);
    expect(threadInWorkstreamEdges(incremental)).toEqual(fullEdges);
  });

  it('control: with the store disabled, the same reassignment now DEMOTES instead of bailing to a base rebuild (F8 W3)', async () => {
    // No SIDETRACK_THREAD_REGISTER_STORE=1 — proves the flag (not some
    // unrelated fast path) is what changes drain behavior above.
    //
    // F8 W3 supersedes the interim hot-rebuild suppressor this test used
    // to exercise: a bail no longer ever falls into
    // `buildConnectionsSnapshot base` on an operational drain (see
    // docs/plans/2026-08-16-f8-ivm-designs.md, "W3"). It demotes —
    // progress-only write, serve the PRIOR snapshot unchanged, enqueue the
    // dirty thread scope into the persisted repair queue. With the
    // register store disabled, the SAME structural gate that caused the
    // bail fires again on any repair-drain attempt (no durable per-thread
    // history to correct it from), so this scope is a genuine "cannot
    // heal via scoped recompute" case — it recycles rather than silently
    // resolving or silently serving the wrong membership. See
    // connectionsRepairDemotion.test.ts for the general demotion +
    // repair-drain-heals-when-it-can equivalence tests.
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

    expect(phase).toContain('thread-workstream-membership-changed');
    expect(phase).toContain('scopedTimelineDelta.demoted reason=thread-workstream-membership-changed');
    // `buildConnectionsSnapshot base` is an unconditional per-drain
    // diagnostic (it reports whatever `baseSnapshot` ends up being, not
    // "a rebuild happened") — NOT a reliable rebuild signal on its own,
    // so the real proof is the served snapshot's CONTENT below: if a full
    // rebuild had actually run, it would reflect the reassignment (W2).
    // It does not — demotion served the PRIOR snapshot unchanged.
    const served = await store.readCurrent();
    if (served === null) throw new Error('expected the prior snapshot to still be served');
    expect(threadInWorkstreamEdges(served)).toEqual(threadInWorkstreamEdges(fullSnapshotFor([founding])));
  });
});
