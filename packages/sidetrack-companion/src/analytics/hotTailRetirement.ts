// F2 — hot-tail retirement: eligibility report + consent-gated apply.
// docs/design/2026-08-01-columnar-event-tier.md, "step (3)" payoff: once a
// day's events are sealed into the columnar tier and verify-green, the
// corresponding `_BAC/log/<replica>/<day>.jsonl` shard no longer needs to be
// READ or REWRITTEN — it can retire from the hot tail. The top half of this
// module is the ELIGIBILITY REPORT: zero writes, computes per (replica, day)
// shard whether retirement would be safe today, and — the actionable part —
// which closed days are NOT yet covered by a verified seal (the blockers).
// The bottom half ("F2 APPLY") is the consent-gated destructive step,
// unlocked after the soak period the report call above named
// (docs/plans/2026-08-15-foundation-program.md, F2 row): it MOVES (never
// deletes) each still-eligible shard to a sibling retired mirror.
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

import { appendFile, mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { sha256File } from '../gc/engagementCompactionManifest.js';
import { writeFileAtomic } from '../vault/atomic.js';
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

// F2 APPLY (this module's counterpart to the report above). Retirement
// MOVES an eligible day's hot-tail shard to a sibling mirror tree —
// `_BAC/retired/log/<replica>/<day>.jsonl` — NEVER deletes. History for a
// retired day stays served by two sources already required
// 'sealed-verified' before a day is ever eligible: the typed event-store
// mirror (F3's hot read source) and the sealed Parquet segment
// (eventSeal.ts). `_BAC/retired` is a SIBLING of `_BAC/log`, not a
// subdirectory of it, so every walker that discovers shards by listing
// `_BAC/log` (eventLog.ts's readMerged/readReplica/listReplicaIds, this
// module's own scanHotTailShards below, compactionPlanner.ts,
// engagementCompactionManifest.ts, connectionsMaterializer.ts — the last
// out of bounds and untouched) excludes the retired tree BY CONSTRUCTION,
// not by an added filter — verified by grepping every `_BAC/log` walker in
// the package. `eventLog.ts`'s readers already tolerate an absent day file
// (readLogFile / readReplica ENOENT -> []), so a retired day simply stops
// appearing in readMerged() — exactly the intended F3 handoff ("the typed
// store mirror is the hot read source, sealed Parquet covers history").
//
// TWO existing readers were found that DO need a fix, because their own
// proofs reconstruct "the complete canonical event set" by walking
// `_BAC/log` directly rather than reading the live store/manifest:
// `gc/storageRetirement.ts`'s event-store-mirror retirement proof and
// `gc/ingressRetention.ts`'s ingress-spool-day proof (both wired into the
// live `gc --storage-retirement` CLI command). Without a fix, the first
// F2-retired day would make both proofs see fewer canonical events than
// exist and (correctly, FAIL CLOSED) refuse candidates they used to
// verify — no data-loss risk, but a real regression of an already-shipped
// feature. Fixed by `listCanonicalEventShards` below, which both modules
// now call instead of each hand-rolling a `_BAC/log`-only shard walk.
//
// A THIRD reader family — `rebuildFromJsonl(logRoot)` / `catchUpFromJsonl
// (logRoot)` on 7 typed stores (event store, engagement-facts,
// timeline-facts, search-query-index, capture-text-fts, thread-register,
// workstream-parent) — also only walks the single `logRoot` it is handed.
// `grep -rn '\.rebuildFromJsonl\('` across the package (excluding tests)
// found ZERO production call sites today, so there is no LIVE regression.
// But `sync/lineage.ts` documents `rebuildFromJsonl` as each store's
// cold-repair entrypoint; a future wiring (or an operator invoking one by
// hand) that reads only `_BAC/log` would silently miss any already-
// retired day. Flagged here and in `sync/lineage.ts`'s `event-log` node
// rather than fixed speculatively across 7 unwired modules: if any of
// these gets a real call site, it must catch up from BOTH roots, RETIRED
// FIRST (these stores gate re-ingestion of a seq at/below their own
// per-replica watermark as "out of order", so ingesting the newer hot root
// first would cause the older retired root's rows to be skipped).

const RETIRED_LOG_ROOT_SEGMENTS = ['_BAC', 'retired', 'log'] as const;

export const retiredEventLogRoot = (vaultRoot: string): string =>
  join(vaultRoot, ...RETIRED_LOG_ROOT_SEGMENTS);
export const retiredShardPath = (vaultRoot: string, replica: string, day: string): string =>
  join(retiredEventLogRoot(vaultRoot), replica, `${day}.jsonl`);

/**
 * Every canonical event-log shard path across BOTH the hot tail
 * (`_BAC/log`) and the F2-retired mirror (`_BAC/retired/log`) — the
 * complete on-disk canonical event set regardless of retirement state.
 * Shared by `storageRetirement.ts` and `ingressRetention.ts` so their
 * canonical-readback proofs stay correct once any day retires. This
 * module's OWN report/apply logic deliberately does not use this — it
 * needs to distinguish hot-vs-retired, not merge them.
 */
export const listCanonicalEventShards = async (vaultRoot: string): Promise<readonly string[]> => {
  const paths: string[] = [];
  for (const root of [eventLogRoot(vaultRoot), retiredEventLogRoot(vaultRoot)]) {
    for (const replica of await listReplicaDirs(root)) {
      const dir = join(root, replica);
      let names: readonly string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of [...names].sort()) {
        if (name.endsWith('.jsonl')) paths.push(join(dir, name));
      }
    }
  }
  return paths;
};

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

// ===========================================================================
// F2 APPLY
// ===========================================================================

/**
 * Is the destructive apply armed? Defaults OFF, same posture as
 * `compactionPlanner.ts`'s `engagementCompactArmed` — moving hot-tail
 * shards out of `_BAC/log` must be opted into explicitly, in addition to
 * `--apply` itself and the CLI's own recall process-lock check.
 */
export const hotTailRetireArmed = (): boolean => {
  const raw = process.env['SIDETRACK_HOT_TAIL_RETIRE'];
  return raw === '1' || raw === 'true';
};

const RETIREMENT_RECEIPTS_RELATIVE_PATH = ['_BAC', 'system', 'retirement-receipts.jsonl'] as const;
/** Bounded, same idiom as `attribution-v1/shadow.ts`'s on-disk shadow log:
 *  append, then rewrite-truncate the tail once the cap is crossed. */
export const RETIREMENT_RECEIPTS_MAX_LINES = 20_000;

export const retirementReceiptsPath = (vaultRoot: string): string =>
  join(vaultRoot, ...RETIREMENT_RECEIPTS_RELATIVE_PATH);

export interface HotTailRetirementReceipt {
  readonly schemaVersion: 1;
  readonly replica: string;
  readonly day: string;
  readonly beforeBytes: number;
  readonly beforeSha256: string;
  /** Equal to beforeBytes/beforeSha256 by construction: a same-filesystem
   *  `rename()` cannot change file content, only its directory entry, so
   *  re-hashing the destination would be pure overhead — recorded anyway
   *  for a receipt schema that reads naturally as "before/after". */
  readonly afterBytes: number;
  readonly afterSha256: string;
  readonly eventsSealed: number;
  readonly eventsLive: number | null;
  readonly movedAt: string;
}

export type HotTailRetirementSkipReason =
  /** Verdict was not `sealed-verified` in THIS run's fresh report — the
   *  per-shard fail-closed gate. */
  | 'not-eligible'
  /** Eligible, but there is nothing on disk to move (already-empty shard
   *  accounting, or the file vanished between the report and the move). */
  | 'source-absent'
  /** Both the hot shard AND its retired destination exist — a late peer
   *  arrival re-opened this day's hot shard after an earlier retirement
   *  (see eventSeal.ts's "late arrivals... re-sealed" note). A rename
   *  would silently OVERWRITE the previously-retired bulk file, which
   *  this feature must never do. Left exactly as found; needs a
   *  deliberate reconcile pass, not a blind move. */
  | 'retired-destination-exists'
  /** The move itself failed (I/O error, cross-device rename, a post-move
   *  size mismatch) — the source is left untouched (rename either fully
   *  succeeds or doesn't happen at all). */
  | 'move-failed';

export interface HotTailRetirementShardOutcome {
  readonly replica: string;
  readonly day: string;
  readonly verdict: ShardRetirementVerdict;
  readonly outcome: 'moved' | 'already-retired' | 'skipped';
  readonly reason?: HotTailRetirementSkipReason;
  readonly bytes: number;
}

export interface HotTailRetirementApplyResult {
  readonly vaultRoot: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** Newly moved THIS run. */
  readonly shardsRetired: number;
  /** Already retired by an earlier (possibly crashed) run — idempotent
   *  no-op successes, counted separately from `shardsRetired` so a
   *  second run visibly reports "nothing new happened" rather than
   *  reclaiming credit for work a prior run already did. */
  readonly shardsAlreadyRetired: number;
  readonly shardsSkipped: number;
  readonly bytesMoved: number;
  readonly outcomes: readonly HotTailRetirementShardOutcome[];
  readonly receiptPath: string;
  readonly errors: readonly string[];
}

const truncateReceiptsLog = async (path: string): Promise<void> => {
  const raw = await readFile(path, 'utf8').catch(() => '');
  if (raw.length === 0) return;
  const lines = raw.split('\n').filter((line) => line.length > 0);
  if (lines.length <= RETIREMENT_RECEIPTS_MAX_LINES) return;
  const kept = lines.slice(lines.length - RETIREMENT_RECEIPTS_MAX_LINES);
  await writeFileAtomic(path, `${kept.join('\n')}\n`);
};

/** Append receipts and enforce the bounded tail. No-op (returns the path
 *  without touching disk) when there is nothing to record. */
const appendReceipts = async (
  vaultRoot: string,
  records: readonly HotTailRetirementReceipt[],
): Promise<string> => {
  const path = retirementReceiptsPath(vaultRoot);
  if (records.length === 0) return path;
  await mkdir(dirname(path), { recursive: true });
  const body = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  await appendFile(path, body, 'utf8');
  await truncateReceiptsLog(path);
  return path;
};

/**
 * Apply hot-tail retirement: MOVE (never delete) every shard this run's
 * OWN fresh eligibility computation confirms `sealed-verified` from
 * `_BAC/log/<replica>/<day>.jsonl` to `_BAC/retired/log/<replica>/<day>.jsonl`.
 *
 * RE-VALIDATES EVERY PROOF AT APPLY TIME: builds a brand-new
 * `buildHotTailRetirementReport` rather than trusting any report the
 * caller already has — a seal tampered, a store drifted, or a manifest
 * gone stale since an earlier `--report` run all show up here as a fresh
 * verdict, and only that fresh verdict gates the move. FAIL CLOSED PER
 * SHARD: one shard's drift skips only that shard, matching
 * `compactionPlanner.ts`'s apply posture — a vault with one tampered seal
 * still retires every other eligible day in the same run.
 *
 * CRASH-SAFE: each shard's move is one same-filesystem `rename()`, atomic
 * by construction (a shard is either fully hot or fully retired, never
 * torn). A crash mid-run leaves some shards retired and some not — both
 * are valid states. Re-running this function resumes correctly: a shard
 * already moved (source absent, destination present) is reported
 * `already-retired` and skipped, not re-attempted or treated as an error.
 */
export const applyHotTailRetirement = async (
  vaultRoot: string,
  options: { readonly now?: () => Date } = {},
): Promise<HotTailRetirementApplyResult> => {
  const now = options.now ?? ((): Date => new Date());
  const startedAt = now().toISOString();

  const report = await buildHotTailRetirementReport(vaultRoot, options);

  const outcomes: HotTailRetirementShardOutcome[] = [];
  const receipts: HotTailRetirementReceipt[] = [];
  const errors: string[] = [];
  let shardsRetired = 0;
  let shardsAlreadyRetired = 0;
  let shardsSkipped = 0;
  let bytesMoved = 0;

  const skip = (
    shard: HotTailShardReport,
    reason: HotTailRetirementSkipReason,
    message?: string,
  ): void => {
    shardsSkipped += 1;
    outcomes.push({
      replica: shard.replica,
      day: shard.day,
      verdict: shard.verdict,
      outcome: 'skipped',
      reason,
      bytes: 0,
    });
    if (message !== undefined) errors.push(message);
  };

  for (const shard of report.shards) {
    if (!shard.retirementEligible) {
      // 'open' days (today / future-dated) are excluded entirely — noise,
      // never a real skip, mirroring the report's own blocker filter.
      if (shard.verdict !== 'open') skip(shard, 'not-eligible');
      continue;
    }

    const src = shardPath(vaultRoot, shard.replica, shard.day);
    const dest = retiredShardPath(vaultRoot, shard.replica, shard.day);
    const [srcInfo, destInfo] = await Promise.all([
      stat(src).catch(() => null),
      stat(dest).catch(() => null),
    ]);

    if (srcInfo === null && destInfo !== null) {
      // Already retired by an earlier (possibly crashed) run.
      shardsAlreadyRetired += 1;
      outcomes.push({
        replica: shard.replica,
        day: shard.day,
        verdict: shard.verdict,
        outcome: 'already-retired',
        bytes: destInfo.size,
      });
      continue;
    }

    if (srcInfo === null && destInfo === null) {
      skip(shard, 'source-absent');
      continue;
    }

    if (srcInfo !== null && destInfo !== null) {
      skip(
        shard,
        'retired-destination-exists',
        `${shard.replica}/${shard.day}: retired destination already exists — refusing to overwrite, needs a manual reconcile pass`,
      );
      continue;
    }

    // Normal case: src exists, dest does not. Move it.
    const info = srcInfo as NonNullable<typeof srcInfo>;
    try {
      const beforeSha256 = await sha256File(src);
      await mkdir(dirname(dest), { recursive: true });
      await rename(src, dest);
      const after = await stat(dest);
      if (after.size !== info.size) {
        throw new Error(`post-rename size mismatch: before=${String(info.size)} after=${String(after.size)}`);
      }
      bytesMoved += info.size;
      shardsRetired += 1;
      receipts.push({
        schemaVersion: 1,
        replica: shard.replica,
        day: shard.day,
        beforeBytes: info.size,
        beforeSha256,
        afterBytes: after.size,
        afterSha256: beforeSha256,
        eventsSealed: shard.eventsSealed,
        eventsLive: shard.eventsLive,
        movedAt: now().toISOString(),
      });
      outcomes.push({
        replica: shard.replica,
        day: shard.day,
        verdict: shard.verdict,
        outcome: 'moved',
        bytes: info.size,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skip(shard, 'move-failed', `${shard.replica}/${shard.day}: ${message}`);
    }
  }

  const receiptPath = await appendReceipts(vaultRoot, receipts);

  return {
    vaultRoot,
    startedAt,
    finishedAt: now().toISOString(),
    shardsRetired,
    shardsAlreadyRetired,
    shardsSkipped,
    bytesMoved,
    outcomes,
    receiptPath,
    errors,
  };
};
