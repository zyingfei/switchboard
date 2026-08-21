// Columnar event tier, stage 2: the scan facade.
// docs/design/2026-08-01-columnar-event-tier.md
//
// One module owning the only DuckDB connection over sealed segments. This
// stage ships the facade plus its first PRODUCTION consumer: a sealed-vs-
// store integrity A/B that runs after every sealer pass. The design gates
// any future store shrink ("hot-tail-only retirement") on seals being
// verify-green over a soak period — this module IS that verification,
// continuous and surfaced through hygiene status rather than a one-off
// audit.
//
// Verdict semantics per sealed (replica, day):
// - match           — manifest, parquet aggregate, and live store day-stats
//                     all agree. The seal is serving-grade.
// - store-drift     — the STORE no longer matches the manifest (late peer
//                     arrival or gap-fill since sealing). Benign: the next
//                     sealer pass re-seals the day; scans must use the store
//                     for this day until then.
// - segment-corrupt — the parquet no longer matches ITS OWN manifest entry.
//                     Never benign: the file was truncated, rewritten, or
//                     the write path lied. Surfaced as an alarm count.
// - segment-missing — manifest names a segment whose file is gone.
//
// EMPTY-DAY SEALS (`entry.rows === 0`, eventSeal.ts's sealEmptyDay) are a
// distinct case handled up front, before the parquet lookup: they carry no
// segment file by design (a zero-row parquet file would be invisible to the
// GROUP BY above, which reports no row at all for an empty group — not a
// zero-count one), so routing them through the parquet cross-check would
// misfire `segment-missing`. Verified against the live store instead: zero
// rows there too is `match`, any rows is `store-drift` (benign — the day
// reopened after the empty seal and the next sealer pass re-seals it).
//
// The facade never reads the canonical JSONL log and never blocks serving:
// DuckDB runs queries off the JS thread, the instance is closed after every
// call, and the whole check is one aggregate over all segments (~30ms
// measured on a 273k-event vault).

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { getCaughtUpSharedEventStore } from '../sync/eventStore.js';
import {
  eventSealEnabled,
  readSealManifest,
  sealRoot,
  sealSegmentPath,
  type SealManifestEntry,
} from './eventSeal.js';

export interface SealIntegrityDayVerdict {
  readonly replica: string;
  readonly day: string;
  readonly verdict: 'match' | 'store-drift' | 'segment-corrupt' | 'segment-missing';
  readonly detail: string;
}

export interface SealIntegrityReport {
  readonly checkedDays: number;
  readonly matches: number;
  readonly storeDrift: number;
  /** segment-corrupt + segment-missing — the never-benign classes. */
  readonly segmentAlarms: readonly SealIntegrityDayVerdict[];
  readonly producedAt: string;
}

const sqlPath = (path: string): string => path.replaceAll("'", "''");

export interface ParquetDayStat {
  readonly rows: number;
  readonly seqLo: number;
  readonly seqHi: number;
}

export interface ParquetScanResult {
  readonly stats: Map<string, ParquetDayStat>;
  /** `${replica} ${day}` keys whose segment file could not be read at all. */
  readonly unreadable: Set<string>;
}

const DAY_STATS_SQL = (source: string): string =>
  `SELECT replica_id AS replica,
          strftime(make_timestamp(accepted_at_ms * 1000), '%Y-%m-%d') AS day,
          COUNT(*)::BIGINT AS n, MIN(seq)::BIGINT AS lo, MAX(seq)::BIGINT AS hi
     FROM read_parquet('${sqlPath(source)}')
    GROUP BY replica, day`;

const collectRows = (
  rows: readonly { replica?: unknown; day?: unknown; n?: unknown; lo?: unknown; hi?: unknown }[],
  into: Map<string, ParquetDayStat>,
): void => {
  for (const row of rows) {
    into.set(`${String(row.replica)} ${String(row.day)}`, {
      rows: Number(row.n),
      seqLo: Number(row.lo),
      seqHi: Number(row.hi),
    });
  }
};

/**
 * Aggregate every sealed segment, grouped by (replica, UTC day). Fast path is
 * ONE query over the glob; DuckDB throws on the first unreadable file, which
 * would let a single corrupt segment hide every healthy one — so on failure,
 * degrade to per-entry queries and report the throwers as unreadable.
 *
 * Exported (not just `runSealIntegrityCheck`-internal) so other read-only
 * consumers of the sealed tier — `analytics/hotTailRetirement.ts`'s
 * retirement-eligibility report — reuse the SAME DuckDB-over-Parquet read
 * instead of a second bespoke implementation (F2 OLAP comparison, this
 * file's design doc: DuckDB-over-Parquet is the proven fast path; a raw
 * JSONL/bespoke scan measured slower even for the sealer's own PoC).
 */
export const readSealedParquetDayStats = async (
  vaultRoot: string,
  entries: readonly SealManifestEntry[],
): Promise<ParquetScanResult> => {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const stats = new Map<string, ParquetDayStat>();
    const unreadable = new Set<string>();
    try {
      const glob = join(sealRoot(vaultRoot), '*', '*.parquet');
      const reader = await connection.runAndReadAll(DAY_STATS_SQL(glob));
      collectRows(reader.getRowObjects() as never, stats);
      return { stats, unreadable };
    } catch {
      /* fall through to the per-file isolation pass */
    }
    for (const entry of entries) {
      const path = sealSegmentPath(vaultRoot, entry.replica, entry.day);
      try {
        const reader = await connection.runAndReadAll(DAY_STATS_SQL(path));
        collectRows(reader.getRowObjects() as never, stats);
      } catch {
        unreadable.add(`${entry.replica} ${entry.day}`);
      }
    }
    return { stats, unreadable };
  } finally {
    connection.closeSync();
  }
};

/** Exported for reuse by `hotTailRetirement.ts` — one comparison contract
 *  shared by both the integrity A/B and the retirement-eligibility gate. */
export const entryMatches = (
  entry: SealManifestEntry,
  other: { readonly rows: number; readonly seqLo: number; readonly seqHi: number },
): boolean =>
  entry.rows === other.rows && entry.seqLo === other.seqLo && entry.seqHi === other.seqHi;

/**
 * Compare every manifest-covered (replica, day) against the parquet segments
 * and the live store. Read-only; null when the tier is off, unsealed, or the
 * store is unavailable.
 */
export const runSealIntegrityCheck = async (
  vaultRoot: string,
  options: { readonly now?: () => Date } = {},
): Promise<SealIntegrityReport | null> => {
  if (!eventSealEnabled()) return null;
  const manifest = await readSealManifest(vaultRoot);
  if (manifest.latest.size === 0) return null;
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) return null;

  const { stats: parquetStats, unreadable } = await readSealedParquetDayStats(vaultRoot, [
    ...manifest.latest.values(),
  ]);
  const storeStatsByReplica = new Map<
    string,
    Map<string, { rows: number; seqLo: number; seqHi: number }>
  >();
  const storeDayStats = (replica: string, day: string) => {
    let byDay = storeStatsByReplica.get(replica);
    if (byDay === undefined) {
      byDay = new Map(
        store.sealDayStats(replica).map((s) => [s.day, { rows: s.rows, seqLo: s.seqLo, seqHi: s.seqHi }]),
      );
      storeStatsByReplica.set(replica, byDay);
    }
    return byDay.get(day);
  };

  let matches = 0;
  let storeDrift = 0;
  const segmentAlarms: SealIntegrityDayVerdict[] = [];
  for (const entry of manifest.latest.values()) {
    const key = `${entry.replica} ${entry.day}`;
    if (entry.rows === 0) {
      // Empty-day seal (eventSeal.ts's sealEmptyDay): every retained row for
      // this day was legitimately compacted, verified against the
      // compaction ledger BEFORE the seal was written. There is no parquet
      // segment for it by design (a physically empty file would be invisible
      // to the GROUP-BY-over-glob query above — no rows means no group at
      // all — so empty-day entries are never routed through the parquet
      // cross-check). The only live check that still applies: does the
      // store still agree the day has zero rows?
      const storeStat = storeDayStats(entry.replica, entry.day);
      if (storeStat === undefined) {
        matches += 1;
      } else {
        // A new peer dot re-opened this day after the empty-day seal —
        // benign, same as any other drift; the sealer re-seals it normally.
        storeDrift += 1;
      }
      continue;
    }
    if (unreadable.has(key)) {
      segmentAlarms.push({
        replica: entry.replica,
        day: entry.day,
        verdict: 'segment-corrupt',
        detail: 'segment file exists but is unreadable as parquet',
      });
      continue;
    }
    const parquet = parquetStats.get(key);
    if (parquet === undefined) {
      // Distinguish "file gone" from "file unreadable/empty" for the alarm text.
      const exists = await stat(sealSegmentPath(vaultRoot, entry.replica, entry.day))
        .then(() => true)
        .catch(() => false);
      segmentAlarms.push({
        replica: entry.replica,
        day: entry.day,
        verdict: 'segment-missing',
        detail: exists
          ? 'segment file exists but yielded no rows'
          : 'manifest names a segment whose file is gone',
      });
      continue;
    }
    if (!entryMatches(entry, parquet)) {
      segmentAlarms.push({
        replica: entry.replica,
        day: entry.day,
        verdict: 'segment-corrupt',
        detail: `parquet (n=${String(parquet.rows)} lo=${String(parquet.seqLo)} hi=${String(
          parquet.seqHi,
        )}) vs manifest (n=${String(entry.rows)} lo=${String(entry.seqLo)} hi=${String(entry.seqHi)})`,
      });
      continue;
    }
    const storeStat = storeDayStats(entry.replica, entry.day);
    if (storeStat === undefined || !entryMatches(entry, storeStat)) {
      // The store moved past the seal (late arrival / gap-fill / compaction).
      // Benign by design: the sealer re-seals on its next pass.
      storeDrift += 1;
      continue;
    }
    matches += 1;
  }
  const now = options.now ?? ((): Date => new Date());
  return {
    checkedDays: manifest.latest.size,
    matches,
    storeDrift,
    segmentAlarms,
    producedAt: now().toISOString(),
  };
};
