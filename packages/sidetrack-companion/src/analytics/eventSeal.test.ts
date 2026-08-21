import { mkdtemp, readFile, rm, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENGAGEMENT_INTERVAL_OBSERVED, ENGAGEMENT_SESSION_AGGREGATED } from '../engagement/events.js';
import { applyEngagementCompaction, planEngagementCompaction } from '../gc/compactionPlanner.js';
import { createEventLog, type EventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { createEventStore } from '../sync/eventStore.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { buildHotTailRetirementReport } from './hotTailRetirement.js';
import {
  eventSealEnabled,
  readSealManifest,
  runEventSealPass,
  sealManifestPath,
  sealSegmentPath,
} from './eventSeal.js';

const PEER = 'peer-columnar-seal';

// Fixed, closed UTC days. `now` is pinned two days after DAY_B so both days
// are strictly in the past and the "today" exclusion is exercised with a
// deterministic clock.
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

describe('columnar event sealer', () => {
  let vaultRoot = '';
  let previousStoreFlag: string | undefined;
  let previousSealFlag: string | undefined;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-event-seal-'));
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

  const seedTwoClosedDays = async (): Promise<void> => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (let seq = 1; seq <= 5; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_A));
    for (let seq = 6; seq <= 9; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_B));
  };

  it('flag reader follows the default-off idiom', () => {
    expect(eventSealEnabled()).toBe(true);
    process.env['SIDETRACK_EVENT_SEAL'] = 'true';
    expect(eventSealEnabled()).toBe(false);
    delete process.env['SIDETRACK_EVENT_SEAL'];
    expect(eventSealEnabled()).toBe(false);
  });

  it('seals closed days, verifies, and records manifest entries', async () => {
    await seedTwoClosedDays();
    const result = await runEventSealPass(vaultRoot, { now: () => NOW });

    expect(result.errors).toEqual([]);
    expect(result.sealed.map((entry) => entry.day).sort()).toEqual([DAY_A, DAY_B]);
    const dayA = result.sealed.find((entry) => entry.day === DAY_A);
    expect(dayA).toMatchObject({ replica: PEER, rows: 5, seqLo: 1, seqHi: 5 });
    expect(dayA?.sha256).toMatch(/^[0-9a-f]{64}$/);

    for (const day of [DAY_A, DAY_B]) {
      const info = await stat(sealSegmentPath(vaultRoot, PEER, day));
      expect(info.size).toBeGreaterThan(0);
    }
    const manifest = await readSealManifest(vaultRoot);
    expect(manifest.lines).toBe(2);
    expect(manifest.malformedLines).toBe(0);
    expect(manifest.latest.get(`${PEER} ${DAY_B}`)).toMatchObject({ rows: 4, seqLo: 6, seqHi: 9 });
  });

  it('is idempotent: a second pass seals nothing', async () => {
    await seedTwoClosedDays();
    await runEventSealPass(vaultRoot, { now: () => NOW });
    const second = await runEventSealPass(vaultRoot, { now: () => NOW });
    expect(second.sealed).toEqual([]);
    expect(second.planned).toEqual([]);
    expect(second.skippedAlreadySealed).toBe(2);
    expect(second.errors).toEqual([]);
  });

  it('never seals an open (today or future-dated) day', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    await eventLog.importPeerEvent(peerEvent(1, DAY_A));
    // Same-day and fast-clock peer events, relative to the pinned NOW.
    await eventLog.importPeerEvent(peerEvent(2, '2026-03-04'));
    await eventLog.importPeerEvent(peerEvent(3, '2026-03-05'));

    const result = await runEventSealPass(vaultRoot, { now: () => NOW });
    expect(result.sealed.map((entry) => entry.day)).toEqual([DAY_A]);
    expect(result.skippedOpenDays).toBe(2);
  });

  it('re-seals a day when a late peer arrival changes its retained set', async () => {
    await seedTwoClosedDays();
    await runEventSealPass(vaultRoot, { now: () => NOW });

    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    await eventLog.importPeerEvent(peerEvent(10, DAY_A));

    const result = await runEventSealPass(vaultRoot, { now: () => NOW });
    expect(result.errors).toEqual([]);
    expect(result.sealed.map((entry) => entry.day)).toEqual([DAY_A]);
    const manifest = await readSealManifest(vaultRoot);
    // Superseding line appended; latest wins.
    expect(manifest.lines).toBe(3);
    expect(manifest.latest.get(`${PEER} ${DAY_A}`)).toMatchObject({
      rows: 6,
      seqLo: 1,
      seqHi: 10,
    });
  });

  it('dry-run plans without writing anything', async () => {
    await seedTwoClosedDays();
    const result = await runEventSealPass(vaultRoot, { dryRun: true, now: () => NOW });
    expect(result.planned.map((entry) => entry.day).sort()).toEqual([DAY_A, DAY_B]);
    expect(result.sealed).toEqual([]);
    await expect(stat(sealSegmentPath(vaultRoot, PEER, DAY_A))).rejects.toThrow();
    await expect(stat(sealManifestPath(vaultRoot))).rejects.toThrow();
  });

  it('manifest read is malformed-line tolerant and last-entry-wins', async () => {
    await seedTwoClosedDays();
    await runEventSealPass(vaultRoot, { now: () => NOW });
    await appendFile(sealManifestPath(vaultRoot), 'not json\n{"half":true}\n');
    const manifest = await readSealManifest(vaultRoot);
    expect(manifest.malformedLines).toBe(2);
    expect(manifest.latest.size).toBe(2);
    const raw = await readFile(sealManifestPath(vaultRoot), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });
});

// PR #407 verification found this: a day whose retained-row count drops to
// exactly ZERO (F1 compaction can legitimately empty a whole day, not just
// shrink it) vanishes from sealDayStats' GROUP BY entirely — COUNT
// collapses to nothing, not a zero-row group — so a stale seal for it was
// never revisited and retire-hot-tail fail-closed it as store-drift
// forever. These tests exercise the fix: day discovery unions in the seal
// manifest's own known days, verifies a zero-row day against the
// `compacted_events` ledger before healing it, and stays fail-closed when
// that ledger evidence is missing.
describe('zero-row day re-discovery (F1 compaction can legitimately empty a whole day)', () => {
  let vaultRoot = '';
  let previousStoreFlag: string | undefined;
  let previousSealFlag: string | undefined;
  let previousCompactFlag: string | undefined;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-event-seal-zeroday-'));
    previousStoreFlag = process.env['SIDETRACK_EVENT_STORE'];
    previousSealFlag = process.env['SIDETRACK_EVENT_SEAL'];
    previousCompactFlag = process.env['SIDETRACK_ENGAGEMENT_COMPACT'];
    process.env['SIDETRACK_EVENT_STORE'] = '1';
    process.env['SIDETRACK_EVENT_SEAL'] = '1';
    process.env['SIDETRACK_ENGAGEMENT_COMPACT'] = '1';
  });

  afterEach(async () => {
    if (previousStoreFlag === undefined) delete process.env['SIDETRACK_EVENT_STORE'];
    else process.env['SIDETRACK_EVENT_STORE'] = previousStoreFlag;
    if (previousSealFlag === undefined) delete process.env['SIDETRACK_EVENT_SEAL'];
    else process.env['SIDETRACK_EVENT_SEAL'] = previousSealFlag;
    if (previousCompactFlag === undefined) delete process.env['SIDETRACK_ENGAGEMENT_COMPACT'];
    else process.env['SIDETRACK_ENGAGEMENT_COMPACT'] = previousCompactFlag;
    delete process.env['SIDETRACK_ENGAGEMENT_COMPACT_DAYS'];
    await rm(vaultRoot, { recursive: true, force: true });
  });

  // Simulates a live companion's background catch-up dropping compacted
  // rows from its own mirror — the same helper hotTailRetirement.test.ts
  // uses for the identical precondition.
  const catchUpStoreMirror = async (): Promise<void> => {
    const store = await createEventStore(vaultRoot);
    await store.catchUpFromJsonl(join(vaultRoot, '_BAC', 'log'));
    store.close();
  };

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

  it(
    'heals a day whose retained rows dropped to zero via legitimate compaction into an ' +
      'empty-day seal with ledger provenance, while a normal day sealed in the same pass ' +
      'is left completely unaffected',
    async () => {
      const replicaContext = await loadOrCreateReplica(vaultRoot);
      let now = new Date('2020-01-01T12:00:00.000Z');
      const eventLog: EventLog = createEventLog(vaultRoot, replicaContext, { now: () => now });

      // intervalDay: ONLY engagement.interval lines for one visit — nothing
      // else, so once compaction drops the covered intervals, the shard is
      // wholly empty.
      await eventLog.appendClientObserved({
        clientEventId: 'interval-1',
        aggregateId: `${ENGAGEMENT_INTERVAL_OBSERVED}:only-visit`,
        type: ENGAGEMENT_INTERVAL_OBSERVED,
        baseVector: {},
        payload: {
          payloadVersion: 1,
          visitId: 'only-visit',
          intervalStart: now.getTime(),
          intervalEnd: now.getTime() + 1_000,
          dimensions: { engagement: dims(400) },
        },
      });
      await eventLog.appendClientObserved({
        clientEventId: 'interval-2',
        aggregateId: `${ENGAGEMENT_INTERVAL_OBSERVED}:only-visit`,
        type: ENGAGEMENT_INTERVAL_OBSERVED,
        baseVector: {},
        payload: {
          payloadVersion: 1,
          visitId: 'only-visit',
          intervalStart: now.getTime() + 1_000,
          intervalEnd: now.getTime() + 2_000,
          dimensions: { engagement: dims(400) },
        },
      });
      const intervalDay = now.toISOString().slice(0, 10);

      // aggregateDay: the visit's covering aggregate, on a DIFFERENT day —
      // this is the "normal day sealed in the same pass" control.
      now = new Date('2020-01-02T12:00:00.000Z');
      await eventLog.appendClientObserved({
        clientEventId: 'aggregate-only-visit',
        aggregateId: `${ENGAGEMENT_SESSION_AGGREGATED}:only-visit`,
        type: ENGAGEMENT_SESSION_AGGREGATED,
        baseVector: {},
        payload: {
          payloadVersion: 1,
          visitId: 'only-visit',
          sessionId: 'session-only-visit',
          dimensions: { engagement: dims(9_000) },
        },
      });
      const aggregateDay = now.toISOString().slice(0, 10);

      const replicaId = (await eventLog.listReplicaIds())[0];
      if (replicaId === undefined) throw new Error('fixture replica missing');

      const future = new Date('2026-07-29T12:00:00.000Z');
      const firstPass = await runEventSealPass(vaultRoot, { now: () => future });
      expect(firstPass.errors).toEqual([]);
      expect(firstPass.sealed.map((entry) => entry.day).sort()).toEqual([intervalDay, aggregateDay].sort());
      const priorIntervalEntry = firstPass.sealed.find((entry) => entry.day === intervalDay);
      expect(priorIntervalEntry).toMatchObject({ rows: 2, seqLo: 1, seqHi: 2 });
      const aggregateEntry = firstPass.sealed.find((entry) => entry.day === aggregateDay);
      expect(aggregateEntry).toMatchObject({ rows: 1 });

      // Compact: drops the two covered intervals from intervalDay's shard —
      // it holds no other event type, so the shard becomes wholly empty.
      // aggregateDay's shard has zero interval lines and is untouched.
      await eventLog.prewarmAppendIndexes();
      const plan = await planEngagementCompaction(vaultRoot, {
        now: future,
        retainDays: 30,
        onlineMaintenance: true,
      });
      expect(plan.wouldRewrite).toBe(true);
      expect(plan.intervalsFolded).toBe(2);
      const applyResult = await applyEngagementCompaction(plan, { eventLog });
      expect(applyResult.errors).toEqual([]);
      expect(applyResult.droppedLines).toBe(2);

      const intervalShardPath = join(vaultRoot, '_BAC', 'log', replicaId, `${intervalDay}.jsonl`);
      expect((await stat(intervalShardPath)).size).toBe(0);

      // A live companion's background catch-up drops the corresponding
      // rows from its own mirror — sync/eventStore.ts's applyCompactionReceipt.
      await catchUpStoreMirror();

      // BUG reproduction (pre-fix): without the union-with-manifest-days
      // fix, intervalDay would never reappear in sealDayStats' GROUP BY, so
      // this second pass would plan/seal/heal nothing for it.
      const secondPass = await runEventSealPass(vaultRoot, { now: () => future });
      expect(secondPass.errors).toEqual([]);
      expect(secondPass.unexplainedZeroRowDays).toBe(0);
      const healedEntry = secondPass.sealed.find((entry) => entry.day === intervalDay);
      expect(healedEntry).toMatchObject({
        replica: replicaId,
        day: intervalDay,
        rows: 0,
        seqLo: 1,
        seqHi: 2,
        emptyDayCompactedRows: 2,
      });
      expect(healedEntry?.sealedAt.length).toBeGreaterThan(0);
      // aggregateDay was already fully sealed and untouched by compaction —
      // the fix's per-replica manifest walk must not re-plan it.
      expect(secondPass.sealed.map((entry) => entry.day)).not.toContain(aggregateDay);

      const manifest = await readSealManifest(vaultRoot);
      expect(manifest.latest.get(`${replicaId} ${intervalDay}`)).toMatchObject({
        rows: 0,
        seqLo: 1,
        seqHi: 2,
        emptyDayCompactedRows: 2,
      });
      // aggregateDay's own seal entry is byte-for-byte the original — never
      // touched by the empty-day healing pass.
      expect(manifest.latest.get(`${replicaId} ${aggregateDay}`)).toMatchObject(aggregateEntry as object);

      // Idempotent: a third pass seals nothing further for either day.
      const thirdPass = await runEventSealPass(vaultRoot, { now: () => future });
      expect(thirdPass.sealed).toEqual([]);
      expect(thirdPass.unexplainedZeroRowDays).toBe(0);

      // retire-hot-tail now sees a provably clean, retirement-eligible day
      // instead of a permanent store-drift blocker.
      const report = await buildHotTailRetirementReport(vaultRoot, { now: () => future });
      const healedShard = report.shards.find((s) => s.replica === replicaId && s.day === intervalDay);
      expect(healedShard).toMatchObject({
        verdict: 'sealed-verified',
        retirementEligible: true,
        eventsSealed: 0,
        jsonlBytes: 0,
      });
      expect(report.totals.storeDriftShards).toBe(0);
    },
  );

  it(
    'never auto-heals a zero-row day with no compaction-ledger evidence — fails closed, ' +
      'the stale seal and the store-drift verdict both persist',
    async () => {
      const replica = await loadOrCreateReplica(vaultRoot);
      const eventLog = createEventLog(vaultRoot, replica);
      for (let seq = 1; seq <= 3; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_A));

      const firstPass = await runEventSealPass(vaultRoot, { now: () => NOW });
      expect(firstPass.errors).toEqual([]);
      expect(firstPass.sealed).toHaveLength(1);
      expect(firstPass.sealed[0]).toMatchObject({ day: DAY_A, rows: 3, seqLo: 1, seqHi: 3 });

      // Simulate rows vanishing WITHOUT any compaction-ledger entry (data
      // loss / corruption / a bug — never legitimate): delete directly from
      // the event-store mirror's own SQLite file via a separate connection,
      // bypassing applyCompactionReceipt entirely, so compacted_events stays
      // empty for this replica-day. The canonical JSONL shard is untouched.
      const dbPath = join(vaultRoot, '_BAC', 'connections', 'event-store.db');
      const { Database } = await import('bun:sqlite');
      // No options: bun:sqlite defaults to read-write on an existing file —
      // the ambient type declarations don't expose `readwrite` explicitly
      // (see sync/eventStore.ts's own local SqliteModule cast for the same
      // gap), so this stays on the typed default rather than casting.
      const raw = new Database(dbPath);
      try {
        raw.query('DELETE FROM events WHERE replica_id = ?').run(PEER);
      } finally {
        raw.close();
      }

      const secondPass = await runEventSealPass(vaultRoot, { now: () => NOW });
      expect(secondPass.errors).toEqual([]);
      expect(secondPass.sealed).toEqual([]);
      expect(secondPass.unexplainedZeroRowDays).toBe(1);

      // The stale seal is untouched — never silently healed into a false
      // empty-day seal.
      const manifest = await readSealManifest(vaultRoot);
      expect(manifest.latest.get(`${PEER} ${DAY_A}`)).toMatchObject({ rows: 3, seqLo: 1, seqHi: 3 });
      expect(manifest.latest.get(`${PEER} ${DAY_A}`)?.emptyDayCompactedRows).toBeUndefined();

      // Repeated passes keep reporting the same unexplained day — never
      // healed by attrition either.
      const thirdPass = await runEventSealPass(vaultRoot, { now: () => NOW });
      expect(thirdPass.sealed).toEqual([]);
      expect(thirdPass.unexplainedZeroRowDays).toBe(1);

      // hot-tail retirement keeps (correctly) reporting store-drift, not a
      // false-clean seal — the protective intent the pre-fix silence
      // happened to preserve by accident is preserved here on purpose.
      const report = await buildHotTailRetirementReport(vaultRoot, { now: () => NOW });
      const shardA = report.shards.find((s) => s.replica === PEER && s.day === DAY_A);
      expect(shardA?.verdict).toBe('store-drift');
      expect(shardA?.retirementEligible).toBe(false);
      expect(report.totals.storeDriftShards).toBe(1);
    },
  );
});
