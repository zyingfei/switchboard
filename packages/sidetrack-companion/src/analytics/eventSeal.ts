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
// - DuckDB is loaded lazily and the instance is closed at the end of every
//   pass ("one lazy connection, closed when idle").

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createRevision } from '../domain/ids.js';
import { sha256File } from '../gc/engagementCompactionManifest.js';
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
  return (
    typeof entry['replica'] === 'string' &&
    REPLICA_RE.test(entry['replica']) &&
    entry['replica'] !== '.' &&
    entry['replica'] !== '..' &&
    typeof entry['day'] === 'string' &&
    DAY_RE.test(entry['day']) &&
    typeof entry['rows'] === 'number' &&
    Number.isInteger(entry['rows']) &&
    entry['rows'] > 0 &&
    typeof entry['seqLo'] === 'number' &&
    typeof entry['seqHi'] === 'number' &&
    typeof entry['sha256'] === 'string' &&
    typeof entry['sealedAt'] === 'string'
  );
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
      errors: ['event store unavailable (SIDETRACK_EVENT_STORE off or failed to open)'],
    };
  }
  const today = now().toISOString().slice(0, 10);
  const manifest = await readSealManifest(vaultRoot);

  const planned: { readonly replica: string; readonly stat: SealDayStat }[] = [];
  let skippedOpenDays = 0;
  let skippedAlreadySealed = 0;
  for (const replica of Object.keys(store.watermark()).sort()) {
    if (!REPLICA_RE.test(replica)) continue;
    for (const stat of store.sealDayStats(replica)) {
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
      planned.push({ replica, stat });
    }
  }

  const plannedEntries: SealManifestEntry[] = planned.map(({ replica, stat }) => ({
    replica,
    day: stat.day,
    rows: stat.rows,
    seqLo: stat.seqLo,
    seqHi: stat.seqHi,
    sha256: '',
    sealedAt: '',
  }));
  // Dry-run reports the FULL plan — the day cap bounds work, not visibility.
  if (options.dryRun === true || planned.length === 0) {
    return {
      planned: plannedEntries,
      sealed: [],
      skippedOpenDays,
      skippedAlreadySealed,
      deferredDays: 0,
      errors: [],
    };
  }

  const toSeal = planned.slice(0, maxDaysPerPass);
  const deferredDays = planned.length - toSeal.length;
  const sealed: SealManifestEntry[] = [];
  const errors: string[] = [];
  const duck = await openDuck();
  try {
    for (const { replica, stat } of toSeal) {
      try {
        sealed.push(await sealOneDay(vaultRoot, duck, store, replica, stat, now));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      // Yield to the event loop between days: the per-day JS work above runs
      // on the serving thread, so this gap is where pending HTTP requests
      // (and any other queued work) get to interleave.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    duck.close();
  }
  return {
    planned: plannedEntries,
    sealed,
    skippedOpenDays,
    skippedAlreadySealed,
    deferredDays,
    errors,
  };
};
