import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RecallActivityTracker } from '../../recall/activity.js';
import type { RecallLifecycle } from '../../recall/lifecycle.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createRecallMaterializer } from './recallMaterializer.js';
import { createSyncContractRunner } from './runner.js';

// Lane 1 gate tests at the unit / contract layer.
//
//   L1-G6 — Burst no-deadlock + bounded scheduling.
//   L1-G7 — Stale outbox `baseVector: {}` accepted as concurrent;
//           does NOT dominate peer events.
//   L1-G9 — Materializer failure surfaces via runner.health().
//
// These complement the higher-level e2e gates in the extension
// package (cross-replica-recall.spec.ts) that exercise full chains
// across two browsers + relay.

const stubRecallLifecycle = (opts: {
  readonly delayMs?: number;
  readonly throwOnce?: boolean;
}): {
  lifecycle: RecallLifecycle;
  activity: RecallActivityTracker;
  callCount: () => number;
  inflightPeak: () => number;
} => {
  let calls = 0;
  let inflight = 0;
  let peak = 0;
  let threwOnce = false;
  const lifecycle = {
    isFresh: () => true,
    report: () => ({}) as never,
    ensureFresh: async () => undefined,
    waitForRebuild: async () => undefined,
    scheduleRebuild: async () => undefined,
    isRebuilding: () => false,
    appendEntry: async () => ({ entryCount: 0 }) as never,
    tombstoneByThread: async () => ({ tombstoned: 0 }),
    ingestIncremental: async () => {
      calls += 1;
      inflight += 1;
      peak = Math.max(peak, inflight);
      try {
        if (opts.throwOnce === true && !threwOnce) {
          threwOnce = true;
          throw new Error('synthetic-failure');
        }
        if (opts.delayMs !== undefined) {
          await new Promise((r) => setTimeout(r, opts.delayMs));
        }
        return { indexedChunks: 0, tombstonedChunks: 0, tombstonedEntries: 0 } as never;
      } finally {
        inflight -= 1;
      }
    },
  } as unknown as RecallLifecycle;
  const activity: RecallActivityTracker = {
    recordIngestStarted: () => undefined,
    recordIngestCompleted: () => undefined,
    recordIngestFailed: () => undefined,
    summary: () => ({}) as never,
  } as unknown as RecallActivityTracker;
  return {
    lifecycle,
    activity,
    callCount: () => calls,
    inflightPeak: () => peak,
  };
};

const captureEvent = (n: number): AcceptedEvent => ({
  clientEventId: `cap-${n}`,
  dot: { replicaId: 'peer', seq: n },
  deps: {},
  aggregateId: `thread-${n}`,
  type: 'capture.recorded',
  payload: { bac_id: `thread-${n}`, capturedAt: '2026-05-07T00:00:00.000Z', turns: [] },
  acceptedAtMs: n,
});

describe('Lane 1 contract — burst resilience + stale outbox + materializer health', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-l1-burst-'));
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('L1-G6 — burst of 50 capture events produces at most one in-flight ingest worker', async () => {
    const { lifecycle, activity, callCount, inflightPeak } = stubRecallLifecycle({
      delayMs: 15,
    });
    const runner = createSyncContractRunner();
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const m = createRecallMaterializer({
      recallLifecycle: lifecycle,
      recallActivity: activity,
      eventLog,
    });
    runner.register(m);

    // The dirty-bit scheduler kicks off one worker; subsequent
    // onAccepted calls during the in-flight drain re-set dirty
    // without spawning additional workers (gate L1-G6). eventLog
    // is bound at materializer construction.
    for (let i = 0; i < 50; i += 1) {
      runner.onAcceptedEvent(captureEvent(i + 1), { origin: 'peer' });
    }
    await runner.awaitIdle();

    // Exactly one in-flight worker at any time during the burst.
    expect(inflightPeak()).toBe(1);
    // Total invocations must be small (initial catchUp + at most a
    // few coalesced re-runs); never 50.
    expect(callCount()).toBeLessThanOrEqual(5);
  });

  it('L1-G9 — materializer failure surfaces via runner.health()', async () => {
    const { lifecycle, activity } = stubRecallLifecycle({ throwOnce: true });
    const runner = createSyncContractRunner();
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const m = createRecallMaterializer({
      recallLifecycle: lifecycle,
      recallActivity: activity,
      eventLog,
    });
    runner.register(m);
    runner.onAcceptedEvent(captureEvent(1), { origin: 'peer' });
    await runner.awaitIdle();

    const health = runner.health();
    expect(health['recall']?.status).toBe('failed');
    expect(health['recall']?.lastError).toContain('synthetic-failure');
  });

  it('L1-G7 — stale browser outbox with baseVector:{} arriving after peer events is accepted as concurrent (does NOT dominate)', async () => {
    // Test the eventLog contract directly: a peer event lands first,
    // then a stale browser-observed event with baseVector:{}.
    // Causal CRDT semantics: the new event has deps:{}, the prior
    // event has dot {peer-A: 1}. The new event does NOT include the
    // peer dot in its deps, so eventDominates(new, peer) is false —
    // they are concurrent. The projection treats them as a register
    // conflict (mergeRegister candidates), not a winner.
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const peerEvent: AcceptedEvent = {
      clientEventId: 'peer-1',
      dot: { replicaId: 'peer-A', seq: 1 },
      deps: {},
      aggregateId: 'th-1',
      type: 'thread.upserted',
      payload: {
        bac_id: 'th-1',
        provider: 'chatgpt',
        threadUrl: 'https://x',
        title: 'peer wrote this',
        lastSeenAt: '2026-05-07T00:00:00.000Z',
      },
      acceptedAtMs: 1,
    };
    await eventLog.importPeerEvent(peerEvent);

    // Browser submits a stale event with baseVector:{} — i.e. the
    // editor authored this BEFORE seeing the peer event. Companion
    // accepts as legal (empty observation). Crucially, the deps
    // stamped on the local accept must equal `{}` — NOT a frontier
    // that secretly includes peer-A:1.
    const localEvent = await eventLog.appendClientObserved({
      clientEventId: 'local-1',
      aggregateId: 'th-1',
      type: 'thread.upserted',
      payload: {
        bac_id: 'th-1',
        provider: 'chatgpt',
        threadUrl: 'https://x',
        title: 'browser wrote this earlier',
        lastSeenAt: '2026-05-07T00:00:00.000Z',
      },
      baseVector: {},
    });
    expect(localEvent.deps).toEqual({});

    // Concurrency check: neither event causally dominates the
    // other. Both must be candidates in any projection that uses
    // them.
    const all = await eventLog.readByAggregate('th-1');
    expect(all).toHaveLength(2);
    const peerInLog = all.find((e) => e.dot.replicaId === 'peer-A');
    const localInLog = all.find((e) => e.dot.replicaId !== 'peer-A');
    expect(peerInLog).toBeDefined();
    expect(localInLog).toBeDefined();
    // Local does not observe peer.
    expect(localInLog!.deps[peerInLog!.dot.replicaId]).toBeUndefined();
    // Peer does not observe local.
    expect(peerInLog!.deps[localInLog!.dot.replicaId]).toBeUndefined();
  });
});
