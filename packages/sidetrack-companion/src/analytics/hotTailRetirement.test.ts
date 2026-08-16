import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENGAGEMENT_INTERVAL_OBSERVED, ENGAGEMENT_SESSION_AGGREGATED } from '../engagement/events.js';
import { applyEngagementCompaction, planEngagementCompaction } from '../gc/compactionPlanner.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { createEventStore } from '../sync/eventStore.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { runEventSealPass, sealSegmentPath } from './eventSeal.js';
import { buildHotTailRetirementReport } from './hotTailRetirement.js';

const PEER = 'peer-hot-tail';
const DAY_A = '2026-03-01';
const DAY_B = '2026-03-02';
const NOW = new Date('2026-03-04T12:00:00.000Z');

const peerEvent = (seq: number, day: string): AcceptedEvent => ({
  clientEventId: `${PEER}.${String(seq)}.thread.upserted`,
  dot: { replicaId: PEER, seq },
  deps: {},
  aggregateId: `T${String(seq)}`,
  type: 'thread.upserted',
  payload: { bac_id: `T${String(seq)}`, title: `Thread ${String(seq)}` },
  acceptedAtMs: Date.parse(`${day}T10:00:00.000Z`) + seq,
});

describe('hot-tail retirement report', () => {
  let vaultRoot = '';
  let previousStoreFlag: string | undefined;
  let previousSealFlag: string | undefined;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-hot-tail-'));
    previousStoreFlag = process.env['SIDETRACK_EVENT_STORE'];
    previousSealFlag = process.env['SIDETRACK_EVENT_SEAL'];
    process.env['SIDETRACK_EVENT_STORE'] = '1';
    process.env['SIDETRACK_EVENT_SEAL'] = '1';
  });

  afterEach(async () => {
    if (previousStoreFlag === undefined) delete process.env['SIDETRACK_EVENT_STORE'];
    else process.env['SIDETRACK_EVENT_STORE'] = previousStoreFlag;
    if (previousSealFlag === undefined) delete process.env['SIDETRACK_EVENT_SEAL'];
    else process.env['SIDETRACK_EVENT_SEAL'] = previousSealFlag;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  // Simulates a live companion's background catch-up populating the
  // event-store mirror — the ONLY thing that ever writes it. This helper
  // is read-write (`createEventStore` proper); the module under test never
  // calls it — it only opens the mirror `{ readonly: true }`.
  const catchUpStoreMirror = async (): Promise<void> => {
    const store = await createEventStore(vaultRoot);
    await store.catchUpFromJsonl(join(vaultRoot, '_BAC', 'log'));
    store.close();
  };

  const seedAndSeal = async (): Promise<void> => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (let seq = 1; seq <= 5; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_A));
    for (let seq = 6; seq <= 9; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_B));
    const pass = await runEventSealPass(vaultRoot, { now: () => NOW });
    expect(pass.errors).toEqual([]);
    expect(pass.sealed).toHaveLength(2);
  };

  it('reports sealed-verified + eligible with correct byte accounting on a freshly sealed vault', async () => {
    await seedAndSeal();
    const shardAPath = join(vaultRoot, '_BAC', 'log', PEER, `${DAY_A}.jsonl`);
    const shardBPath = join(vaultRoot, '_BAC', 'log', PEER, `${DAY_B}.jsonl`);
    const [bytesA, bytesB] = await Promise.all([
      stat(shardAPath).then((info) => info.size),
      stat(shardBPath).then((info) => info.size),
    ]);

    const report = await buildHotTailRetirementReport(vaultRoot, { now: () => NOW });
    expect(report.sealManifestPresent).toBe(true);
    expect(report.eventStoreMirrorPresent).toBe(true);

    const shardA = report.shards.find((s) => s.replica === PEER && s.day === DAY_A);
    const shardB = report.shards.find((s) => s.replica === PEER && s.day === DAY_B);
    expect(shardA).toMatchObject({
      verdict: 'sealed-verified',
      retirementEligible: true,
      eventsSealed: 5,
      eventsLive: 5,
      eventsUncovered: 0,
      jsonlBytes: bytesA,
    });
    expect(shardB).toMatchObject({
      verdict: 'sealed-verified',
      retirementEligible: true,
      eventsSealed: 4,
      eventsLive: 4,
      eventsUncovered: 0,
      jsonlBytes: bytesB,
    });

    expect(report.totals).toMatchObject({
      shardsEligible: 2,
      bytesRetirable: bytesA + bytesB,
      eventsUncoveredTotal: 0,
      segmentAlarms: 0,
      storeDriftShards: 0,
      neverSealedShards: 0,
    });
  });

  it('flags a closed day with no manifest entry as never-sealed (a blocker, not eligible)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (let seq = 1; seq <= 3; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_A));
    // Never seal, but the mirror IS caught up (as a live companion's
    // background pass would do), so the report can see the live row count.
    await catchUpStoreMirror();

    const report = await buildHotTailRetirementReport(vaultRoot, { now: () => NOW });
    expect(report.sealManifestPresent).toBe(false);
    const shardA = report.shards.find((s) => s.replica === PEER && s.day === DAY_A);
    expect(shardA).toMatchObject({
      verdict: 'never-sealed',
      retirementEligible: false,
      eventsSealed: 0,
      eventsLive: 3,
      eventsUncovered: 3,
    });
    expect(report.totals).toMatchObject({ shardsEligible: 0, neverSealedShards: 1, bytesRetirable: 0 });
  });

  it("excludes today's open day, never a blocker or eligible", async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const today = NOW.toISOString().slice(0, 10);
    await eventLog.importPeerEvent(peerEvent(1, today));

    const report = await buildHotTailRetirementReport(vaultRoot, { now: () => NOW });
    const openShard = report.shards.find((s) => s.replica === PEER && s.day === today);
    expect(openShard).toMatchObject({ verdict: 'open', retirementEligible: false, eventsUncovered: 0 });
    expect(report.totals.openShards).toBe(1);
  });

  it('classifies a late arrival as benign store-drift — blocked, not corrupt', async () => {
    await seedAndSeal();
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    await eventLog.importPeerEvent(peerEvent(10, DAY_A));
    // The live companion's background catch-up ingests the late arrival
    // into its mirror before this report ever runs.
    await catchUpStoreMirror();

    const report = await buildHotTailRetirementReport(vaultRoot, { now: () => NOW });
    const shardA = report.shards.find((s) => s.replica === PEER && s.day === DAY_A);
    expect(shardA).toMatchObject({
      verdict: 'store-drift',
      retirementEligible: false,
      eventsSealed: 5,
      eventsLive: 6,
      eventsUncovered: 1,
    });
    expect(report.totals).toMatchObject({ storeDriftShards: 1, segmentAlarms: 0, shardsEligible: 1 });

    // Re-sealing heals it back to eligible.
    await runEventSealPass(vaultRoot, { now: () => NOW });
    const healed = await buildHotTailRetirementReport(vaultRoot, { now: () => NOW });
    const healedShardA = healed.shards.find((s) => s.replica === PEER && s.day === DAY_A);
    expect(healedShardA).toMatchObject({ verdict: 'sealed-verified', retirementEligible: true, eventsUncovered: 0 });
  });

  it('raises a segment-corrupt alarm when a sealed file is tampered with (tampered seal -> proof fails)', async () => {
    await seedAndSeal();
    await writeFile(sealSegmentPath(vaultRoot, PEER, DAY_A), 'not parquet');

    const report = await buildHotTailRetirementReport(vaultRoot, { now: () => NOW });
    const shardA = report.shards.find((s) => s.replica === PEER && s.day === DAY_A);
    expect(shardA?.verdict).toBe('segment-corrupt');
    expect(shardA?.retirementEligible).toBe(false);
    expect(report.totals.segmentAlarms).toBe(1);
    // The untampered day is unaffected.
    const shardB = report.shards.find((s) => s.replica === PEER && s.day === DAY_B);
    expect(shardB).toMatchObject({ verdict: 'sealed-verified', retirementEligible: true });
  });

  it('raises a segment-missing alarm when a sealed file is deleted', async () => {
    await seedAndSeal();
    await unlink(sealSegmentPath(vaultRoot, PEER, DAY_B));

    const report = await buildHotTailRetirementReport(vaultRoot, { now: () => NOW });
    const shardB = report.shards.find((s) => s.replica === PEER && s.day === DAY_B);
    expect(shardB).toMatchObject({ verdict: 'segment-missing', retirementEligible: false });
    expect(report.totals.segmentAlarms).toBe(1);
  });

  it('reports zero writes: does not create an event-store mirror that never existed', async () => {
    delete process.env['SIDETRACK_EVENT_STORE'];
    const dbPath = join(vaultRoot, '_BAC', 'connections', 'event-store.db');
    const report = await buildHotTailRetirementReport(vaultRoot, { now: () => NOW });
    expect(report.eventStoreMirrorPresent).toBe(false);
    await expect(stat(dbPath)).rejects.toThrow();
  });

  it(
    'is env-independent at report time: reports correctly with SIDETRACK_EVENT_STORE/SEAL unset, ' +
      'reading only what is already on disk (never gates on the CLI invocation\'s own env)',
    async () => {
      await seedAndSeal();
      delete process.env['SIDETRACK_EVENT_STORE'];
      delete process.env['SIDETRACK_EVENT_SEAL'];

      const report = await buildHotTailRetirementReport(vaultRoot, { now: () => NOW });
      expect(report.sealManifestPresent).toBe(true);
      expect(report.eventStoreMirrorPresent).toBe(true);
      const shardA = report.shards.find((s) => s.replica === PEER && s.day === DAY_A);
      expect(shardA).toMatchObject({ verdict: 'sealed-verified', retirementEligible: true, eventsSealed: 5 });
    },
  );

  it('does not mutate the event-store mirror file (byte-identical before/after)', async () => {
    await seedAndSeal();
    const dbPath = join(vaultRoot, '_BAC', 'connections', 'event-store.db');
    const before = await readFile(dbPath);
    await buildHotTailRetirementReport(vaultRoot, { now: () => NOW });
    const after = await readFile(dbPath);
    expect(Buffer.compare(before, after)).toBe(0);
  });

  // Compaction-aware proof: F1's engagement compaction physically rewrites
  // the hot-tail JSONL AFTER a day is sealed. The seal-coverage proof must
  // reconcile via the manifest + store day-stats (never a raw JSONL
  // rescan) and must NOT raise a false segment-corrupt/segment-missing
  // alarm merely because compaction touched the (untouched-by-sealing)
  // JSONL side — the parquet segment itself is never written by
  // compaction, so its own proof against the manifest stays intact.
  describe('compaction-aware seal-coverage proof', () => {
    let eventLog: EventLog;
    let now: Date;

    beforeEach(() => {
      now = new Date('2020-01-01T12:00:00.000Z');
      process.env['SIDETRACK_ENGAGEMENT_COMPACT'] = '1';
    });

    afterEach(() => {
      delete process.env['SIDETRACK_ENGAGEMENT_COMPACT'];
      delete process.env['SIDETRACK_ENGAGEMENT_COMPACT_DAYS'];
    });

    const dims = (focusedWindowMs: number) => ({
      activeMs: focusedWindowMs,
      visibleMs: 0,
      focusedWindowMs,
      idleMs: 0,
      foregroundBursts: 0,
      returnCount: 0,
      scrollEvents: 0,
      maxScrollRatio: 0,
      copyCount: 0,
      pasteCount: 0,
    });

    const appendInterval = async (id: string, visitId: string, focusedWindowMs: number): Promise<void> => {
      await eventLog.appendClientObserved({
        clientEventId: id,
        aggregateId: `${ENGAGEMENT_INTERVAL_OBSERVED}:${visitId}`,
        type: ENGAGEMENT_INTERVAL_OBSERVED,
        baseVector: {},
        payload: {
          payloadVersion: 1,
          visitId,
          intervalStart: now.getTime(),
          intervalEnd: now.getTime() + 1_000,
          dimensions: { engagement: dims(focusedWindowMs) },
        },
      });
    };

    const appendAggregate = async (id: string, visitId: string, focusedWindowMs: number): Promise<void> => {
      await eventLog.appendClientObserved({
        clientEventId: id,
        aggregateId: `${ENGAGEMENT_SESSION_AGGREGATED}:${visitId}`,
        type: ENGAGEMENT_SESSION_AGGREGATED,
        baseVector: {},
        payload: {
          payloadVersion: 1,
          visitId,
          sessionId: `session-${visitId}`,
          dimensions: { engagement: dims(focusedWindowMs) },
        },
      });
    };

    it('seal -> compact -> proof still passes (store-drift, never a false corruption alarm); re-seal restores eligibility at the smaller size', async () => {
      const replicaContext = await loadOrCreateReplica(vaultRoot);
      eventLog = createEventLog(vaultRoot, replicaContext, { now: () => now });
      await appendInterval('interval-1', 'covered', 400);
      await appendInterval('interval-2', 'covered', 400);
      await appendAggregate('aggregate-covered', 'covered', 9_000);
      const replicaId = (await eventLog.listReplicaIds())[0];
      if (replicaId === undefined) throw new Error('fixture replica missing');

      const sealDay = now.toISOString().slice(0, 10);
      const future = new Date('2026-07-29T12:00:00.000Z');
      const sealPass = await runEventSealPass(vaultRoot, { now: () => future });
      expect(sealPass.errors).toEqual([]);
      expect(sealPass.sealed).toHaveLength(1);

      const beforeReport = await buildHotTailRetirementReport(vaultRoot, { now: () => future });
      const beforeShard = beforeReport.shards.find((s) => s.day === sealDay);
      expect(beforeShard).toMatchObject({ verdict: 'sealed-verified', retirementEligible: true });
      const shardPathBefore = join(vaultRoot, '_BAC', 'log', replicaId, `${sealDay}.jsonl`);
      const bytesBeforeCompaction = (await stat(shardPathBefore)).size;
      expect(beforeShard?.jsonlBytes).toBe(bytesBeforeCompaction);

      // Compact: drops the covered-and-aggregated intervals from the sealed
      // shard. This rewrites the JSONL; the parquet segment under _BAC/seal
      // is never touched by compaction.
      await eventLog.prewarmAppendIndexes();
      const plan = await planEngagementCompaction(vaultRoot, {
        now: future,
        retainDays: 30,
        onlineMaintenance: true,
      });
      expect(plan.wouldRewrite).toBe(true);
      expect(plan.intervalsFolded).toBe(2);
      const result = await applyEngagementCompaction(plan, { eventLog });
      expect(result.errors).toEqual([]);
      expect(result.droppedLines).toBe(2);

      // A live companion's background catch-up re-reads the shard, sees the
      // trusted compaction receipt, and physically drops the corresponding
      // rows from its own mirror (sync/eventStore.ts's applyCompactionReceipt)
      // — simulated here the same way `catchUpStoreMirror` simulates every
      // other "the live mirror is already caught up" precondition above.
      await catchUpStoreMirror();

      const bytesAfterCompaction = (await stat(shardPathBefore)).size;
      expect(bytesAfterCompaction).toBeLessThan(bytesBeforeCompaction);

      // The seal-coverage proof reconciles via the manifest/store, not a
      // raw JSONL rescan: after compaction, this MUST classify as benign
      // store-drift (row count shrank, receipt-covered) — never a false
      // segment-corrupt/segment-missing alarm, since the parquet segment
      // itself is byte-identical to before compaction.
      const afterCompactionReport = await buildHotTailRetirementReport(vaultRoot, { now: () => future });
      const afterCompactionShard = afterCompactionReport.shards.find((s) => s.day === sealDay);
      expect(afterCompactionShard?.verdict).toBe('store-drift');
      expect(afterCompactionShard?.retirementEligible).toBe(false);
      expect(afterCompactionReport.totals.segmentAlarms).toBe(0);
      expect(afterCompactionShard?.jsonlBytes).toBe(bytesAfterCompaction);

      // Re-sealing produces a new manifest entry matching the compacted
      // state; the day becomes eligible again, at the smaller size.
      const resealPass = await runEventSealPass(vaultRoot, { now: () => future });
      expect(resealPass.errors).toEqual([]);
      const healedReport = await buildHotTailRetirementReport(vaultRoot, { now: () => future });
      const healedShard = healedReport.shards.find((s) => s.day === sealDay);
      expect(healedShard).toMatchObject({
        verdict: 'sealed-verified',
        retirementEligible: true,
        jsonlBytes: bytesAfterCompaction,
      });
      expect(healedShard?.jsonlBytes).toBeLessThan(bytesBeforeCompaction);
    });
  });
});
