import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from './causal.js';
import { createEventLog } from './eventLog.js';
import { loadOrCreateReplica } from './replicaId.js';
import {
  eventStoreCoverageToken,
  getCaughtUpSharedEventStore,
  getSharedEventStoreServeStale,
  setEventStoreCatchUpGateForTest,
  startCoalescedEventStoreCatchUp,
} from './eventStore.js';

// REPORTED LIVE 2026-07-31 ("Companion is busy — retrying"): during the
// post-boot catch-up window every heavy read awaited the in-flight JSONL
// pass — batch-resolve 56-71s, inbox 55s, privacy/projection 52s FOR A
// 304 — while /v1/version answered in 0-3ms. The event loop was idle; the
// reads were PARKED on getCaughtUpSharedEventStore. Serve-stale is the
// structural fix: a route reads the store AS-IS and the catch-up runs
// behind it. These tests pin the three properties that make that safe:
// the read never waits, all passes coalesce into one, and memo keys tell
// the truth about what a stale read actually saw.

const TEST_TYPE = 'serve.stale.test.event';

const buildEvent = (seq: number): AcceptedEvent => ({
  clientEventId: `evt-${String(seq)}`,
  dot: { replicaId: 'replica-T', seq },
  deps: {},
  aggregateId: 'agg',
  type: TEST_TYPE,
  payload: { payloadVersion: 1, marker: seq },
  acceptedAtMs: Date.parse('2026-07-31T10:00:00.000Z') + seq * 1000,
});

describe('serve-stale event store reads', () => {
  let vaultRoot: string;
  let previousFlag: string | undefined;

  beforeEach(async () => {
    previousFlag = process.env['SIDETRACK_EVENT_STORE'];
    process.env['SIDETRACK_EVENT_STORE'] = '1';
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-serve-stale-'));
  });

  afterEach(async () => {
    setEventStoreCatchUpGateForTest(null);
    if (previousFlag === undefined) delete process.env['SIDETRACK_EVENT_STORE'];
    else process.env['SIDETRACK_EVENT_STORE'] = previousFlag;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('returns the store immediately while a catch-up pass is parked in flight', async () => {
    let releaseGate: (() => void) | null = null;
    const gateHeld = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    setEventStoreCatchUpGateForTest(() => gateHeld);

    // First call opens the store and KICKS the pass, which parks at the
    // gate — exactly the live shape (a long pass in flight). The call
    // itself must come back without waiting for the pass.
    const before = Date.now();
    const store = await getSharedEventStoreServeStale(vaultRoot);
    const firstMs = Date.now() - before;
    expect(store).not.toBeNull();
    expect(firstMs).toBeLessThan(500);

    // A second reader arriving MID-pass must also not wait — this is the
    // request that used to park for 30-70s.
    const again = Date.now();
    const storeAgain = await getSharedEventStoreServeStale(vaultRoot);
    expect(storeAgain).toBe(store);
    expect(Date.now() - again).toBeLessThan(200);

    releaseGate?.();
    // Drain the coalesced pass so afterEach can rm the vault safely.
    await startCoalescedEventStoreCatchUp(vaultRoot, store!);
  });

  it('coalesces reader kicks and materializer-style passes into ONE pass', async () => {
    let gateCount = 0;
    let releaseGate: (() => void) | null = null;
    const gateHeld = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    setEventStoreCatchUpGateForTest(() => {
      gateCount += 1;
      return gateHeld;
    });

    const store = await getSharedEventStoreServeStale(vaultRoot);
    expect(store).not.toBeNull();
    // Two more reader kicks plus a direct materializer-style call, all
    // while the first pass is parked at the gate.
    await getSharedEventStoreServeStale(vaultRoot);
    await getSharedEventStoreServeStale(vaultRoot);
    const drainStyle = startCoalescedEventStoreCatchUp(vaultRoot, store!);

    releaseGate?.();
    await drainStyle;
    // Exactly one pass ran for all four entry points. Before this
    // existed, the materializer's direct catchUpFromJsonl bypassed the
    // single-flight map and an HTTP reader started a SECOND overlapping
    // pass on the same store.
    expect(gateCount).toBe(1);

    // After the pass completes, a NEW pass may start (now-cheap,
    // only-new-bytes) — the guard must not stick.
    setEventStoreCatchUpGateForTest(null);
    await getCaughtUpSharedEventStore(vaultRoot);
  });

  it('coverage token stands still on a stale read and moves only when catch-up lands', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (let seq = 1; seq <= 3; seq += 1) {
      await eventLog.importPeerEvent(buildEvent(seq));
    }

    // Fully caught up: the store has seen seqs 1-3.
    const store = await getCaughtUpSharedEventStore(vaultRoot);
    expect(store).not.toBeNull();
    const tokenCaughtUp = eventStoreCoverageToken(store!);
    expect(store!.count()).toBe(3);

    // Append seq 4 to the LOG only, and park any kicked pass at the gate
    // so the store cannot ingest it yet. This is the historical poison
    // shape: the log signature has moved, the store has not.
    let releaseGate: (() => void) | null = null;
    const gateHeld = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    setEventStoreCatchUpGateForTest(() => gateHeld);
    await eventLog.importPeerEvent(buildEvent(4));

    const staleStore = await getSharedEventStoreServeStale(vaultRoot);
    expect(staleStore).toBe(store);
    // The stale read still sees 3 events, and its token SAYS SO — it
    // equals the caught-up-at-3 token, not anything derived from the
    // freshly-appended log. A fold memoized under this token re-serves
    // legitimately (same data), and CANNOT mask seq 4 once ingested.
    expect(staleStore!.count()).toBe(3);
    expect(eventStoreCoverageToken(staleStore!)).toBe(tokenCaughtUp);

    // Catch-up lands → the token moves → any memo keyed on it misses and
    // refolds, seeing seq 4. (Keying on logSignature() instead would have
    // cached the 3-event fold under the 4-event signature and kept
    // serving it after this point — the bug this token exists to kill.)
    releaseGate?.();
    await startCoalescedEventStoreCatchUp(vaultRoot, staleStore!);
    setEventStoreCatchUpGateForTest(null);
    const caughtUp = await getCaughtUpSharedEventStore(vaultRoot);
    expect(caughtUp!.count()).toBe(4);
    expect(eventStoreCoverageToken(caughtUp!)).not.toBe(tokenCaughtUp);
  });
});
