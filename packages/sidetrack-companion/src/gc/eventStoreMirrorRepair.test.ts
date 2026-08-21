import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import { createEventLog } from '../sync/eventLog.js';
import { createEventStore } from '../sync/eventStore.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import {
  discoverEventStoreMirrorRepairCandidates,
  eventStoreRepairArmed,
  repairEventStoreMirrorDays,
} from './eventStoreMirrorRepair.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const PEER = 'peer-repair';
const DAY_A = '2026-06-15';
const DAY_B = '2026-06-16';

const peerEvent = (seq: number, day: string): AcceptedEvent => ({
  clientEventId: `${PEER}.${String(seq)}.thread.upserted`,
  dot: { replicaId: PEER, seq },
  deps: {},
  aggregateId: `T${String(seq)}`,
  type: 'thread.upserted',
  payload: { bac_id: `T${String(seq)}`, title: `Thread ${String(seq)}` },
  acceptedAtMs: Date.parse(`${day}T10:00:00.000Z`) + seq,
});

interface SqliteStatement {
  readonly run: (...params: readonly unknown[]) => unknown;
  readonly get: (...params: readonly unknown[]) => unknown;
}
interface SqliteDb {
  readonly query: (sql: string) => SqliteStatement;
  readonly close: () => void;
}

const loadDatabase = async (): Promise<new (path: string) => SqliteDb> => {
  const module = (await import('bun:sqlite')) as { readonly Database: new (path: string) => SqliteDb };
  return module.Database;
};

const dayBoundsMs = (day: string): { readonly lo: number; readonly hi: number } => {
  const lo = Date.parse(`${day}T00:00:00.000Z`);
  return { lo, hi: lo + 86_400_000 - 1 };
};

describe('eventStoreRepairArmed', () => {
  let prior: string | undefined;

  beforeEach(() => {
    prior = process.env['SIDETRACK_EVENT_STORE_REPAIR'];
    delete process.env['SIDETRACK_EVENT_STORE_REPAIR'];
  });

  afterEach(() => {
    if (prior === undefined) delete process.env['SIDETRACK_EVENT_STORE_REPAIR'];
    else process.env['SIDETRACK_EVENT_STORE_REPAIR'] = prior;
  });

  it('defaults OFF and only arms on an explicit 1/true', () => {
    expect(eventStoreRepairArmed()).toBe(false);
    process.env['SIDETRACK_EVENT_STORE_REPAIR'] = 'yes-please';
    expect(eventStoreRepairArmed()).toBe(false);
    process.env['SIDETRACK_EVENT_STORE_REPAIR'] = '1';
    expect(eventStoreRepairArmed()).toBe(true);
    process.env['SIDETRACK_EVENT_STORE_REPAIR'] = 'true';
    expect(eventStoreRepairArmed()).toBe(true);
  });
});

describe('event-store mirror day repair', () => {
  let vaultRoot = '';

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-mirror-repair-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  // Seeds two days' canonical JSONL via a real EventLog (peer-imported, so
  // dots/seq land deterministically), then fully catches up the mirror on
  // BOTH days — the "everything was fine at some point" precondition.
  const seedTwoDaysFullyCaughtUp = async (): Promise<void> => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (let seq = 1; seq <= 5; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_A));
    for (let seq = 6; seq <= 9; seq += 1) await eventLog.importPeerEvent(peerEvent(seq, DAY_B));
    const store = await createEventStore(vaultRoot);
    await store.catchUpFromJsonl(join(vaultRoot, '_BAC', 'log'));
    store.close();
  };

  // Simulates the real reported condition: the canonical JSONL is untouched,
  // but the mirror's rows for one specific day are gone (F1 compaction
  // rewriting a day after the mirror's ingest watermark had already passed
  // it, per this module's own header rationale) — a raw DELETE against the
  // mirror is the most direct, assumption-free way to reproduce "the mirror
  // genuinely has zero rows for this day" without depending on
  // catchUpFromJsonl's shard_progress internals.
  const deleteMirrorRowsForDay = async (day: string): Promise<void> => {
    const Database = await loadDatabase();
    const dbPath = join(vaultRoot, '_BAC', 'connections', 'event-store.db');
    const db = new Database(dbPath);
    try {
      const { lo, hi } = dayBoundsMs(day);
      db.query('DELETE FROM events WHERE replica_id = ? AND accepted_at_ms BETWEEN ? AND ?').run(
        PEER,
        lo,
        hi,
      );
    } finally {
      db.close();
    }
  };

  const mirrorRowCountForDay = async (day: string): Promise<number> => {
    const Database = await loadDatabase();
    const dbPath = join(vaultRoot, '_BAC', 'connections', 'event-store.db');
    const db = new Database(dbPath);
    try {
      const { lo, hi } = dayBoundsMs(day);
      const row = db
        .query('SELECT COUNT(*) AS n FROM events WHERE replica_id = ? AND accepted_at_ms BETWEEN ? AND ?')
        .get(PEER, lo, hi) as { readonly n: number };
      return row.n;
    } finally {
      db.close();
    }
  };

  sqliteIt(
    'repairs a day whose mirror has zero rows (default discovery), and leaves the other day untouched',
    async () => {
      await seedTwoDaysFullyCaughtUp();
      expect(await mirrorRowCountForDay(DAY_A)).toBe(5);
      expect(await mirrorRowCountForDay(DAY_B)).toBe(4);

      await deleteMirrorRowsForDay(DAY_A);
      expect(await mirrorRowCountForDay(DAY_A)).toBe(0);

      const result = await repairEventStoreMirrorDays(vaultRoot);

      expect(result.errors).toEqual([]);
      expect(result.candidatesConsidered).toBe(1);
      expect(result.outcomes).toHaveLength(1);
      const outcome = result.outcomes[0];
      expect(outcome).toMatchObject({
        replica: PEER,
        day: DAY_A,
        canonicalEvents: 5,
        malformedLines: 0,
        rowsBefore: 0,
        rowsAfter: 5,
      });
      expect(result.totals).toMatchObject({
        daysConsidered: 1,
        daysRepaired: 1,
        daysAlreadyOk: 0,
        rowsInsertedTotal: 5,
        malformedLinesTotal: 0,
      });

      // Repaired day's mirror rows match the canonical count again.
      expect(await mirrorRowCountForDay(DAY_A)).toBe(5);
      // The untouched day's rows are exactly as they were — never re-read
      // or re-written.
      expect(await mirrorRowCountForDay(DAY_B)).toBe(4);
    },
  );

  sqliteIt('is idempotent: an explicit re-run on an already-repaired day changes nothing', async () => {
    await seedTwoDaysFullyCaughtUp();
    await deleteMirrorRowsForDay(DAY_A);

    const first = await repairEventStoreMirrorDays(vaultRoot);
    expect(first.totals.rowsInsertedTotal).toBe(5);
    expect(await mirrorRowCountForDay(DAY_A)).toBe(5);

    // Default discovery now finds zero candidates — the mirror is healthy
    // again, so there is nothing left for the zero-rows heuristic to find.
    const secondDefault = await repairEventStoreMirrorDays(vaultRoot);
    expect(secondDefault.candidatesConsidered).toBe(0);
    expect(secondDefault.outcomes).toEqual([]);

    // Forcing the SAME day explicitly proves the underlying ingestion path
    // itself (not just the discovery filter) is idempotent: re-ingesting
    // events that are already present changes nothing.
    const secondExplicit = await repairEventStoreMirrorDays(vaultRoot, { replica: PEER, day: DAY_A });
    expect(secondExplicit.errors).toEqual([]);
    expect(secondExplicit.candidatesConsidered).toBe(1);
    const outcome = secondExplicit.outcomes[0];
    expect(outcome).toMatchObject({
      canonicalEvents: 5,
      rowsBefore: 5,
      rowsAfter: 5,
    });
    expect(secondExplicit.totals).toMatchObject({ daysRepaired: 0, daysAlreadyOk: 1, rowsInsertedTotal: 0 });
    expect(await mirrorRowCountForDay(DAY_A)).toBe(5);
  });

  sqliteIt(
    'malformed lines are counted and skipped, without blocking the day\'s valid events from repairing',
    async () => {
      await seedTwoDaysFullyCaughtUp();
      await deleteMirrorRowsForDay(DAY_A);

      const shardPath = join(vaultRoot, '_BAC', 'log', PEER, `${DAY_A}.jsonl`);
      const { readFile } = await import('node:fs/promises');
      const original = await readFile(shardPath, 'utf8');
      await writeFile(shardPath, `${original}not-json-at-all\n{"also":"not-an-accepted-event"}\n`, 'utf8');

      const result = await repairEventStoreMirrorDays(vaultRoot, { replica: PEER, day: DAY_A });

      expect(result.errors).toEqual([]);
      const outcome = result.outcomes[0];
      expect(outcome).toMatchObject({ canonicalEvents: 5, malformedLines: 2, rowsBefore: 0, rowsAfter: 5 });
      expect(await mirrorRowCountForDay(DAY_A)).toBe(5);
    },
  );

  sqliteIt('repairs a day that was already F2-retired (_BAC/retired/log), via listCanonicalEventShards', async () => {
    await seedTwoDaysFullyCaughtUp();
    await deleteMirrorRowsForDay(DAY_A);

    // Simulate retire-hot-tail --apply having already moved this day's
    // shard out of the hot tail before the store-drift was noticed.
    const hotPath = join(vaultRoot, '_BAC', 'log', PEER, `${DAY_A}.jsonl`);
    const retiredPath = join(vaultRoot, '_BAC', 'retired', 'log', PEER, `${DAY_A}.jsonl`);
    await mkdir(join(vaultRoot, '_BAC', 'retired', 'log', PEER), { recursive: true });
    await rename(hotPath, retiredPath);

    const result = await repairEventStoreMirrorDays(vaultRoot);

    expect(result.errors).toEqual([]);
    expect(result.candidatesConsidered).toBe(1);
    const outcome = result.outcomes[0];
    if (outcome === undefined) throw new Error('expected exactly one repair outcome');
    expect(outcome).toMatchObject({ day: DAY_A, canonicalEvents: 5, rowsBefore: 0, rowsAfter: 5 });
    expect(outcome.shardPaths).toEqual([retiredPath]);
    expect(await mirrorRowCountForDay(DAY_A)).toBe(5);
  });

  sqliteIt('discovery filter correctness: default, --replica, --day, and --replica+--day', async () => {
    await seedTwoDaysFullyCaughtUp();
    await deleteMirrorRowsForDay(DAY_A);

    const store = await createEventStore(vaultRoot);
    try {
      const byDefault = await discoverEventStoreMirrorRepairCandidates(vaultRoot, store);
      expect(byDefault).toHaveLength(1);
      expect(byDefault[0]).toMatchObject({ replica: PEER, day: DAY_A });

      // --replica alone bypasses the zero-rows filter (explicit intent):
      // both days for this replica come back, even though DAY_B has rows.
      const byReplica = await discoverEventStoreMirrorRepairCandidates(vaultRoot, store, { replica: PEER });
      expect(byReplica.map((c) => c.day).sort()).toEqual([DAY_A, DAY_B]);

      // --day alone: only the matching day, across whichever replicas have
      // a canonical shard for it.
      const byDay = await discoverEventStoreMirrorRepairCandidates(vaultRoot, store, { day: DAY_B });
      expect(byDay.map((c) => c.replica)).toEqual([PEER]);
      expect(byDay.map((c) => c.day)).toEqual([DAY_B]);

      // Both together: exactly one candidate.
      const byBoth = await discoverEventStoreMirrorRepairCandidates(vaultRoot, store, {
        replica: PEER,
        day: DAY_A,
      });
      expect(byBoth).toHaveLength(1);

      // A filter matching no canonical shard: empty, not an error.
      const byMiss = await discoverEventStoreMirrorRepairCandidates(vaultRoot, store, {
        replica: PEER,
        day: '2099-01-01',
      });
      expect(byMiss).toEqual([]);
    } finally {
      store.close();
    }
  });

  sqliteIt('is a clean no-op on a vault with no canonical shards at all', async () => {
    const result = await repairEventStoreMirrorDays(vaultRoot);
    expect(result.errors).toEqual([]);
    expect(result.candidatesConsidered).toBe(0);
    expect(result.outcomes).toEqual([]);
    expect(result.totals).toMatchObject({
      daysConsidered: 0,
      daysRepaired: 0,
      daysAlreadyOk: 0,
      rowsInsertedTotal: 0,
      malformedLinesTotal: 0,
    });
  });
});
