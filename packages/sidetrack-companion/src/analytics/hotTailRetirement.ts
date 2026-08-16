// F2 — hot-tail retirement report (report-only).
// docs/design/2026-08-01-columnar-event-tier.md, "step (3)" payoff: once a
// day's events are sealed into the columnar tier and verify-green, the
// corresponding `_BAC/log/<replica>/<day>.jsonl` shard no longer needs to be
// READ or REWRITTEN — it can retire from the hot tail. That retirement
// (APPLY) is a separate, consent-gated PR behind a soak period
// (docs/plans/2026-08-15-foundation-program.md, F2 row). This module is the
// ELIGIBILITY REPORT only: zero writes, computes per (replica, day) shard
// whether retirement would be safe today, and — the actionable part — which
// closed days are NOT yet covered by a verified seal (the blockers).
//
// Design (F2 OLAP comparison, foundation-program.md): reuses the existing
// DuckDB-over-Parquet facade (`eventScan.ts`'s `readSealedParquetDayStats` +
// `entryMatches`) for the segment-vs-manifest proof — the same primitive
// `runSealIntegrityCheck` already runs continuously in production. This
// module does NOT call `runSealIntegrityCheck` directly for two reasons:
// (1) that function gates on `eventSealEnabled()` / `getCaughtUpSharedEventStore`
// (the live sealer's OWN env-armed, read-write path) — a report tool must
// read whatever is already on disk regardless of the CLI invocation's own
// env, never silently report "nothing" because a flag wasn't exported for
// this one process; (2) "must open stores readonly" (this module's own
// requirement, see `readEventStoreDayStatsReadonly` below) — the shared
// event store's `createEventStore` opens `{ readwrite: true }` for its own
// catch-up bookkeeping, which this report does not need and must not do.
//
// Compaction-aware by construction: this report reconciles seal coverage via
// the MANIFEST + PARQUET AGGREGATE + STORE DAY-STATS — never a raw JSONL
// scan. The one place a scan is unavoidable (byte-accounting: how large is
// each hot-tail shard file, right now) is a `stat()` per shard file
// (O(shard count), not O(events)) — not a line-by-line read. If a future
// need arose for a line-level compaction-aware proof, it belongs in the CLI
// (cold path allowed per F3's own carve-out), never a hot serving path; this
// report has no such need today.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  entryMatches,
  readSealedParquetDayStats,
  type ParquetDayStat,
} from './eventScan.js';
import { readSealManifest, sealSegmentPath, type SealManifestEntry } from './eventSeal.js';

const LOG_ROOT_SEGMENTS = ['_BAC', 'log'] as const;
const SHARD_NAME_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;

const eventLogRoot = (vaultRoot: string): string => join(vaultRoot, ...LOG_ROOT_SEGMENTS);
const shardPath = (vaultRoot: string, replica: string, day: string): string =>
  join(eventLogRoot(vaultRoot), replica, `${day}.jsonl`);
const eventStoreDbPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'connections', 'event-store.db');

export type ShardRetirementVerdict =
  /** Manifest, parquet, and the live store day-stats all agree — the day is
   *  provably safe to stop reading from the hot tail once APPLY ships. */
  | 'sealed-verified'
  /** Manifest+parquet agree with each other but the live store has moved
   *  (new arrivals since sealing, OR a compaction rewrite dropped rows the
   *  seal still counts) — benign, self-heals on the next sealer pass, but
   *  NOT retirement-eligible until re-sealed. */
  | 'store-drift'
  /** The parquet segment itself no longer matches its own manifest entry
   *  (truncated, rewritten, or unreadable). Never benign. */
  | 'segment-corrupt'
  /** Manifest names a segment whose file is gone. Never benign. */
  | 'segment-missing'
  /** A closed day with events (JSONL and/or the store) but no seal manifest
   *  entry at all — the day has never been sealed. */
  | 'never-sealed'
  /** Today (or a future-dated shard) — excluded, mirroring the sealer's own
   *  "never seal an open day" rule. */
  | 'open';

export interface HotTailShardReport {
  readonly replica: string;
  readonly day: string;
  readonly verdict: ShardRetirementVerdict;
  readonly detail: string;
  /** Rows the seal manifest records for this day; 0 when never sealed. */
  readonly eventsSealed: number;
  /** Live per-day row count from the readonly store mirror; null when the
   *  mirror is unavailable (SIDETRACK_EVENT_STORE never bootstrapped for
   *  this vault, or no `event-store.db` file on disk). */
  readonly eventsLive: number | null;
  /** max(0, eventsLive - eventsSealed) — new arrivals not yet covered by a
   *  seal. This is the "blocker" count: events in the hot tail no seal
   *  covers. Does not go negative on a compaction-driven shrink (that shows
   *  up as `store-drift`, not as "uncovered events" — nothing was added
   *  uncovered, rows were intentionally, receipt-proven removed). */
  readonly eventsUncovered: number;
  /** Current on-disk byte size of the hot-tail JSONL shard file; 0 if the
   *  file is already gone. */
  readonly jsonlBytes: number;
  /** True only for `sealed-verified` with zero uncovered events — the shard
   *  APPLY could retire today. */
  readonly retirementEligible: boolean;
}

export interface HotTailRetirementTotals {
  readonly shardsTotal: number;
  readonly shardsEligible: number;
  /** Sum of `jsonlBytes` over eligible shards only — what APPLY would
   *  reclaim from the hot tail's read/rewrite surface today. */
  readonly bytesRetirable: number;
  readonly eventsUncoveredTotal: number;
  /** segment-corrupt + segment-missing — the never-benign classes. */
  readonly segmentAlarms: number;
  readonly storeDriftShards: number;
  readonly neverSealedShards: number;
  readonly openShards: number;
}

export interface HotTailRetirementReport {
  readonly producedAt: string;
  readonly vaultRoot: string;
  readonly sealManifestPresent: boolean;
  readonly eventStoreMirrorPresent: boolean;
  readonly shards: readonly HotTailShardReport[];
  readonly totals: HotTailRetirementTotals;
}

interface ReadonlyStoreDayStats {
  readonly available: boolean;
  /** `${replica} ${day}` -> stats. Empty (not absent) when the mirror exists
   *  but has no rows, or does not exist at all. */
  readonly byKey: ReadonlyMap<string, { readonly rows: number; readonly seqLo: number; readonly seqHi: number }>;
}

interface SqliteRow {
  readonly [column: string]: unknown;
}

/**
 * Open the event-store mirror STRICTLY readonly (`{ readonly: true }`) and
 * read per-(replica, day) row counts in one query. Never creates the file,
 * never writes (no catch-up, no schema DDL) — safe to run alongside a live
 * companion that owns the SAME file read-write (WAL readers do not block on
 * a concurrent writer). When the file does not exist, or bun:sqlite fails to
 * open it, this degrades to `{ available: false }` rather than throwing —
 * the report must still produce useful manifest/JSONL-only output.
 */
const readEventStoreDayStatsReadonly = async (
  vaultRoot: string,
): Promise<ReadonlyStoreDayStats> => {
  const dbPath = eventStoreDbPath(vaultRoot);
  let db: { readonly query: (sql: string) => { readonly all: () => readonly unknown[] }; readonly close?: () => void };
  try {
    const { Database } = (await import('bun:sqlite')) as {
      readonly Database: new (
        filename: string,
        options: { readonly readonly: true },
      ) => typeof db;
    };
    db = new Database(dbPath, { readonly: true });
  } catch {
    return { available: false, byKey: new Map() };
  }
  try {
    const rows = db
      .query(
        `SELECT replica_id AS replica,
                strftime('%Y-%m-%d', accepted_at_ms / 1000, 'unixepoch') AS day,
                COUNT(*) AS n, MIN(seq) AS seq_lo, MAX(seq) AS seq_hi
           FROM events
          GROUP BY replica, day`,
      )
      .all();
    const byKey = new Map<string, { rows: number; seqLo: number; seqHi: number }>();
    for (const raw of rows) {
      const row = raw as SqliteRow;
      const replica = String(row['replica']);
      const day = String(row['day']);
      byKey.set(`${replica} ${day}`, {
        rows: Number(row['n']),
        seqLo: Number(row['seq_lo']),
        seqHi: Number(row['seq_hi']),
      });
    }
    return { available: true, byKey };
  } finally {
    db.close?.();
  }
};

const listReplicaDirs = async (root: string): Promise<readonly string[]> => {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
};

const listShardDays = async (dir: string): Promise<readonly string[]> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const days: string[] = [];
  for (const name of names) {
    const match = SHARD_NAME_RE.exec(name);
    if (match !== null) days.push(match[1] as string);
  }
  return days;
};

/** Every (replica, day) key with a hot-tail JSONL shard file on disk, plus a
 *  byte-size lookup — one `stat()` per shard, never a line read. */
const scanHotTailShards = async (
  vaultRoot: string,
): Promise<{
  readonly keys: ReadonlySet<string>;
  readonly bytesByKey: ReadonlyMap<string, number>;
}> => {
  const keys = new Set<string>();
  const bytesByKey = new Map<string, number>();
  const root = eventLogRoot(vaultRoot);
  for (const replica of await listReplicaDirs(root)) {
    for (const day of await listShardDays(join(root, replica))) {
      const key = `${replica} ${day}`;
      keys.add(key);
      try {
        const info = await stat(shardPath(vaultRoot, replica, day));
        bytesByKey.set(key, info.size);
      } catch {
        bytesByKey.set(key, 0);
      }
    }
  }
  return { keys, bytesByKey };
};

const splitKey = (key: string): { readonly replica: string; readonly day: string } => {
  const spaceIndex = key.indexOf(' ');
  return { replica: key.slice(0, spaceIndex), day: key.slice(spaceIndex + 1) };
};

const segmentExists = async (vaultRoot: string, replica: string, day: string): Promise<boolean> =>
  stat(sealSegmentPath(vaultRoot, replica, day))
    .then(() => true)
    .catch(() => false);

/**
 * Build the report-only hot-tail retirement eligibility report. Zero writes:
 * the event-store mirror is opened `{ readonly: true }` (never created, never
 * caught up); the sealed tier is read through DuckDB (`read_parquet`, no
 * writes possible); the hot-tail JSONL shards are only `stat()`'d, never
 * read. Safe to run against a vault a live companion is actively serving.
 */
export const buildHotTailRetirementReport = async (
  vaultRoot: string,
  options: { readonly now?: () => Date } = {},
): Promise<HotTailRetirementReport> => {
  const now = options.now ?? ((): Date => new Date());
  const today = now().toISOString().slice(0, 10);

  const manifest = await readSealManifest(vaultRoot);
  const manifestEntries = [...manifest.latest.values()];

  const [{ stats: parquetStats, unreadable }, storeStats, hotTail] = await Promise.all([
    manifestEntries.length > 0
      ? readSealedParquetDayStats(vaultRoot, manifestEntries)
      : Promise.resolve({ stats: new Map<string, ParquetDayStat>(), unreadable: new Set<string>() }),
    readEventStoreDayStatsReadonly(vaultRoot),
    scanHotTailShards(vaultRoot),
  ]);

  // Union of every key we have ANY evidence for: sealed (manifest), live in
  // the store mirror, or a hot-tail file still on disk.
  const allKeys = new Set<string>([
    ...manifest.latest.keys(),
    ...storeStats.byKey.keys(),
    ...hotTail.keys,
  ]);

  const shards: HotTailShardReport[] = [];
  for (const key of [...allKeys].sort()) {
    const { replica, day } = splitKey(key);
    const manifestEntry: SealManifestEntry | undefined = manifest.latest.get(key);
    const storeStat = storeStats.byKey.get(key);
    const jsonlBytes = hotTail.bytesByKey.get(key) ?? 0;
    const eventsSealed = manifestEntry?.rows ?? 0;
    const eventsLive = storeStat?.rows ?? null;

    if (day >= today) {
      shards.push({
        replica,
        day,
        verdict: 'open',
        detail: 'open day (today or future-dated) — never sealed or retired, mirrors the sealer',
        eventsSealed,
        eventsLive,
        eventsUncovered: 0,
        jsonlBytes,
        retirementEligible: false,
      });
      continue;
    }

    if (manifestEntry === undefined) {
      shards.push({
        replica,
        day,
        verdict: 'never-sealed',
        detail:
          eventsLive === null
            ? 'closed day with a hot-tail shard on disk, no seal manifest entry, event-store mirror unavailable to confirm row count'
            : 'closed day with events, no seal manifest entry — needs a sealer pass before it can retire',
        eventsSealed: 0,
        eventsLive,
        eventsUncovered: eventsLive ?? 0,
        jsonlBytes,
        retirementEligible: false,
      });
      continue;
    }

    if (unreadable.has(key)) {
      shards.push({
        replica,
        day,
        verdict: 'segment-corrupt',
        detail: 'segment file exists but is unreadable as parquet',
        eventsSealed,
        eventsLive,
        eventsUncovered: 0,
        jsonlBytes,
        retirementEligible: false,
      });
      continue;
    }

    const parquet = parquetStats.get(key);
    if (parquet === undefined) {
      const exists = await segmentExists(vaultRoot, replica, day);
      shards.push({
        replica,
        day,
        verdict: 'segment-missing',
        detail: exists
          ? 'segment file exists but yielded no rows'
          : 'manifest names a segment whose file is gone',
        eventsSealed,
        eventsLive,
        eventsUncovered: 0,
        jsonlBytes,
        retirementEligible: false,
      });
      continue;
    }

    if (!entryMatches(manifestEntry, parquet)) {
      shards.push({
        replica,
        day,
        verdict: 'segment-corrupt',
        detail: `parquet (n=${String(parquet.rows)} lo=${String(parquet.seqLo)} hi=${String(
          parquet.seqHi,
        )}) vs manifest (n=${String(manifestEntry.rows)} lo=${String(manifestEntry.seqLo)} hi=${String(
          manifestEntry.seqHi,
        )})`,
        eventsSealed,
        eventsLive,
        eventsUncovered: 0,
        jsonlBytes,
        retirementEligible: false,
      });
      continue;
    }

    if (storeStat === undefined || !entryMatches(manifestEntry, storeStat)) {
      const uncovered = storeStat === undefined ? 0 : Math.max(0, storeStat.rows - manifestEntry.rows);
      shards.push({
        replica,
        day,
        verdict: 'store-drift',
        detail:
          storeStat === undefined
            ? 'event-store mirror unavailable or has no rows for this day — cannot confirm live agreement'
            : `store rows=${String(storeStat.rows)} vs sealed rows=${String(
                manifestEntry.rows,
              )} — new arrivals or a compaction-driven shrink; benign, next sealer pass re-seals`,
        eventsSealed,
        eventsLive,
        eventsUncovered: uncovered,
        jsonlBytes,
        retirementEligible: false,
      });
      continue;
    }

    shards.push({
      replica,
      day,
      verdict: 'sealed-verified',
      detail: 'manifest, parquet, and live store agree — safe to retire once APPLY ships',
      eventsSealed,
      eventsLive,
      eventsUncovered: 0,
      jsonlBytes,
      retirementEligible: true,
    });
  }

  const totals: HotTailRetirementTotals = {
    shardsTotal: shards.length,
    shardsEligible: shards.filter((shard) => shard.retirementEligible).length,
    bytesRetirable: shards.reduce(
      (sum, shard) => sum + (shard.retirementEligible ? shard.jsonlBytes : 0),
      0,
    ),
    eventsUncoveredTotal: shards.reduce((sum, shard) => sum + shard.eventsUncovered, 0),
    segmentAlarms: shards.filter(
      (shard) => shard.verdict === 'segment-corrupt' || shard.verdict === 'segment-missing',
    ).length,
    storeDriftShards: shards.filter((shard) => shard.verdict === 'store-drift').length,
    neverSealedShards: shards.filter((shard) => shard.verdict === 'never-sealed').length,
    openShards: shards.filter((shard) => shard.verdict === 'open').length,
  };

  return {
    producedAt: now().toISOString(),
    vaultRoot,
    sealManifestPresent: manifest.latest.size > 0,
    eventStoreMirrorPresent: storeStats.available,
    shards,
    totals,
  };
};
