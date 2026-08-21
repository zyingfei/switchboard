// Columnar event tier, stage 1: the sealer.
// docs/design/2026-08-01-columnar-event-tier.md
//
// Seals closed UTC days of the typed event store into zstd Parquet segments
// under `_BAC/seal/<replica>/<day>.parquet`, recorded in the append-only
// `_BAC/seal/manifest.jsonl`. The manifest — not the directory listing — is
// the source of truth for what is sealed.
//
// Contract points this module owns:
// - The canonical JSONL log is never read, written, or deleted here. Rows
//   come from the typed event store AFTER an awaited catch-up
//   (getCaughtUpSharedEventStore) — the catch-up IS the ingestion handshake
//   the design's "dots ≤ store watermark" clause asks for.
// - A sealed segment mirrors the store's RETAINED rows for its day:
//   compaction-dropped dots are absent by construction. Consumers must treat
//   a manifest entry as a row-set (rows + [seqLo, seqHi] hull), never as a
//   dense seq range.
// - Verify-or-abort: after writing, the segment is re-read through DuckDB and
//   its (count, min seq, max seq) must equal the store's stats for that day —
//   a mismatch unlinks the temp file and publishes nothing.
// - Crash discipline: parquet is written to a same-directory temp name, then
//   file-fsync → rename → directory-fsync; the manifest line is appended with
//   an fsync before the pass reports the seal.
// - Late arrivals to an already-sealed day (peer imports write into the shard
//   for the event's own acceptedAtMs date) are handled by re-sealing: when
//   the store's day stats no longer match the latest manifest entry, the day
//   is sealed again and a superseding manifest line appended.
// - Day discovery is a UNION, not just the store's GROUP BY: a day whose
//   retained-row count drops to exactly zero (engagement compaction can
//   legitimately empty an entire day, not just shrink it) disappears from
//   sealDayStats' GROUP BY output entirely — COUNT collapses to nothing, not
//   a zero-row group — so a raw GROUP BY diff would never revisit it and a
//   stale (rows > 0) seal for it would never heal. Discovery therefore also
//   walks the seal manifest's own known days per replica: a manifest day
//   absent from the current GROUP BY output is verified against the store's
//   `compacted_events` ledger (compactedRowCountForDay) and, ONLY if the
//   ledger accounts for at least the previously sealed row count, re-sealed
//   as an EMPTY-day seal (`rows: 0` + `emptyDayCompactedRows` provenance) —
//   never a raw JSONL rescan, never assumed without ledger proof. A
//   zero-row manifest day with insufficient ledger evidence is genuine
//   drift: left exactly as-is, fail-closed, never auto-healed.
// - DuckDB is loaded lazily and the instance is closed at the end of every
//   pass ("one lazy connection, closed when idle") — and skipped entirely
//   when a pass only has empty-day re-seals to write (no parquet involved).

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createRevision } from '../domain/ids.js';
import { sha256File, sha256Text } from '../gc/engagementCompactionManifest.js';
import { getCaughtUpSharedEventStore, type SealDayStat } from '../sync/eventStore.js';
import { syncDirectory } from '../vault/atomic.js';

/** Default OFF; additive-only until proven (design invariant 5). */
export const eventSealEnabled = (): boolean => process.env['SIDETRACK_EVENT_SEAL'] === '1';

export const SEAL_ROOT_SEGMENTS = ['_BAC', 'seal'] as const;

export interface SealManifestEntry {
  readonly replica: string;
  readonly day: string;
  readonly rows: number;
  readonly seqLo: number;
  readonly seqHi: number;
  readonly sha256: string;
  readonly sealedAt: string;
  /** Present ONLY on an empty-day seal (`rows === 0`): the day previously
   *  held `seqHi - seqLo + 1` retained rows (kept above for late-arrival
   *  detection continuity — a new peer dot beyond `seqHi` still mismatches
   *  this entry the normal way) that a later compaction pass legitimately
   *  dropped. This is the `compacted_events` ledger row count the sealer
   *  verified BEFORE writing the empty-day seal — the receipt that makes
   *  "this day now has zero rows" provable, not merely observed. Absent on
   *  every ordinary (rows > 0) entry. */
  readonly emptyDayCompactedRows?: number;
}

export interface SealManifestRead {
  /** Latest entry per `${replica} ${day}` — later lines supersede. */
  readonly latest: ReadonlyMap<string, SealManifestEntry>;
  readonly lines: number;
  readonly malformedLines: number;
}

export interface SealPassResult {
  readonly planned: readonly SealManifestEntry[];
  readonly sealed: readonly SealManifestEntry[];
  readonly skippedOpenDays: number;
  readonly skippedAlreadySealed: number;
  /** Planned days beyond `maxDaysPerPass` left for the next pass; 0 when nothing deferred. */
  readonly deferredDays: number;
  /** Days the manifest knows (a prior seal with rows > 0) whose retained
   *  rows dropped to zero WITHOUT enough `compacted_events` ledger evidence
   *  to prove the drop was legitimate compaction. Never auto-healed — the
   *  stale seal is left exactly as-is (fail-closed) so hot-tail retirement
   *  keeps reporting `store-drift` for it rather than a false-clean empty
   *  seal. Persists across passes until either real ledger evidence
   *  appears or the day's rows come back. */
  readonly unexplainedZeroRowDays: number;
  readonly errors: readonly string[];
}

/**
 * Per-pass day cap. The per-day JS work (readSealRows materializing the day,
 * the row-by-row appender feed, sha256File) runs on the single serving
 * thread, so an unbounded pass over a large backlog (first live pass: 113
 * days) stalls HTTP serving. Backfill math: worst-case backlog of 182 days is
 * fully sealed within ceil(182 / 25) = 8 hourly ticks; steady state is 1 new
 * day per day, far under the cap.
 */
const DEFAULT_MAX_DAYS_PER_PASS = 25;

export const sealRoot = (vaultRoot: string): string => join(vaultRoot, ...SEAL_ROOT_SEGMENTS);
export const sealManifestPath = (vaultRoot: string): string =>
  join(sealRoot(vaultRoot), 'manifest.jsonl');
export const sealSegmentPath = (vaultRoot: string, replica: string, day: string): string =>
  join(sealRoot(vaultRoot), replica, `${day}.parquet`);

const manifestKey = (replica: string, day: string): string => `${replica} ${day}`;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;
// Same alphabet replicaLogDir enforces on the canonical log side.
const REPLICA_RE = /^[0-9a-zA-Z._-]+$/u;

const isManifestEntry = (value: unknown): value is SealManifestEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (
    !(
      typeof entry['replica'] === 'string' &&
      REPLICA_RE.test(entry['replica']) &&
      entry['replica'] !== '.' &&
      entry['replica'] !== '..' &&
      typeof entry['day'] === 'string' &&
      DAY_RE.test(entry['day']) &&
      typeof entry['rows'] === 'number' &&
      Number.isInteger(entry['rows']) &&
      entry['rows'] >= 0 &&
      typeof entry['seqLo'] === 'number' &&
      typeof entry['seqHi'] === 'number' &&
      typeof entry['sha256'] === 'string' &&
      typeof entry['sealedAt'] === 'string'
    )
  ) {
    return false;
  }
  // emptyDayCompactedRows is meaningful ONLY on an empty-day seal (rows===0)
  // — required and positive there (the ledger-provenance receipt), and must
  // be absent on every ordinary entry so the field never silently means two
  // different things.
  if (entry['rows'] === 0) {
    return (
      typeof entry['emptyDayCompactedRows'] === 'number' &&
      Number.isInteger(entry['emptyDayCompactedRows']) &&
      entry['emptyDayCompactedRows'] > 0
    );
  }
  return entry['emptyDayCompactedRows'] === undefined;
};

export const readSealManifest = async (vaultRoot: string): Promise<SealManifestRead> => {
  let raw: string;
  try {
    raw = await readFile(sealManifestPath(vaultRoot), 'utf8');
  } catch {
    return { latest: new Map(), lines: 0, malformedLines: 0 };
  }
  const latest = new Map<string, SealManifestEntry>();
  let lines = 0;
  let malformed = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    lines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!isManifestEntry(parsed)) {
      malformed += 1;
      continue;
    }
    latest.set(manifestKey(parsed.replica, parsed.day), parsed);
  }
  return { latest, lines, malformedLines: malformed };
};

const appendManifestEntry = async (vaultRoot: string, entry: SealManifestEntry): Promise<void> => {
  const path = sealManifestPath(vaultRoot);
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'a');
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const fsyncFile = async (path: string): Promise<void> => {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

interface DuckSession {
  readonly run: (sql: string) => Promise<unknown>;
  readonly readAggregate: (
    sql: string,
  ) => Promise<{ readonly n: number; readonly lo: number; readonly hi: number }>;
  readonly appendRows: (
    table: string,
    rows: readonly {
      readonly replicaId: string;
      readonly seq: number;
      readonly type: string;
      readonly acceptedAtMs: number;
      readonly aggregateId: string;
      readonly clientEventId: string;
      readonly payload: string;
    }[],
  ) => Promise<void>;
  readonly close: () => void;
}

// SQL string literals below embed filesystem paths. Quote by doubling any
// single quote; the path components themselves are already constrained
// (replica alphabet + day regex + vault root from our own config).
const sqlPath = (path: string): string => path.replaceAll("'", "''");

const openDuck = async (): Promise<DuckSession> => {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  return {
    run: (sql) => connection.run(sql),
    readAggregate: async (sql) => {
      const reader = await connection.runAndReadAll(sql);
      const row = reader.getRowObjects()[0] as
        | { n?: unknown; lo?: unknown; hi?: unknown }
        | undefined;
      return {
        n: Number(row?.n ?? Number.NaN),
        lo: Number(row?.lo ?? Number.NaN),
        hi: Number(row?.hi ?? Number.NaN),
      };
    },
    appendRows: async (table, rows) => {
      const appender = await connection.createAppender(table);
      // The feed loop runs on the single serving thread. Yield every 5k
      // rows so a flood-era day (30-100k rows, measured 66-186ms of
      // uninterrupted appender work) cannot block HTTP serving for its
      // whole duration — each block stays ~10ms.
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        appender.appendVarchar(row.replicaId);
        appender.appendBigInt(BigInt(row.seq));
        appender.appendVarchar(row.type);
        appender.appendBigInt(BigInt(row.acceptedAtMs));
        appender.appendVarchar(row.aggregateId);
        appender.appendVarchar(row.clientEventId);
        appender.appendVarchar(row.payload);
        appender.endRow();
        if ((i + 1) % 5_000 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      appender.flushSync();
      appender.closeSync();
    },
    close: () => {
      connection.closeSync();
    },
  };
};

const SEAL_TABLE_SQL = `
  CREATE OR REPLACE TABLE seal_rows (
    replica_id VARCHAR, seq BIGINT, type VARCHAR, accepted_at_ms BIGINT,
    aggregate_id VARCHAR, client_event_id VARCHAR, payload VARCHAR
  )
`;

const sealOneDay = async (
  vaultRoot: string,
  duck: DuckSession,
  store: NonNullable<Awaited<ReturnType<typeof getCaughtUpSharedEventStore>>>,
  replica: string,
  stat: SealDayStat,
  now: () => Date,
): Promise<SealManifestEntry> => {
  const finalPath = sealSegmentPath(vaultRoot, replica, stat.day);
  const dir = dirname(finalPath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${stat.day}.parquet.${createRevision()}.tmp`);

  const rows = store.readSealRows(replica, stat.day);
  await duck.run(SEAL_TABLE_SQL);
  await duck.appendRows('seal_rows', rows);
  await duck.run(
    `COPY (SELECT * FROM seal_rows ORDER BY seq)
       TO '${sqlPath(tempPath)}' (FORMAT parquet, COMPRESSION zstd)`,
  );

  // Verify-or-abort: the segment must agree with the store's day stats. This
  // guards the whole write path (appender, COPY, and any row the store read
  // returned that the aggregate did not cover, e.g. a mid-pass ingest).
  const check = await duck.readAggregate(
    `SELECT COUNT(*)::BIGINT AS n, MIN(seq)::BIGINT AS lo, MAX(seq)::BIGINT AS hi
       FROM read_parquet('${sqlPath(tempPath)}')`,
  );
  if (check.n !== stat.rows || check.lo !== stat.seqLo || check.hi !== stat.seqHi) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(
      `seal verification mismatch for ${replica}/${stat.day}: ` +
        `parquet (n=${String(check.n)} lo=${String(check.lo)} hi=${String(check.hi)}) ` +
        `vs store (n=${String(stat.rows)} lo=${String(stat.seqLo)} hi=${String(stat.seqHi)})`,
    );
  }

  await fsyncFile(tempPath);
  await rename(tempPath, finalPath);
  await syncDirectory(dir);

  const entry: SealManifestEntry = {
    replica,
    day: stat.day,
    rows: stat.rows,
    seqLo: stat.seqLo,
    seqHi: stat.seqHi,
    sha256: await sha256File(finalPath),
    sealedAt: now().toISOString(),
  };
  await appendManifestEntry(vaultRoot, entry);
  return entry;
};

/**
 * Re-seal a day whose retained-row count dropped to exactly zero because
 * every row a prior seal covered was legitimately compacted (F1 engagement
 * compaction can empty an entire day's shard, not just shrink it). Writes
 * NO parquet segment — there are zero rows to mirror, and a physically
 * empty parquet file would be invisible to the GROUP-BY-over-glob queries
 * `eventScan.ts`/`hotTailRetirement.ts` use to cross-check sealed segments
 * (a zero-row file contributes no group at all), so those two readers treat
 * `rows === 0` manifest entries as a distinct, file-less case instead. The
 * manifest line itself — `rows: 0` plus `emptyDayCompactedRows`, the
 * `compacted_events` ledger count this call's caller already verified — IS
 * the seal: the durable, provenance-carrying record that this day's
 * emptiness was proven, not merely observed. `seqLo`/`seqHi` are carried
 * over unchanged from the prior real seal so a later peer dot beyond the
 * old `seqHi` still mismatches this entry the normal way (late-arrival
 * re-seal, unchanged code path).
 */
const sealEmptyDay = async (
  vaultRoot: string,
  replica: string,
  day: string,
  prior: SealManifestEntry,
  compactedRows: number,
  now: () => Date,
): Promise<SealManifestEntry> => {
  const entry: SealManifestEntry = {
    replica,
    day,
    rows: 0,
    seqLo: prior.seqLo,
    seqHi: prior.seqHi,
    sha256: sha256Text(
      `empty-day:${replica}:${day}:${String(prior.seqLo)}:${String(prior.seqHi)}:${String(compactedRows)}`,
    ),
    sealedAt: now().toISOString(),
    emptyDayCompactedRows: compactedRows,
  };
  await appendManifestEntry(vaultRoot, entry);
  return entry;
};

/** One day this pass has decided needs a manifest line — either a normal
 *  rows-mirroring seal, or a provenance-verified empty-day seal for a day
 *  whose retained rows dropped to exactly zero. */
type PlannedDay =
  | { readonly kind: 'rows'; readonly replica: string; readonly stat: SealDayStat }
  | {
      readonly kind: 'empty';
      readonly replica: string;
      readonly day: string;
      readonly prior: SealManifestEntry;
      readonly compactedRows: number;
    };

const plannedDayToDraftEntry = (planned: PlannedDay): SealManifestEntry =>
  planned.kind === 'rows'
    ? {
        replica: planned.replica,
        day: planned.stat.day,
        rows: planned.stat.rows,
        seqLo: planned.stat.seqLo,
        seqHi: planned.stat.seqHi,
        sha256: '',
        sealedAt: '',
      }
    : {
        replica: planned.replica,
        day: planned.day,
        rows: 0,
        seqLo: planned.prior.seqLo,
        seqHi: planned.prior.seqHi,
        sha256: '',
        sealedAt: '',
        emptyDayCompactedRows: planned.compactedRows,
      };

/**
 * One sealer pass: plan every closed, unsealed (or changed) replica-day, then
 * — unless dryRun — seal each one, at most `maxDaysPerPass` per pass (the
 * hourly tick drains any remainder). Individual day failures are collected,
 * not thrown: a bad day must not block the rest of the pass.
 */
export const runEventSealPass = async (
  vaultRoot: string,
  options: {
    readonly dryRun?: boolean;
    readonly now?: () => Date;
    readonly maxDaysPerPass?: number;
  } = {},
): Promise<SealPassResult> => {
  const now = options.now ?? ((): Date => new Date());
  const maxDaysPerPass = options.maxDaysPerPass ?? DEFAULT_MAX_DAYS_PER_PASS;
  const store = await getCaughtUpSharedEventStore(vaultRoot);
  if (store === null) {
    return {
      planned: [],
      sealed: [],
      skippedOpenDays: 0,
      skippedAlreadySealed: 0,
      deferredDays: 0,
      unexplainedZeroRowDays: 0,
      errors: ['event store unavailable (SIDETRACK_EVENT_STORE off or failed to open)'],
    };
  }
  const today = now().toISOString().slice(0, 10);
  const manifest = await readSealManifest(vaultRoot);

  const planned: PlannedDay[] = [];
  let skippedOpenDays = 0;
  let skippedAlreadySealed = 0;
  let unexplainedZeroRowDays = 0;
  for (const replica of Object.keys(store.watermark()).sort()) {
    if (!REPLICA_RE.test(replica)) continue;
    const dayStats = store.sealDayStats(replica);
    const rowfulDays = new Set(dayStats.map((stat) => stat.day));
    for (const stat of dayStats) {
      // Today's day is still open; a future-dated day (peer with a fast
      // clock) is treated the same — never sealed until it is in the past.
      if (stat.day >= today) {
        skippedOpenDays += 1;
        continue;
      }
      const existing = manifest.latest.get(manifestKey(replica, stat.day));
      if (
        existing !== undefined &&
        existing.rows === stat.rows &&
        existing.seqLo === stat.seqLo &&
        existing.seqHi === stat.seqHi
      ) {
        skippedAlreadySealed += 1;
        continue;
      }
      planned.push({ kind: 'rows', replica, stat });
    }

    // Zero-row days the manifest already knows about (a prior seal with
    // rows > 0): sealDayStats' GROUP BY never re-visits these — COUNT
    // collapses to nothing, not a zero-row group — so without this walk a
    // stale seal here would never heal. A manifest day with LIVE rows was
    // already handled above; a manifest day with no live rows AND no prior
    // seal at all isn't reachable here (nothing to heal, `never-sealed`
    // covers it downstream).
    for (const entry of manifest.latest.values()) {
      if (entry.replica !== replica || rowfulDays.has(entry.day) || entry.day >= today) continue;
      if (entry.rows === 0) {
        // Already an empty-day seal and the store still agrees (zero
        // live rows) — consistent, nothing to redo.
        skippedAlreadySealed += 1;
        continue;
      }
      const compactedRows = store.compactedRowCountForDay(replica, entry.day);
      if (compactedRows >= entry.rows) {
        planned.push({ kind: 'empty', replica, day: entry.day, prior: entry, compactedRows });
      } else {
        // Genuine drift: the compaction ledger does not account for the
        // missing rows. Fail closed — never auto-heal; leave the stale
        // seal exactly as it is, so hot-tail retirement keeps (correctly)
        // reporting `store-drift` for it instead of a false-clean seal.
        unexplainedZeroRowDays += 1;
      }
    }
  }

  const plannedEntries: SealManifestEntry[] = planned.map(plannedDayToDraftEntry);
  // Dry-run reports the FULL plan — the day cap bounds work, not visibility.
  if (options.dryRun === true || planned.length === 0) {
    return {
      planned: plannedEntries,
      sealed: [],
      skippedOpenDays,
      skippedAlreadySealed,
      deferredDays: 0,
      unexplainedZeroRowDays,
      errors: [],
    };
  }

  const toSeal = planned.slice(0, maxDaysPerPass);
  const deferredDays = planned.length - toSeal.length;
  const sealed: SealManifestEntry[] = [];
  const errors: string[] = [];
  // Lazy + conditional: a pass that only has empty-day re-seals to write
  // never touches parquet, so it never needs to spin up DuckDB at all.
  let duck: DuckSession | null = null;
  try {
    for (const day of toSeal) {
      try {
        if (day.kind === 'rows') {
          duck ??= await openDuck();
          sealed.push(await sealOneDay(vaultRoot, duck, store, day.replica, day.stat, now));
        } else {
          sealed.push(
            await sealEmptyDay(vaultRoot, day.replica, day.day, day.prior, day.compactedRows, now),
          );
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      // Yield to the event loop between days: the per-day JS work above runs
      // on the serving thread, so this gap is where pending HTTP requests
      // (and any other queued work) get to interleave.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    duck?.close();
  }
  return {
    planned: plannedEntries,
    sealed,
    skippedOpenDays,
    skippedAlreadySealed,
    deferredDays,
    unexplainedZeroRowDays,
    errors,
  };
};
