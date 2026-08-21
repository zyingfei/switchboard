import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENGAGEMENT_INTERVAL_OBSERVED, ENGAGEMENT_SESSION_AGGREGATED } from '../engagement/events.js';
import { applyEngagementCompaction, planEngagementCompaction } from '../gc/compactionPlanner.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { createEventStore } from '../sync/eventStore.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { readSealedParquetDayStats } from './eventScan.js';
import { readSealManifest, runEventSealPass, sealSegmentPath } from './eventSeal.js';
import {
  applyHotTailRetirement,
  buildHotTailRetirementReport,
  retiredShardPath,
  retirementReceiptsPath,
} from './hotTailRetirement.js';

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

    // PR #407 verification: F1 compaction can legitimately empty a WHOLE
    // day, not just shrink it (a day whose events are all
    // engagement.interval, all covered by an aggregate elsewhere). The
    // resulting 0-byte JSONL shard must still retire cleanly once
    // eventSeal.ts heals the day into an empty-day seal (see
    // eventSeal.test.ts's "zero-row day re-discovery" suite for the sealer
    // side of this fix) — this test covers the retirement report + apply
    // side: report classifies it sealed-verified/eligible with
    // bytesRetirable covering the (empty) file, and apply moves the 0-byte
    // file to retired/ so the hot tail is fully clean.
    it('retires a wholly emptied day: report is sealed-verified/eligible, apply moves the 0-byte JSONL to retired/', async () => {
      const replicaContext = await loadOrCreateReplica(vaultRoot);
      eventLog = createEventLog(vaultRoot, replicaContext, { now: () => now });
      // intervalDay: ONLY interval lines for one visit — nothing else, so
      // once compaction drops them, the shard is wholly empty.
      await appendInterval('interval-1', 'lonely', 400);
      await appendInterval('interval-2', 'lonely', 400);
      const intervalDay = now.toISOString().slice(0, 10);

      // aggregateDay: the visit's covering aggregate, on a different day —
      // otherwise intervalDay's shard would keep this one surviving row.
      now = new Date('2020-01-02T12:00:00.000Z');
      await appendAggregate('aggregate-lonely', 'lonely', 9_000);
      const aggregateDay = now.toISOString().slice(0, 10);

      const replicaId = (await eventLog.listReplicaIds())[0];
      if (replicaId === undefined) throw new Error('fixture replica missing');

      const future = new Date('2026-07-29T12:00:00.000Z');
      const sealPass = await runEventSealPass(vaultRoot, { now: () => future });
      expect(sealPass.errors).toEqual([]);
      expect(sealPass.sealed.map((entry) => entry.day).sort()).toEqual([intervalDay, aggregateDay].sort());

      await eventLog.prewarmAppendIndexes();
      const plan = await planEngagementCompaction(vaultRoot, {
        now: future,
        retainDays: 30,
        onlineMaintenance: true,
      });
      expect(plan.wouldRewrite).toBe(true);
      expect(plan.intervalsFolded).toBe(2);
      const applyCompactionResult = await applyEngagementCompaction(plan, { eventLog });
      expect(applyCompactionResult.errors).toEqual([]);
      expect(applyCompactionResult.droppedLines).toBe(2);

      const intervalShardPath = join(vaultRoot, '_BAC', 'log', replicaId, `${intervalDay}.jsonl`);
      expect((await stat(intervalShardPath)).size).toBe(0);

      await catchUpStoreMirror();

      // Heal intervalDay's stale seal into an empty-day seal.
      const resealPass = await runEventSealPass(vaultRoot, { now: () => future });
      expect(resealPass.errors).toEqual([]);
      expect(resealPass.unexplainedZeroRowDays).toBe(0);
      expect(resealPass.sealed.map((entry) => entry.day)).toEqual([intervalDay]);

      const report = await buildHotTailRetirementReport(vaultRoot, { now: () => future });
      const intervalShard = report.shards.find((s) => s.replica === replicaId && s.day === intervalDay);
      expect(intervalShard).toMatchObject({
        verdict: 'sealed-verified',
        retirementEligible: true,
        eventsSealed: 0,
        jsonlBytes: 0,
      });
      expect(report.totals.storeDriftShards).toBe(0);
      expect(report.totals.shardsEligible).toBeGreaterThanOrEqual(2); // both days eligible

      const applyResult = await applyHotTailRetirement(vaultRoot, { now: () => future });
      expect(applyResult.errors).toEqual([]);
      const intervalOutcome = applyResult.outcomes.find((o) => o.replica === replicaId && o.day === intervalDay);
      expect(intervalOutcome).toMatchObject({ outcome: 'moved', bytes: 0 });

      // Hot path gone, retired path present, still 0 bytes.
      await expect(stat(intervalShardPath)).rejects.toThrow();
      const retiredPath = retiredShardPath(vaultRoot, replicaId, intervalDay);
      expect((await stat(retiredPath)).size).toBe(0);

      // Receipt recorded for the empty shard too — before/after both 0
      // bytes, hashes equal (sha256 of the empty string either way).
      const receiptRaw = await readFile(applyResult.receiptPath, 'utf8');
      const receipts = receiptRaw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const intervalReceipt = receipts.find(
        (r) => r['replica'] === replicaId && r['day'] === intervalDay,
      );
      expect(intervalReceipt).toMatchObject({ beforeBytes: 0, afterBytes: 0, eventsSealed: 0 });
      expect(intervalReceipt?.['beforeSha256']).toBe(intervalReceipt?.['afterSha256']);

      // A second report after apply still sees the day as clean: the
      // retired tree is a sibling of the hot tail, so the (already absent)
      // hot path contributes 0 bytes either way.
      const afterApplyReport = await buildHotTailRetirementReport(vaultRoot, { now: () => future });
      const afterApplyShard = afterApplyReport.shards.find(
        (s) => s.replica === replicaId && s.day === intervalDay,
      );
      expect(afterApplyShard).toMatchObject({
        verdict: 'sealed-verified',
        retirementEligible: true,
        jsonlBytes: 0,
      });
    });
  });
});

describe('hot-tail retirement apply', () => {
  let vaultRoot = '';
  let previousStoreFlag: string | undefined;
  let previousSealFlag: string | undefined;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-hot-tail-apply-'));
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

  const seedAndSeal = async (): Promise<void> => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (let seq = 1; seq <= 5; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_A));
    for (let seq = 6; seq <= 9; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_B));
    const pass = await runEventSealPass(vaultRoot, { now: () => NOW });
    expect(pass.errors).toEqual([]);
    expect(pass.sealed).toHaveLength(2);
  };

  const hotPath = (day: string): string => join(vaultRoot, '_BAC', 'log', PEER, `${day}.jsonl`);
  const retiredPath = (day: string): string => retiredShardPath(vaultRoot, PEER, day);

  it(
    'moves every sealed+eligible shard to the retired mirror byte-identically, leaves a ' +
      'never-sealed day untouched, and is excluded from the next report\'s hot-tail discovery',
    async () => {
      await seedAndSeal();
      // A third, never-sealed day — must be reported as a skip, never moved.
      const replica = await loadOrCreateReplica(vaultRoot);
      const eventLog = createEventLog(vaultRoot, replica);
      const DAY_C = '2026-03-03';
      await eventLog.importPeerEvent(peerEvent(10, DAY_C));

      const bytesABefore = (await stat(hotPath(DAY_A))).size;
      const bytesBBefore = (await stat(hotPath(DAY_B))).size;
      const beforeContentA = await readFile(hotPath(DAY_A), 'utf8');
      const beforeContentB = await readFile(hotPath(DAY_B), 'utf8');

      const result = await applyHotTailRetirement(vaultRoot, { now: () => NOW });

      expect(result.errors).toEqual([]);
      expect(result.shardsRetired).toBe(2);
      expect(result.shardsAlreadyRetired).toBe(0);
      expect(result.bytesMoved).toBe(bytesABefore + bytesBBefore);

      // Moved, byte-identical, hot path gone.
      await expect(stat(hotPath(DAY_A))).rejects.toThrow();
      await expect(stat(hotPath(DAY_B))).rejects.toThrow();
      expect(await readFile(retiredPath(DAY_A), 'utf8')).toBe(beforeContentA);
      expect(await readFile(retiredPath(DAY_B), 'utf8')).toBe(beforeContentB);

      // Never-sealed day untouched.
      expect((await stat(hotPath(DAY_C))).isFile()).toBe(true);
      const cOutcome = result.outcomes.find((o) => o.day === DAY_C);
      expect(cOutcome).toMatchObject({ outcome: 'skipped', reason: 'not-eligible', verdict: 'never-sealed' });

      // Receipt: one line per moved shard, before/after hashes recorded,
      // before === after (a same-filesystem rename cannot change content).
      expect(result.receiptPath).toBe(retirementReceiptsPath(vaultRoot));
      const receiptRaw = await readFile(result.receiptPath, 'utf8');
      const receiptLines = receiptRaw.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(receiptLines).toHaveLength(2);
      for (const receipt of receiptLines) {
        expect(receipt['beforeSha256']).toBe(receipt['afterSha256']);
        expect(receipt['beforeBytes']).toBe(receipt['afterBytes']);
      }

      // Discovery: the retired tree is a SIBLING of _BAC/log, so the next
      // report's hot-tail scan sees zero bytes at the (now-absent) hot
      // path for the retired days — proves retired/ is excluded from
      // day-file discovery, not merely "the file happens to be moved".
      const afterReport = await buildHotTailRetirementReport(vaultRoot, { now: () => NOW });
      const shardA = afterReport.shards.find((s) => s.day === DAY_A);
      const shardB = afterReport.shards.find((s) => s.day === DAY_B);
      expect(shardA).toMatchObject({ jsonlBytes: 0, verdict: 'sealed-verified', retirementEligible: true });
      expect(shardB).toMatchObject({ jsonlBytes: 0, verdict: 'sealed-verified', retirementEligible: true });
    },
  );

  it(
    'readers still serve the full history after retirement: readMerged tolerates the absent ' +
      'day file, and the typed store + sealed Parquet still cover it completely',
    async () => {
      await seedAndSeal();
      const replica = await loadOrCreateReplica(vaultRoot);
      const eventLog = createEventLog(vaultRoot, replica, { now: () => NOW });

      const result = await applyHotTailRetirement(vaultRoot, { now: () => NOW });
      expect(result.shardsRetired).toBe(2);

      // eventLog.readMerged() never throws on the absent day files, and
      // simply no longer surfaces the retired days' events — the designed
      // F3 handoff, not a crash.
      const merged = await eventLog.readMerged();
      expect(merged.filter((e) => e.dot.replicaId === PEER)).toHaveLength(0);

      // The typed store mirror still has every retired-day row.
      const store = await createEventStore(vaultRoot);
      try {
        const dayStats = store.sealDayStats(PEER);
        const statsByDay = new Map(dayStats.map((s) => [s.day, s]));
        expect(statsByDay.get(DAY_A)?.rows).toBe(5);
        expect(statsByDay.get(DAY_B)?.rows).toBe(4);
      } finally {
        store.close();
      }

      // The sealed Parquet segment still has every retired-day row.
      const manifest = await readSealManifest(vaultRoot);
      const { stats } = await readSealedParquetDayStats(vaultRoot, [...manifest.latest.values()]);
      expect(stats.get(`${PEER} ${DAY_A}`)?.rows).toBe(5);
      expect(stats.get(`${PEER} ${DAY_B}`)?.rows).toBe(4);
    },
  );

  it('second run is a clean no-op: already-retired shards are recognised, not re-moved or errored', async () => {
    await seedAndSeal();
    const first = await applyHotTailRetirement(vaultRoot, { now: () => NOW });
    expect(first.shardsRetired).toBe(2);

    const beforeA = await readFile(retiredPath(DAY_A), 'utf8');
    const beforeB = await readFile(retiredPath(DAY_B), 'utf8');

    const second = await applyHotTailRetirement(vaultRoot, { now: () => NOW });
    expect(second.errors).toEqual([]);
    expect(second.shardsRetired).toBe(0);
    expect(second.shardsAlreadyRetired).toBe(2);
    expect(second.bytesMoved).toBe(0);
    expect(second.outcomes.every((o) => o.outcome === 'already-retired')).toBe(true);

    expect(await readFile(retiredPath(DAY_A), 'utf8')).toBe(beforeA);
    expect(await readFile(retiredPath(DAY_B), 'utf8')).toBe(beforeB);
  });

  it(
    'drift-fail-closed: a tampered seal skips only that shard in the SAME run — the other ' +
      'still-eligible shard retires normally',
    async () => {
      await seedAndSeal();
      await writeFile(sealSegmentPath(vaultRoot, PEER, DAY_A), 'not parquet');

      const result = await applyHotTailRetirement(vaultRoot, { now: () => NOW });

      expect(result.shardsRetired).toBe(1);
      const outcomeA = result.outcomes.find((o) => o.day === DAY_A);
      const outcomeB = result.outcomes.find((o) => o.day === DAY_B);
      expect(outcomeA).toMatchObject({ outcome: 'skipped', reason: 'not-eligible', verdict: 'segment-corrupt' });
      expect(outcomeB).toMatchObject({ outcome: 'moved' });

      // The tampered day's hot shard is untouched — never partially moved.
      expect((await stat(hotPath(DAY_A))).isFile()).toBe(true);
      await expect(stat(retiredPath(DAY_A))).rejects.toThrow();
      await expect(stat(hotPath(DAY_B))).rejects.toThrow();
    },
  );

  it(
    'crash-resume: a shard already moved by an earlier (interrupted) run is recognised on ' +
      're-run and the remaining shard completes normally',
    async () => {
      await seedAndSeal();
      // Simulate "the process crashed after moving DAY_A but before DAY_B"
      // by performing exactly that half of the move out-of-band, then
      // calling apply once — a faithful stand-in for what disk state a
      // real crash between two shard renames would leave behind.
      await mkdir(dirname(retiredPath(DAY_A)), { recursive: true });
      await rename(hotPath(DAY_A), retiredPath(DAY_A));
      await expect(stat(hotPath(DAY_A))).rejects.toThrow();
      expect((await stat(hotPath(DAY_B))).isFile()).toBe(true);

      const result = await applyHotTailRetirement(vaultRoot, { now: () => NOW });

      expect(result.errors).toEqual([]);
      expect(result.shardsRetired).toBe(1);
      expect(result.shardsAlreadyRetired).toBe(1);
      const outcomeA = result.outcomes.find((o) => o.day === DAY_A);
      const outcomeB = result.outcomes.find((o) => o.day === DAY_B);
      expect(outcomeA?.outcome).toBe('already-retired');
      expect(outcomeB?.outcome).toBe('moved');
      await expect(stat(hotPath(DAY_B))).rejects.toThrow();
      expect((await stat(retiredPath(DAY_A))).isFile()).toBe(true);
      expect((await stat(retiredPath(DAY_B))).isFile()).toBe(true);
    },
  );

  it(
    'never clobbers an existing retired file: a re-opened hot shard (late peer arrival after ' +
      'an earlier retirement) is left exactly as found, both files intact',
    async () => {
      await seedAndSeal();
      // Move DAY_A out-of-band first (as the previous test does), then
      // simulate a late peer arrival re-opening the hot path for DAY_A —
      // eventSeal.ts's own "late arrivals... re-sealed" comment documents
      // exactly this store-level scenario; at the JSONL layer it means a
      // NEW file appears at the hot path for an already-retired day.
      await mkdir(dirname(retiredPath(DAY_A)), { recursive: true });
      await rename(hotPath(DAY_A), retiredPath(DAY_A));
      const retiredContent = await readFile(retiredPath(DAY_A), 'utf8');
      await writeFile(hotPath(DAY_A), '{"reopened":"late-arrival-marker"}\n', 'utf8');

      const result = await applyHotTailRetirement(vaultRoot, { now: () => NOW });

      const outcomeA = result.outcomes.find((o) => o.day === DAY_A);
      expect(outcomeA).toMatchObject({ outcome: 'skipped', reason: 'retired-destination-exists' });
      expect(result.errors.length).toBeGreaterThan(0);

      // BOTH files survive, byte-identical to how this test left them —
      // the one invariant that must never break.
      expect(await readFile(retiredPath(DAY_A), 'utf8')).toBe(retiredContent);
      expect(await readFile(hotPath(DAY_A), 'utf8')).toBe('{"reopened":"late-arrival-marker"}\n');
    },
  );
});
