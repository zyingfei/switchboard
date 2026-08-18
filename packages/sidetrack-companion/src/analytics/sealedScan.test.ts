import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { getCaughtUpSharedEventStore, type EventStore } from '../sync/eventStore.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { runEventSealPass, sealSegmentPath } from './eventSeal.js';
import {
  columnarScansEnabled,
  forEachChunkOfTypesSealAware,
  resetColumnarScanMarkThrottleForTest,
  resetSealedScanClassificationCacheForTest,
} from './sealedScan.js';

const REPLICA = 'peer-sealed-scan';
const DAY_A = '2026-04-01';
const DAY_B = '2026-04-02';
// NOW is pinned strictly after DAY_A/DAY_B so both are sealable ("today" is
// never sealed) while DAY_C stays open/hot for every test.
const DAY_C = '2026-04-04';
const NOW = new Date('2026-04-04T12:00:00.000Z');

const TYPE_A = 'thread.upserted';
const TYPE_B = 'thread.archived';

let seq = 0;
const nextSeq = (): number => {
  seq += 1;
  return seq;
};

// Deliberately NON-empty deps/target/hlc — proves the sealed-aware router
// actually normalizes these away rather than the test trivially passing
// because the fixture never set them (eventSeal.test.ts's own peerEvent
// helper uses deps: {}, which would not exercise this).
const peerEvent = (input: {
  readonly day: string;
  readonly type: string;
  readonly seqOverride?: number;
}): AcceptedEvent => {
  const s = input.seqOverride ?? nextSeq();
  return {
    clientEventId: `${REPLICA}.${String(s)}`,
    dot: { replicaId: REPLICA, seq: s },
    deps: { [REPLICA]: Math.max(0, s - 1), 'some-other-replica': 3 },
    aggregateId: `T${String(s)}`,
    type: input.type,
    payload: { bac_id: `T${String(s)}`, title: `Thread ${String(s)}` },
    acceptedAtMs: Date.parse(`${input.day}T10:00:00.000Z`) + s,
    target: { provider: 'test', canonicalUrl: `https://example.test/${String(s)}` },
    hlc: { physicalMs: Date.parse(`${input.day}T10:00:00.000Z`) + s, counter: s, replicaId: REPLICA, confidence: 'trusted' },
  };
};

describe('sealed/hot watermark-split scan router', () => {
  let vaultRoot = '';
  let previousStoreFlag: string | undefined;
  let previousSealFlag: string | undefined;
  let previousColumnarFlag: string | undefined;
  let store: EventStore | null = null;

  beforeEach(async () => {
    seq = 0;
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-sealed-scan-'));
    previousStoreFlag = process.env['SIDETRACK_EVENT_STORE'];
    previousSealFlag = process.env['SIDETRACK_EVENT_SEAL'];
    previousColumnarFlag = process.env['SIDETRACK_COLUMNAR_SCANS'];
    process.env['SIDETRACK_EVENT_STORE'] = '1';
    process.env['SIDETRACK_EVENT_SEAL'] = '1';
    // Default-off (2026-08-18, measured real-vault regression — see
    // columnarScansEnabled's own comment) — every test that wants routing
    // engaged must opt in explicitly with '1'; this default matches what a
    // caller gets with the env var unset.
    process.env['SIDETRACK_COLUMNAR_SCANS'] = '1';
    resetColumnarScanMarkThrottleForTest();
    resetSealedScanClassificationCacheForTest();
  });

  afterEach(async () => {
    if (previousStoreFlag === undefined) delete process.env['SIDETRACK_EVENT_STORE'];
    else process.env['SIDETRACK_EVENT_STORE'] = previousStoreFlag;
    if (previousSealFlag === undefined) delete process.env['SIDETRACK_EVENT_SEAL'];
    else process.env['SIDETRACK_EVENT_SEAL'] = previousSealFlag;
    if (previousColumnarFlag === undefined) delete process.env['SIDETRACK_COLUMNAR_SCANS'];
    else process.env['SIDETRACK_COLUMNAR_SCANS'] = previousColumnarFlag;
    store?.close();
    store = null;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  // Seeds two closed days (sealed) plus one open day (hot), each with a mix
  // of TYPE_A and TYPE_B events on the SAME replica, spanning both the
  // sealed-Parquet and store-live-read code paths within one call.
  const seedAndSeal = async (): Promise<void> => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (const day of [DAY_A, DAY_B]) {
      await eventLog.importPeerEvent(peerEvent({ day, type: TYPE_A }));
      await eventLog.importPeerEvent(peerEvent({ day, type: TYPE_B }));
    }
    // Hot/open day — never sealed (NOW is DAY_C itself).
    await eventLog.importPeerEvent(peerEvent({ day: DAY_C, type: TYPE_A }));
    await eventLog.importPeerEvent(peerEvent({ day: DAY_C, type: TYPE_B }));

    const pass = await runEventSealPass(vaultRoot, { now: () => NOW });
    expect(pass.errors).toEqual([]);
    expect(pass.sealed.map((entry) => entry.day).sort()).toEqual([DAY_A, DAY_B]);

    store = await getCaughtUpSharedEventStore(vaultRoot);
    expect(store).not.toBeNull();
  };

  const collectViaRouter = async (
    types: readonly string[],
    consumer = 'test-consumer',
  ): Promise<{ readonly events: AcceptedEvent[]; readonly stats: Awaited<ReturnType<typeof forEachChunkOfTypesSealAware>> }> => {
    const events: AcceptedEvent[] = [];
    const stats = await forEachChunkOfTypesSealAware(
      vaultRoot,
      store as EventStore,
      types,
      (chunk) => {
        events.push(...chunk);
      },
      2,
      { consumer },
    );
    return { events, stats };
  };

  const collectViaStore = async (types: readonly string[]): Promise<AcceptedEvent[]> => {
    const events: AcceptedEvent[] = [];
    await (store as EventStore).forEachChunkOfTypes(
      types,
      (chunk) => {
        events.push(...chunk);
      },
      2,
    );
    return events;
  };

  const sortByDot = (events: readonly AcceptedEvent[]): AcceptedEvent[] =>
    [...events].sort((a, b) =>
      a.dot.replicaId === b.dot.replicaId ? a.dot.seq - b.dot.seq : a.dot.replicaId < b.dot.replicaId ? -1 : 1,
    );

  // Fields every proven-safe consumer (readEventsFromStoreOrLog,
  // workGraphHealth's readEventsForHealth) actually reads. deps/target/hlc
  // are excluded deliberately — see the module header and the dedicated
  // "normalizes deps/target/hlc" test below.
  const safeFields = (event: AcceptedEvent) => ({
    dot: event.dot,
    aggregateId: event.aggregateId,
    type: event.type,
    payload: event.payload,
    acceptedAtMs: event.acceptedAtMs,
    clientEventId: event.clientEventId,
  });

  it('sealed+hot union deep-equals the pure-store read on every safe field', async () => {
    await seedAndSeal();
    const { events, stats } = await collectViaRouter([TYPE_A, TYPE_B]);
    const viaStore = await collectViaStore([TYPE_A, TYPE_B]);

    expect(sortByDot(events).map(safeFields)).toEqual(sortByDot(viaStore).map(safeFields));
    expect(stats.sealedDays).toBe(2);
    expect(stats.hotDays).toBe(1);
    expect(stats.bytesEstimate).toBeGreaterThan(0);
  });

  it('type filter is honored across both the sealed and hot portions', async () => {
    await seedAndSeal();
    const { events } = await collectViaRouter([TYPE_A]);
    expect(events.every((event) => event.type === TYPE_A)).toBe(true);
    // 2 sealed days + 1 hot day, one TYPE_A event each.
    expect(events).toHaveLength(3);
  });

  it('sealed-day events lose deps/target/hlc; hot-tail events keep full fidelity', async () => {
    await seedAndSeal();
    const { events } = await collectViaRouter([TYPE_A, TYPE_B]);
    expect(events.length).toBeGreaterThan(0);
    const bySeq = new Map(events.map((event) => [event.dot.seq, event]));
    // seq 1-4 are DAY_A/DAY_B (sealed, per seedAndSeal's import order).
    for (const seqValue of [1, 2, 3, 4]) {
      const sealedEvent = bySeq.get(seqValue);
      expect(sealedEvent?.deps).toEqual({});
      expect(sealedEvent?.target).toBeUndefined();
      expect(sealedEvent?.hlc).toBeUndefined();
    }
    // seq 5-6 are DAY_C (hot/unsealed) — must be exactly as ingested, not
    // gratuitously degraded just because the sealed portion has to be.
    for (const seqValue of [5, 6]) {
      const hotEvent = bySeq.get(seqValue);
      expect(hotEvent?.deps).toEqual({ [REPLICA]: seqValue - 1, 'some-other-replica': 3 });
      expect(hotEvent?.target).toEqual({ provider: 'test', canonicalUrl: `https://example.test/${String(seqValue)}` });
      expect(hotEvent?.hlc).toBeDefined();
    }
  });

  it('kill switch (SIDETRACK_COLUMNAR_SCANS=0) reverts to a byte-identical passthrough', async () => {
    await seedAndSeal();
    process.env['SIDETRACK_COLUMNAR_SCANS'] = '0';
    expect(columnarScansEnabled()).toBe(false);
    const { events, stats } = await collectViaRouter([TYPE_A, TYPE_B]);
    const viaStore = await collectViaStore([TYPE_A, TYPE_B]);
    expect(sortByDot(events)).toEqual(sortByDot(viaStore));
    expect(stats).toEqual({ consumer: 'test-consumer', sealedDays: 0, hotDays: 0, bytesEstimate: 0 });
  });

  it('default (env unset) is OFF — opt-in required, matching eventSealEnabled\'s own idiom', async () => {
    await seedAndSeal();
    delete process.env['SIDETRACK_COLUMNAR_SCANS'];
    expect(columnarScansEnabled()).toBe(false);
    const { events, stats } = await collectViaRouter([TYPE_A, TYPE_B]);
    const viaStore = await collectViaStore([TYPE_A, TYPE_B]);
    expect(sortByDot(events)).toEqual(sortByDot(viaStore));
    expect(stats).toEqual({ consumer: 'test-consumer', sealedDays: 0, hotDays: 0, bytesEstimate: 0 });
  });

  it('seal tier off degrades to passthrough even with sealed segments on disk', async () => {
    await seedAndSeal();
    delete process.env['SIDETRACK_EVENT_SEAL'];
    const { events, stats } = await collectViaRouter([TYPE_A, TYPE_B]);
    const viaStore = await collectViaStore([TYPE_A, TYPE_B]);
    expect(sortByDot(events)).toEqual(sortByDot(viaStore));
    expect(stats.sealedDays).toBe(0);
  });

  it('empty manifest (nothing sealed yet) degrades to passthrough', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    await eventLog.importPeerEvent(peerEvent({ day: DAY_C, type: TYPE_A }));
    store = await getCaughtUpSharedEventStore(vaultRoot);
    const { stats } = await collectViaRouter([TYPE_A]);
    expect(stats.sealedDays).toBe(0);
  });

  it('fails closed to the pure-store path when a sealed segment is corrupt', async () => {
    await seedAndSeal();
    await writeFile(sealSegmentPath(vaultRoot, REPLICA, DAY_A), 'not parquet');
    const { events } = await collectViaRouter([TYPE_A, TYPE_B]);
    const viaStore = await collectViaStore([TYPE_A, TYPE_B]);
    // Correctness over performance: still the FULL, correct result set —
    // never partial or wrong data.
    expect(sortByDot(events)).toEqual(sortByDot(viaStore));
  });

  it('a late arrival after sealing (store-drift) is read from the hot path, not the stale segment', async () => {
    await seedAndSeal();
    // Re-open the log to append one more DAY_A event WITHOUT re-sealing —
    // the manifest entry for DAY_A no longer matches the live store, same
    // benign "store-drift" case eventScan.ts's integrity check names.
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const lateEvent = peerEvent({ day: DAY_A, type: TYPE_A });
    await eventLog.importPeerEvent(lateEvent);
    store = await getCaughtUpSharedEventStore(vaultRoot);

    const { events, stats } = await collectViaRouter([TYPE_A]);
    expect(events.some((event) => event.dot.seq === lateEvent.dot.seq)).toBe(true);
    // DAY_A is now drifted (hot), DAY_B still trusted-sealed, DAY_C hot.
    expect(stats.sealedDays).toBe(1);
    expect(stats.hotDays).toBe(2);
  });

  it('the sealed/hot classification cache invalidates when a previously-hot day gets sealed', async () => {
    await seedAndSeal();
    const first = await collectViaRouter([TYPE_A]);
    expect(first.stats.sealedDays).toBe(2);
    expect(first.stats.hotDays).toBe(1); // DAY_C, still open at NOW.

    // Advance "now" one day and re-run the seal pass — DAY_C is closed as
    // of this later clock, so it becomes sealable too. Nothing else about
    // the vault changed except the manifest (a new day sealed) and the
    // store watermark is UNCHANGED — this specifically exercises the
    // manifest-lines half of the cache's invalidation signal, not just the
    // watermark half the "late arrival" test above already covers.
    const laterNow = new Date('2026-04-05T12:00:00.000Z');
    const sealPass = await runEventSealPass(vaultRoot, { now: () => laterNow });
    expect(sealPass.sealed.map((entry) => entry.day)).toEqual([DAY_C]);

    const second = await collectViaRouter([TYPE_A]);
    expect(second.stats.sealedDays).toBe(3);
    expect(second.stats.hotDays).toBe(0);
    // Same events either way — only the routing SPLIT changed, not the data.
    expect(sortByDot(second.events).map(safeFields)).toEqual(sortByDot(first.events).map(safeFields));
  });

  it('prints an audible [scan.columnar] mark with consumer/sealedDays/hotDays/bytesEstimate', async () => {
    await seedAndSeal();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await collectViaRouter([TYPE_A, TYPE_B], 'mark-test-consumer');
      const marks = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('[scan.columnar]'));
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatch(
        /^\[scan\.columnar\] consumer=mark-test-consumer sealedDays=2 hotDays=1 bytesEstimate=\d+$/,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns immediately for an empty type list without touching the store', async () => {
    await seedAndSeal();
    const { events, stats } = await collectViaRouter([]);
    expect(events).toEqual([]);
    expect(stats).toEqual({ consumer: 'test-consumer', sealedDays: 0, hotDays: 0, bytesEstimate: 0 });
  });
});
