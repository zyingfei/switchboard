// Derived, persistent fact store tracking each workstream's resolved
// parent_id, keyed by bac_id. Companion source of truth is the causal
// JSONL event log; WORKSTREAM_UPSERTED / WORKSTREAM_DELETED events are
// folded into one resolved (parent_id, deleted) row per workstream.
//
// ROOT CAUSE this store kills (F8 IVM design doc, "Root causes" item 3 /
// wave W4): invalidation.ts unconditionally emits {kind:'workstreamTree'}
// for ANY workstream create/rename/reparent/delete, and that kind sits in
// the connections materializer's SCOPED_DELTA_FULL_REBUILD_INVALIDATION_
// KINDS — forcing a full rebuild (post-W3: a demotion + repair-queue
// enqueue) on every workstream CRUD, however small the actual change.
//
// W4 makes workstream CRUD SCOPED: a reparent/delete only needs to
// invalidate the affected workstream's own scope plus its OLD and NEW
// ANCESTOR CHAIN (walking parent_id up to the root, bounded + cycle-
// safe) — see connectionsMaterializer.ts's workstreamTreeAffectedIds
// computation, which calls `subtreeOf` once BEFORE folding this drain's
// events into the store (the pre-change / OLD chain) and once AFTER (the
// post-change / NEW chain), unioning both. (Deletion cannot cascade: the
// HTTP delete route refuses to delete a workstream with children, so a
// deleted workstream is always a leaf — no descendant walk is needed.)
//
// This store exists to answer "what is workstream X's current parent" in
// O(1) (no full-log scan) so that ancestor-chain walk is cheap, and to
// remember the PRE-drain parent so a reparent's OLD ancestor chain can
// still be found after the new value has landed.
//
// Deliberately LEANER than threadRegisterStore.ts: this store's ONLY job
// is choosing WHICH scopes to invalidate, never serving graph row
// content — the materializer splices the AUTHORITATIVE vault records
// (input.workstreams) and the raw WORKSTREAM_UPSERTED/DELETED history for
// the affected ids (read fresh via the typed event store's type index, or
// the full log as a fallback — see connectionsMaterializer.ts's
// readWorkstreamHistoryForAffectedIds) into the scoped snapshot build,
// exactly reproducing what a full rebuild's Pass 1 + Pass 2 would emit
// for those ids. So THIS store resolves "current parent" with plain
// per-bac_id LAST-WRITER-WINS (compared by (acceptedAtMs, replicaId,
// seq), deterministic and convergent regardless of ingest order) rather
// than threadRegisterStore's full unpruned candidate-bucket +
// mergeRegister fold: a wrong pick here only risks invalidating the
// wrong (or an extra, harmless) scope — never wrong SERVED content,
// which is always sourced from the authoritative splice above. A genuine
// multi-replica CONCURRENT conflicting parentId edit on the same
// workstream within the same causal window is the one case this
// approximates rather than resolves exactly (see `isNewer` below); that
// is an accepted, documented tradeoff for a store whose only consumer is
// scope selection, not row content.
//
// Lifecycle discipline copied from threadRegisterStore.ts /
// timeline/timelineFactsStore.ts: per-replica ingest watermark,
// idempotent re-ingest, chunked catchUp, rebuildFromJsonl cold-repair,
// close.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isWorkstreamDeletedPayload,
  isWorkstreamUpsertedPayload,
  WORKSTREAM_DELETED,
  WORKSTREAM_UPSERTED,
} from './events.js';
import type { AcceptedEvent, VersionVector } from '../sync/causal.js';

export interface WorkstreamParentRecord {
  readonly bacId: string;
  readonly parentId: string | null;
  readonly deleted: boolean;
}

export interface WorkstreamParentStore {
  /** Idempotent by (bac_id, dot). Folds WORKSTREAM_UPSERTED/DELETED only. */
  readonly ingest: (event: AcceptedEvent) => void;
  /** Batch ingest in one transaction. Returns the count actually applied. */
  readonly ingestMany: (events: readonly AcceptedEvent[]) => number;
  /** Ingest only events past the persisted per-replica watermark. */
  readonly catchUp: (events: readonly AcceptedEvent[]) => Promise<number>;
  /** Resolved (parentId, deleted) for one workstream. `undefined` when never observed. */
  readonly read: (bacId: string) => WorkstreamParentRecord | undefined;
  /**
   * Bounded, cycle-safe ancestor-chain walk: bacId followed by its
   * parent, grandparent, … up to the root (or MAX_ANCESTOR_DEPTH hops,
   * whichever comes first). A workstream never observed by this store
   * still yields `[bacId]` (self, no known ancestors) — callers treat
   * an unresolved id as "at least itself is affected", never as "no
   * scope to invalidate".
   */
  readonly subtreeOf: (bacId: string) => readonly string[];
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
  CREATE TABLE IF NOT EXISTS workstream_parent (
    bac_id TEXT PRIMARY KEY,
    parent_id TEXT,
    deleted INTEGER NOT NULL,
    winner_replica_id TEXT NOT NULL,
    winner_seq INTEGER NOT NULL,
    winner_accepted_at_ms INTEGER NOT NULL
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

interface StoredRow {
  readonly parent_id: string | null;
  readonly deleted: number;
  readonly winner_replica_id: string;
  readonly winner_seq: number;
  readonly winner_accepted_at_ms: number;
}

const workstreamBacIdForEvent = (event: AcceptedEvent): string | undefined => {
  if (event.type === WORKSTREAM_UPSERTED && isWorkstreamUpsertedPayload(event.payload)) {
    return event.payload.bac_id;
  }
  if (event.type === WORKSTREAM_DELETED && isWorkstreamDeletedPayload(event.payload)) {
    return event.payload.bac_id;
  }
  return undefined;
};

// Re-exported so the materializer can classify pendingEventsForDrain
// events the same way this store does, without duplicating the payload
// guards.
export { workstreamBacIdForEvent };

// Plain last-writer-wins tie-break, compared as a (acceptedAtMs,
// replicaId, seq) tuple. Deterministic and convergent: replaying the
// same event set in ANY order (chunked catch-up, out-of-order ingest)
// converges to the same final winner, because every ingest compares the
// CANDIDATE against whatever is CURRENTLY stored and only replaces when
// strictly greater — equal tuples (a re-ingested dot) are a no-op,
// which is what makes `ingest` idempotent.
const isNewer = (
  candidate: { readonly acceptedAtMs: number; readonly replicaId: string; readonly seq: number },
  existing: StoredRow | undefined,
): boolean => {
  if (existing === undefined) return true;
  if (candidate.acceptedAtMs !== existing.winner_accepted_at_ms) {
    return candidate.acceptedAtMs > existing.winner_accepted_at_ms;
  }
  if (candidate.replicaId !== existing.winner_replica_id) {
    return candidate.replicaId > existing.winner_replica_id;
  }
  return candidate.seq > existing.winner_seq;
};

const MAX_ANCESTOR_DEPTH = 32;

export const createWorkstreamParentStore = async (
  vaultRoot: string,
): Promise<WorkstreamParentStore> => {
  const { Database } = await loadSqlite();
  const dbPath = join(vaultRoot, '_BAC', 'connections', 'workstream-parent.db');
  const db = new Database(dbPath, { create: true, readwrite: true });
  db.exec(SCHEMA);

  const selectRow = db.query(
    'SELECT parent_id, deleted, winner_replica_id, winner_seq, winner_accepted_at_ms FROM workstream_parent WHERE bac_id = ?',
  );
  const upsertRow = db.query(
    `INSERT INTO workstream_parent (bac_id, parent_id, deleted, winner_replica_id, winner_seq, winner_accepted_at_ms)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(bac_id) DO UPDATE SET
       parent_id = excluded.parent_id,
       deleted = excluded.deleted,
       winner_replica_id = excluded.winner_replica_id,
       winner_seq = excluded.winner_seq,
       winner_accepted_at_ms = excluded.winner_accepted_at_ms`,
  );
  const bumpWatermark = db.query(
    `INSERT INTO ingest_watermark (replica_id, max_seq) VALUES (?, ?)
     ON CONFLICT(replica_id) DO UPDATE SET max_seq = MAX(max_seq, excluded.max_seq)`,
  );

  const readRow = (bacId: string): StoredRow | undefined => {
    const row = selectRow.get(bacId) as StoredRow | null;
    return row === null ? undefined : row;
  };

  const read = (bacId: string): WorkstreamParentRecord | undefined => {
    const row = readRow(bacId);
    if (row === undefined) return undefined;
    return { bacId, parentId: row.parent_id, deleted: row.deleted === 1 };
  };

  const subtreeOf = (bacId: string): readonly string[] => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = bacId;
    let hops = 0;
    while (current !== undefined && !seen.has(current) && hops < MAX_ANCESTOR_DEPTH) {
      chain.push(current);
      seen.add(current);
      const row = readRow(current);
      current = row?.parent_id ?? undefined;
      hops += 1;
    }
    return chain;
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
    let changed = false;
    const bacId = workstreamBacIdForEvent(event);
    if (bacId !== undefined) {
      const existing = readRow(bacId);
      const candidate = { acceptedAtMs: event.acceptedAtMs, replicaId, seq };
      if (isNewer(candidate, existing)) {
        const isUpsert = event.type === WORKSTREAM_UPSERTED && isWorkstreamUpsertedPayload(event.payload);
        // WORKSTREAM_DELETED is a tombstone, not an erasure — keep the
        // last-known parent_id (matches thread delete/revive semantics:
        // "concurrent later upserts revive"). A later-winning
        // WORKSTREAM_UPSERTED flips `deleted` back to 0 naturally since
        // its own event.type drives the flag.
        const parentId = isUpsert
          ? ((event.payload as { readonly parentId?: string }).parentId ?? null)
          : (existing?.parent_id ?? null);
        const deleted = event.type === WORKSTREAM_DELETED ? 1 : 0;
        upsertRow.run(bacId, parentId, deleted, replicaId, seq, event.acceptedAtMs);
        changed = true;
      }
    }
    // Watermark advances for EVERY event so catchUp can skip the whole
    // log tail, not just workstream-relevant events.
    bumpWatermark.run(replicaId, seq);
    return changed;
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
      DELETE FROM workstream_parent;
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
    subtreeOf,
    rebuildFromJsonl,
    watermark,
    close: () => {
      db.close?.();
    },
  };
};
