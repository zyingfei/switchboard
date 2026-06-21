// Derived, persistent SQLite mirror of the causal JSONL event log.
//
// JSONL remains the source of truth. This store is rebuildable and
// exists so hot materializers can read small ordered tails without
// materializing the full AcceptedEvent[] in the JS heap.

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isAcceptedEvent } from './eventLog.js';
import type { AcceptedEvent, Hlc, TargetRef, VersionVector } from './causal.js';

export interface EventStore {
  /** Idempotent by (replicaId, seq). Watermark advances for every valid event. */
  readonly ingest: (event: AcceptedEvent) => void;
  readonly ingestMany: (events: readonly AcceptedEvent[]) => number;
  /** Ingest only events past the persisted per-replica watermark. */
  readonly catchUp: (events: readonly AcceptedEvent[]) => Promise<number>;
  /** Stream JSONL shards and ingest only events past the store watermark. */
  readonly catchUpFromJsonl: (logRoot: string) => Promise<number>;
  /** True rebuild/repair: clear derived rows first, then stream JSONL. */
  readonly rebuildFromJsonl: (logRoot: string) => Promise<void>;
  /** Ordered like readMerged().filter(event => event.dot.seq > frontier[replica] ?? 0). */
  readonly readSince: (frontier: VersionVector) => readonly AcceptedEvent[];
  readonly maxAcceptedAtMs: () => number;
  readonly count: () => number;
  readonly forEachChunk: (
    cb: (chunk: readonly AcceptedEvent[]) => void | Promise<void>,
    chunkSize: number,
  ) => Promise<void>;
  /** Like forEachChunk but filtered to the given event types at the SQL
   *  level (events_type_idx). O(matching rows) instead of O(all events)
   *  — health/feedback probes want a tiny typed subset of a log that is
   *  ~92% engagement.interval, so a full forEachChunk scan dominated the
   *  5s health budget. */
  readonly forEachChunkOfTypes: (
    types: readonly string[],
    cb: (chunk: readonly AcceptedEvent[]) => void | Promise<void>,
    chunkSize: number,
  ) => Promise<void>;
  readonly watermark: () => VersionVector;
  readonly close: () => void;
}

// Default OFF: measured net-negative. The off-heap event store does NOT
// reduce memory — idle resident is already tiny (mergedMemo TTL-evicts;
// ~39MB) and under load peak RSS was HIGHER with the store (1064MB) than
// legacy readMerged (853MB) due to the sqlite handle + query/catchUp
// overhead; the ~2.8G "footprint" is Bun allocator slack (compressed/
// swapped), unaffected either way. Opt-in via env=1 (experimental).
// Default OFF (measured 2026-05-29): fetching RAW events from the SQLite
// mirror is a half-measure — it does NOT fix the JS heap (serving reads
// still materialize the events as JS objects: heap stayed ~990MB), and it
// trades the readMerged memo cache for CPU (every poll re-reads + re-
// projects from SQLite → ~100% CPU under the extension's frequent polls;
// RSS only modestly + noisily lower, ~1.24G vs ~1.8G). The real fix is
// query-AGGREGATION: have serving run SQL projections that return the small
// rolled-up result (URLs/sessions/engagement metrics) instead of raw
// events — see engagement/engagementFactsStore.ts for that pattern, and
// the chdb evaluation for the columnar option. Opt in with =1.
export const eventStoreEnabled = (): boolean => process.env['SIDETRACK_EVENT_STORE'] === '1';

const sharedEventStores = new Map<string, Promise<EventStore | null>>();

interface SqliteStatement {
  readonly run: (...params: readonly unknown[]) => unknown;
  readonly get: (...params: readonly unknown[]) => unknown;
  readonly all: (...params: readonly unknown[]) => readonly unknown[];
}
interface SqliteDatabase {
  readonly exec: (sql: string) => unknown;
  readonly query: (sql: string) => SqliteStatement;
  readonly close?: () => void;
}
interface SqliteModule {
  readonly Database: new (
    filename: string,
    options?: { readonly create?: boolean; readonly readwrite?: boolean },
  ) => SqliteDatabase;
}

const loadSqlite = async (): Promise<SqliteModule> => {
  const specifier = 'bun:sqlite';
  const module = (await import(specifier)) as Partial<SqliteModule>;
  if (typeof module.Database !== 'function') {
    throw new Error('bun:sqlite Database export is unavailable');
  }
  return { Database: module.Database };
};

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 2500;
  CREATE TABLE IF NOT EXISTS events (
    replica_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    client_event_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    accepted_at_ms INTEGER NOT NULL,
    deps TEXT NOT NULL,
    target TEXT NOT NULL,
    hlc TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    PRIMARY KEY (replica_id, seq)
  );
  CREATE INDEX IF NOT EXISTS events_accepted_at_ms_idx ON events(accepted_at_ms);
  CREATE INDEX IF NOT EXISTS events_replica_seq_idx ON events(replica_id, seq);
  CREATE INDEX IF NOT EXISTS events_type_idx ON events(type, replica_id, seq);
  CREATE TABLE IF NOT EXISTS ingest_watermark (
    replica_id TEXT PRIMARY KEY,
    max_seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shard_progress (
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    read_offset INTEGER NOT NULL
  );
`;

const numberField = (row: unknown, field: string): number => {
  const value = (row as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : Number(value);
};

const stringField = (row: unknown, field: string): string =>
  String((row as Record<string, unknown>)[field]);

const optionalJsonText = (value: unknown): string => JSON.stringify(value ?? null);

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

const isStructurallyValidAcceptedEvent = (event: AcceptedEvent): boolean =>
  isAcceptedEvent(event) && Number.isFinite(event.dot.seq) && Number.isFinite(event.acceptedAtMs);

const rowToAcceptedEvent = (row: unknown): AcceptedEvent | null => {
  try {
    const target = parseJson(stringField(row, 'target'));
    const hlc = parseJson(stringField(row, 'hlc'));
    const event: AcceptedEvent = {
      clientEventId: stringField(row, 'client_event_id'),
      dot: {
        replicaId: stringField(row, 'replica_id'),
        seq: numberField(row, 'seq'),
      },
      deps: parseJson(stringField(row, 'deps')) as VersionVector,
      aggregateId: stringField(row, 'aggregate_id'),
      type: stringField(row, 'type'),
      payload: parseJson(stringField(row, 'payload')),
      acceptedAtMs: numberField(row, 'accepted_at_ms'),
      ...(target === null ? {} : { target: target as TargetRef }),
      ...(hlc === null ? {} : { hlc: hlc as Hlc }),
    };
    return isStructurallyValidAcceptedEvent(event) ? event : null;
  } catch {
    return null;
  }
};

const rowsToEvents = (rows: readonly unknown[]): AcceptedEvent[] => {
  const out: AcceptedEvent[] = [];
  for (const row of rows) {
    const event = rowToAcceptedEvent(row);
    if (event !== null) out.push(event);
  }
  return out;
};

const SELECT_COLUMNS = `
  replica_id, seq, client_event_id, type, payload, accepted_at_ms,
  deps, target, hlc, aggregate_id
`;

interface ShardProgress {
  readonly size: number;
  readonly mtimeMs: number;
  readonly readOffset: number;
}

export const createEventStore = async (vaultRoot: string): Promise<EventStore> => {
  const { Database } = await loadSqlite();
  const dbPath = join(vaultRoot, '_BAC', 'connections', 'event-store.db');
  const db = new Database(dbPath, { create: true, readwrite: true });
  db.exec(SCHEMA);

  const insertEvent = db.query(
    `INSERT OR IGNORE INTO events
       (replica_id, seq, client_event_id, type, payload, accepted_at_ms,
        deps, target, hlc, aggregate_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const bumpWatermark = db.query(
    `INSERT INTO ingest_watermark (replica_id, max_seq) VALUES (?, ?)
     ON CONFLICT(replica_id) DO UPDATE SET max_seq = MAX(max_seq, excluded.max_seq)`,
  );
  const selectShardProgress = db.query(
    'SELECT size, mtime_ms, read_offset FROM shard_progress WHERE path = ?',
  );
  const upsertShardProgress = db.query(
    `INSERT INTO shard_progress (path, size, mtime_ms, read_offset) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       read_offset = excluded.read_offset`,
  );

  const ingest = (event: AcceptedEvent): boolean => {
    if (!isStructurallyValidAcceptedEvent(event)) return false;
    const { replicaId, seq } = event.dot;
    insertEvent.run(
      replicaId,
      seq,
      event.clientEventId,
      event.type,
      JSON.stringify(event.payload),
      event.acceptedAtMs,
      JSON.stringify(event.deps),
      optionalJsonText(event.target),
      optionalJsonText(event.hlc),
      event.aggregateId,
    );
    bumpWatermark.run(replicaId, seq);
    return true;
  };

  const ingestMany = (events: readonly AcceptedEvent[]): number => {
    let count = 0;
    db.exec('BEGIN');
    try {
      for (const event of events) {
        if (ingest(event)) count += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return count;
  };

  const watermark = (): VersionVector => {
    const rows = db.query('SELECT replica_id, max_seq FROM ingest_watermark').all();
    const vector: Record<string, number> = {};
    for (const row of rows) {
      vector[stringField(row, 'replica_id')] = numberField(row, 'max_seq');
    }
    return vector;
  };

  const CATCHUP_CHUNK = 2000;
  const catchUp = async (events: readonly AcceptedEvent[]): Promise<number> => {
    const wm = watermark();
    let count = 0;
    let pending: AcceptedEvent[] = [];
    for (const event of events) {
      if (!isStructurallyValidAcceptedEvent(event)) continue;
      if (event.dot.seq <= (wm[event.dot.replicaId] ?? 0)) continue;
      pending.push(event);
      if (pending.length >= CATCHUP_CHUNK) {
        count += ingestMany(pending);
        pending = [];
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (pending.length > 0) count += ingestMany(pending);
    return count;
  };

  const catchUpFromJsonl = async (logRoot: string): Promise<number> => {
    let replicaDirs: string[];
    try {
      replicaDirs = (await readdir(logRoot)).sort();
    } catch {
      return 0;
    }
    let count = 0;
    let wm = watermark();
    let pending: AcceptedEvent[] = [];
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      count += ingestMany(pending);
      pending = [];
      wm = watermark();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    for (const replicaDir of replicaDirs) {
      let files: string[];
      try {
        files = (await readdir(join(logRoot, replicaDir)))
          .filter((file) => file.endsWith('.jsonl'))
          .sort();
      } catch {
        continue;
      }
      for (const file of files) {
        const shardPath = join(logRoot, replicaDir, file);
        let shardStat: Awaited<ReturnType<typeof stat>>;
        try {
          shardStat = await stat(shardPath);
        } catch {
          continue;
        }
        if (!shardStat.isFile()) continue;
        const size = shardStat.size;
        const mtimeMs = Math.trunc(shardStat.mtimeMs);
        const progressRow = selectShardProgress.get(shardPath);
        const progress: ShardProgress | null =
          progressRow === null || progressRow === undefined
            ? null
            : {
                size: numberField(progressRow, 'size'),
                mtimeMs: numberField(progressRow, 'mtime_ms'),
                readOffset: numberField(progressRow, 'read_offset'),
              };
        if (progress !== null && progress.size === size && progress.mtimeMs === mtimeMs) {
          continue;
        }

        const readOffset =
          progress === null || progress.readOffset > size ? 0 : Math.max(0, progress.readOffset);
        const byteLength = size - readOffset;
        if (byteLength <= 0) {
          upsertShardProgress.run(shardPath, size, mtimeMs, readOffset);
          continue;
        }

        let tail: Buffer;
        try {
          const handle = await open(shardPath, 'r');
          try {
            tail = Buffer.alloc(byteLength);
            const result = await handle.read(tail, 0, byteLength, readOffset);
            tail = tail.subarray(0, result.bytesRead);
          } finally {
            await handle.close();
          }
        } catch {
          continue;
        }

        const lastNewline = tail.lastIndexOf(0x0a);
        if (lastNewline < 0) {
          upsertShardProgress.run(shardPath, size, mtimeMs, readOffset);
          continue;
        }
        const nextReadOffset = readOffset + lastNewline + 1;
        const raw = tail.subarray(0, lastNewline + 1).toString('utf8');
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (!isAcceptedEvent(parsed)) continue;
            if (parsed.dot.seq <= (wm[parsed.dot.replicaId] ?? 0)) continue;
            pending.push(parsed);
            if (pending.length >= CATCHUP_CHUNK) await flush();
          } catch {
            // skip malformed line; JSONL stays authoritative
          }
        }
        upsertShardProgress.run(shardPath, size, mtimeMs, nextReadOffset);
      }
    }
    await flush();
    return count;
  };

  const rebuildFromJsonl = async (logRoot: string): Promise<void> => {
    db.exec(`
      DELETE FROM events;
      DELETE FROM ingest_watermark;
      DELETE FROM shard_progress;
    `);
    await catchUpFromJsonl(logRoot);
  };

  const readSince = (frontier: VersionVector): readonly AcceptedEvent[] => {
    const entries = Object.entries(frontier).filter(([, seq]) => Number.isFinite(seq));
    if (entries.length === 0) {
      return rowsToEvents(
        db.query(`SELECT ${SELECT_COLUMNS} FROM events ORDER BY replica_id, seq`).all(),
      );
    }
    const notInPlaceholders = entries.map(() => '?').join(',');
    const clauses = [`replica_id NOT IN (${notInPlaceholders})`];
    const params: unknown[] = entries.map(([replicaId]) => replicaId);
    for (const [replicaId, seq] of entries) {
      clauses.push('(replica_id = ? AND seq > ?)');
      params.push(replicaId, seq);
    }
    return rowsToEvents(
      db
        .query(
          `SELECT ${SELECT_COLUMNS}
           FROM events
           WHERE ${clauses.join(' OR ')}
           ORDER BY replica_id, seq`,
        )
        .all(...params),
    );
  };

  const maxAcceptedAtMs = (): number => {
    const row = db.query('SELECT COALESCE(MAX(accepted_at_ms), 0) AS max FROM events').get();
    return row === null || row === undefined ? 0 : numberField(row, 'max');
  };

  const count = (): number => {
    const row = db.query('SELECT COUNT(*) AS count FROM events').get();
    return row === null || row === undefined ? 0 : numberField(row, 'count');
  };

  const forEachChunk = async (
    cb: (chunk: readonly AcceptedEvent[]) => void | Promise<void>,
    chunkSize: number,
  ): Promise<void> => {
    const size = Math.max(1, Math.floor(chunkSize));
    let lastReplicaId = '';
    let lastSeq = 0;
    while (true) {
      const rows = db
        .query(
          `SELECT ${SELECT_COLUMNS}
           FROM events
           WHERE replica_id > ? OR (replica_id = ? AND seq > ?)
           ORDER BY replica_id, seq
           LIMIT ?`,
        )
        .all(lastReplicaId, lastReplicaId, lastSeq, size);
      const chunk = rowsToEvents(rows);
      if (chunk.length === 0) return;
      await cb(chunk);
      const last = chunk[chunk.length - 1];
      if (last === undefined) return;
      lastReplicaId = last.dot.replicaId;
      lastSeq = last.dot.seq;
      if (chunk.length < size) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const forEachChunkOfTypes = async (
    types: readonly string[],
    cb: (chunk: readonly AcceptedEvent[]) => void | Promise<void>,
    chunkSize: number,
  ): Promise<void> => {
    if (types.length === 0) return;
    const size = Math.max(1, Math.floor(chunkSize));
    const placeholders = types.map(() => '?').join(', ');
    let lastReplicaId = '';
    let lastSeq = 0;
    while (true) {
      const rows = db
        .query(
          `SELECT ${SELECT_COLUMNS}
           FROM events
           WHERE type IN (${placeholders})
             AND (replica_id > ? OR (replica_id = ? AND seq > ?))
           ORDER BY replica_id, seq
           LIMIT ?`,
        )
        .all(...types, lastReplicaId, lastReplicaId, lastSeq, size);
      const chunk = rowsToEvents(rows);
      if (chunk.length === 0) return;
      await cb(chunk);
      const last = chunk[chunk.length - 1];
      if (last === undefined) return;
      lastReplicaId = last.dot.replicaId;
      lastSeq = last.dot.seq;
      if (chunk.length < size) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  return {
    ingest: (event) => {
      ingest(event);
    },
    ingestMany,
    catchUp,
    catchUpFromJsonl,
    rebuildFromJsonl,
    readSince,
    maxAcceptedAtMs,
    count,
    forEachChunk,
    forEachChunkOfTypes,
    watermark,
    close: () => {
      db.close?.();
    },
  };
};

export const getSharedEventStore = (vaultRoot: string): Promise<EventStore | null> => {
  if (!eventStoreEnabled()) return Promise.resolve(null);
  const existing = sharedEventStores.get(vaultRoot);
  if (existing !== undefined) return existing;
  const created = createEventStore(vaultRoot).catch(() => null);
  sharedEventStores.set(vaultRoot, created);
  return created;
};

export const getCaughtUpSharedEventStore = async (
  vaultRoot: string,
): Promise<EventStore | null> => {
  const store = await getSharedEventStore(vaultRoot);
  if (store === null) return null;
  await store.catchUpFromJsonl(join(vaultRoot, '_BAC', 'log'));
  return store;
};
