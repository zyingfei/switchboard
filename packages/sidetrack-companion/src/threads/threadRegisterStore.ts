// Derived, persistent fact store for thread CRDT register state,
// keyed by bac_id. Companion source of truth is the causal JSONL
// event log; `projectThread` folds the four thread event types
// (thread.upserted / archived / unarchived / deleted) for one bac_id
// into a resolved projection via `mergeRegister`.
//
// ROOT CAUSE this store kills (F8 design doc, "Membership bail"):
// the connections materializer's scoped drain path recomputes
// `thread_in_workstream` by calling `projectThread(threadId,
// scopedDeltaEvents)` — but `scopedDeltaEvents` is a drain WINDOW,
// not the thread's full history. A scoped window that lacks the
// founding thread.upserted (because it landed in an earlier drain)
// resolves an empty/incomplete register regardless of whether real
// membership changed, so the materializer conservatively bails to a
// full rebuild on every such drain.
//
// This store buckets the four thread event types BY bac_id (a real
// materialized index — O(events-for-one-thread) lookup instead of an
// O(full-log) filter) so the materializer can read a thread's COMPLETE
// relevant-event history in isolation and hand it to the SAME,
// unmodified `projectThread` — genuinely reproducing what a full
// rebuild would resolve for that one thread, without re-deriving the
// whole graph.
//
// Storage is intentionally UNPRUNED (raw per-event rows bucketed by
// bac_id, not a collapsed "current value"): causal `deps` in this
// system are the CLIENT's observed baseVector, not necessarily the
// companion's current frontier at acceptance time (see sync/causal.ts
// — "the companion MUST NOT replace the event's deps with its current
// frontier"). That means `eventDominates` is not guaranteed transitive
// across out-of-order, cross-chunk ingestion: an event C might cause-
// dominate B without C's deps covering everything B's deps covered.
// Pruning a candidate the moment SOME other candidate dominates it
// would risk silently discarding state a later-arriving candidate
// still needs to be tested against, producing a spurious conflict or
// a wrong winner that a full rebuild (which always sees the complete,
// order-independent set) would not reproduce. Per-thread history is
// small (a handful to a few dozen edits over a thread's lifetime), so
// the unpruned bucket is cheap and provably correct by construction —
// `read()` reconstructs the bucket and hands it to the real
// `projectThread`, zero custom CRDT logic.
//
// Lifecycle discipline copied from timeline/timelineFactsStore.ts:
// per-replica ingest watermark, idempotent re-ingest, chunked catchUp,
// rebuildFromJsonl cold-repair, close.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
  isThreadStatusPayload,
  isThreadUpsertedPayload,
} from './events.js';
import { projectThread, type ThreadProjection } from './projection.js';
import type { AcceptedEvent, Dot, VersionVector } from '../sync/causal.js';

export interface ThreadRegisterStore {
  /** Idempotent by (bac_id, dot). Buckets the four thread event types; ignores all others. */
  readonly ingest: (event: AcceptedEvent) => void;
  /** Batch ingest in one transaction. Returns the count actually bucketed. */
  readonly ingestMany: (events: readonly AcceptedEvent[]) => number;
  /** Ingest only events past the persisted per-replica watermark. */
  readonly catchUp: (events: readonly AcceptedEvent[]) => Promise<number>;
  /**
   * Resolved projection for one thread, computed by feeding this
   * thread's COMPLETE stored event history through the real
   * `projectThread` — authoritative regardless of any drain window.
   * `undefined` when no relevant event has ever been ingested for
   * this bac_id.
   */
  readonly read: (bacId: string) => ThreadProjection | undefined;
  /**
   * The reconstructed raw event set backing `read(bacId)`. Exposed so
   * callers that need to recompute row-local graph state (e.g. the
   * connections materializer's scoped-delta path) can splice the
   * thread's COMPLETE history into a bounded rebuild instead of the
   * drain window's incomplete slice. Empty when no relevant event has
   * ever been ingested for this bac_id.
   */
  readonly eventsFor: (bacId: string) => readonly AcceptedEvent[];
  /** Stream the JSONL shards and repopulate facts (cold rebuild / repair). */
  readonly rebuildFromJsonl: (logRoot: string) => Promise<void>;
  /** Per-replica max ingested seq. */
  readonly watermark: () => VersionVector;
  readonly close: () => void;
}

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
  const module = (await import('bun:sqlite')) as Partial<SqliteModule>;
  if (typeof module.Database !== 'function') {
    throw new Error('bun:sqlite Database export is unavailable');
  }
  return { Database: module.Database };
};

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 2500;
  CREATE TABLE IF NOT EXISTS thread_register_state (
    bac_id TEXT PRIMARY KEY,
    candidates_json TEXT NOT NULL,
    status_json TEXT NOT NULL,
    deleted INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ingest_watermark (
    replica_id TEXT PRIMARY KEY,
    max_seq INTEGER NOT NULL
  );
`;

const numberField = (row: unknown, field: string): number => {
  const value = (row as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : Number(value);
};
const stringField = (row: unknown, field: string): string =>
  String((row as Record<string, unknown>)[field]);

// One raw relevant event, minimal — enough to reconstruct an
// AcceptedEvent that `projectThread` will classify and fold exactly
// as it would the original.
interface StoredThreadEvent {
  readonly dot: Dot;
  readonly deps: VersionVector;
  readonly acceptedAtMs: number;
  readonly type: string;
  readonly payload: unknown;
}

const isStoredThreadEventArray = (value: unknown): value is StoredThreadEvent[] =>
  Array.isArray(value);

const toAcceptedEvent = (bacId: string, stored: StoredThreadEvent): AcceptedEvent => ({
  clientEventId: '',
  dot: stored.dot,
  deps: stored.deps,
  aggregateId: bacId,
  type: stored.type,
  payload: stored.payload,
  acceptedAtMs: stored.acceptedAtMs,
});

const dotEquals = (a: Dot, b: Dot): boolean => a.replicaId === b.replicaId && a.seq === b.seq;

export const createThreadRegisterStore = async (vaultRoot: string): Promise<ThreadRegisterStore> => {
  const { Database } = await loadSqlite();
  const dbPath = join(vaultRoot, '_BAC', 'connections', 'thread-register-facts.db');
  const db = new Database(dbPath, { create: true, readwrite: true });
  db.exec(SCHEMA);

  const selectRow = db.query(
    'SELECT candidates_json, status_json FROM thread_register_state WHERE bac_id = ?',
  );
  const upsertRow = db.query(
    `INSERT INTO thread_register_state (bac_id, candidates_json, status_json, deleted)
     VALUES (?,?,?,?)
     ON CONFLICT(bac_id) DO UPDATE SET
       candidates_json = excluded.candidates_json,
       status_json = excluded.status_json,
       deleted = excluded.deleted`,
  );
  const bumpWatermark = db.query(
    `INSERT INTO ingest_watermark (replica_id, max_seq) VALUES (?, ?)
     ON CONFLICT(replica_id) DO UPDATE SET max_seq = MAX(max_seq, excluded.max_seq)`,
  );

  const readBucketRow = (bacId: string): { candidates: StoredThreadEvent[]; statuses: StoredThreadEvent[] } => {
    const row = selectRow.get(bacId) as
      | { readonly candidates_json: string; readonly status_json: string }
      | undefined;
    if (row === undefined) return { candidates: [], statuses: [] };
    let candidates: unknown;
    let statuses: unknown;
    try {
      candidates = JSON.parse(row.candidates_json);
    } catch {
      candidates = [];
    }
    try {
      statuses = JSON.parse(row.status_json);
    } catch {
      statuses = [];
    }
    return {
      candidates: isStoredThreadEventArray(candidates) ? candidates : [],
      statuses: isStoredThreadEventArray(statuses) ? statuses : [],
    };
  };

  const eventsFromBucket = (
    bacId: string,
    candidates: readonly StoredThreadEvent[],
    statuses: readonly StoredThreadEvent[],
  ): AcceptedEvent[] => [
    ...candidates.map((stored) => toAcceptedEvent(bacId, stored)),
    ...statuses.map((stored) => toAcceptedEvent(bacId, stored)),
  ];

  const eventsFor = (bacId: string): readonly AcceptedEvent[] => {
    const { candidates, statuses } = readBucketRow(bacId);
    if (candidates.length === 0 && statuses.length === 0) return [];
    return eventsFromBucket(bacId, candidates, statuses);
  };

  const read = (bacId: string): ThreadProjection | undefined => {
    const { candidates, statuses } = readBucketRow(bacId);
    if (candidates.length === 0 && statuses.length === 0) return undefined;
    return projectThread(bacId, eventsFromBucket(bacId, candidates, statuses));
  };

  const bacIdForEvent = (event: AcceptedEvent): string | undefined => {
    if (event.type === THREAD_UPSERTED && isThreadUpsertedPayload(event.payload)) {
      return event.payload.bac_id;
    }
    if (
      (event.type === THREAD_ARCHIVED ||
        event.type === THREAD_UNARCHIVED ||
        event.type === THREAD_DELETED) &&
      isThreadStatusPayload(event.payload)
    ) {
      return event.payload.bac_id;
    }
    return undefined;
  };

  const ingest = (event: AcceptedEvent): boolean => {
    // Defensive: skip structurally-malformed events (e.g. a corrupt
    // JSONL line during rebuild) instead of throwing inside a batch.
    if (
      typeof event?.dot?.replicaId !== 'string' ||
      typeof event.dot.seq !== 'number' ||
      typeof event.acceptedAtMs !== 'number'
    ) {
      return false;
    }
    const { replicaId, seq } = event.dot;
    let projected = false;
    const bacId = bacIdForEvent(event);
    if (bacId !== undefined) {
      const { candidates, statuses } = readBucketRow(bacId);
      const stored: StoredThreadEvent = {
        dot: event.dot,
        deps: event.deps,
        acceptedAtMs: event.acceptedAtMs,
        type: event.type,
        payload: event.payload,
      };
      const isUpsert = event.type === THREAD_UPSERTED;
      const bucket = isUpsert ? candidates : statuses;
      // Idempotency guard at the row level (not just the watermark):
      // re-ingesting the same dot must not duplicate it, since a
      // duplicated dot would fail to self-dominate in mergeRegister
      // (eventDominates treats equal dots as non-dominating) and
      // manufacture a spurious conflict.
      if (!bucket.some((existing) => dotEquals(existing.dot, event.dot))) {
        bucket.push(stored);
        projected = true;
      }
      if (projected) {
        const projection = projectThread(bacId, eventsFromBucket(bacId, candidates, statuses));
        upsertRow.run(
          bacId,
          JSON.stringify(candidates),
          JSON.stringify(statuses),
          projection.deleted ? 1 : 0,
        );
      }
    }
    // Watermark advances for EVERY event so catchUp can skip the whole
    // log tail, not just thread-relevant events.
    bumpWatermark.run(replicaId, seq);
    return projected;
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
    const pending = events.filter((event) => event.dot.seq > (wm[event.dot.replicaId] ?? 0));
    let count = 0;
    for (let i = 0; i < pending.length; i += CATCHUP_CHUNK) {
      count += ingestMany(pending.slice(i, i + CATCHUP_CHUNK));
      if (i + CATCHUP_CHUNK < pending.length) {
        // Yield between chunks so a cold full seed doesn't stall the loop.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return count;
  };

  const rebuildFromJsonl = async (logRoot: string): Promise<void> => {
    // True rebuild/repair: clear derived facts + watermark so stale rows
    // from a prior state can't survive. JSONL stays authoritative.
    db.exec(`
      DELETE FROM thread_register_state;
      DELETE FROM ingest_watermark;
    `);
    let replicaDirs: string[];
    try {
      replicaDirs = await readdir(logRoot);
    } catch {
      return; // no log yet — nothing to rebuild
    }
    for (const replicaDir of replicaDirs) {
      let files: string[];
      try {
        files = (await readdir(join(logRoot, replicaDir)))
          .filter((f) => f.endsWith('.jsonl'))
          .sort();
      } catch {
        continue;
      }
      for (const file of files) {
        let raw: string;
        try {
          raw = await readFile(join(logRoot, replicaDir, file), 'utf8');
        } catch {
          continue;
        }
        const events: AcceptedEvent[] = [];
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          try {
            events.push(JSON.parse(trimmed) as AcceptedEvent);
          } catch {
            // skip malformed line; JSONL stays authoritative
          }
        }
        ingestMany(events);
      }
    }
  };

  return {
    ingest: (event) => {
      ingest(event);
    },
    ingestMany,
    catchUp,
    read,
    eventsFor,
    rebuildFromJsonl,
    watermark,
    close: () => {
      db.close?.();
    },
  };
};
