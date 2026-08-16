// F8 W3 — persistent repair queue (docs/plans/2026-08-16-f8-ivm-designs.md,
// "W3" + AMENDMENT 2). Root cause this store kills: every remaining
// scoped-delta bail class in connectionsMaterializer.ts used to fall
// back to a full (or hot-rebuild-suppressor-coalesced) rebuild of the
// ENTIRE connections graph in response to a bail on a HANDFUL of
// scopes. That is structurally wrong — a full rebuild writes a
// hundreds-of-MB generation to answer a KB-scale logical question
// ("did these few scopes change correctly?").
//
// W3 demotes every non-recovery-tier bail to:
//   1. a progress-only write (the existing pattern — frontier advances,
//      served graph is byte-unchanged), and
//   2. an enqueue of the drain's dirty scopes + bail reason into THIS
//      store.
//
// AMENDMENT 2 is the key structural move: there is no new worker
// process draining this queue. The EXISTING reconcile child (the same
// single writer that runs every scoped/full drain) drains a bounded
// batch off the front of this queue at the START of its next
// buildAndWrite, unions the drained scopes into that drain's own
// `dirtyScopes`, and lets them ride the ordinary scoped-recompute +
// replaceScopeRows path. If the underlying cause is now resolved (the
// W1 thread-register store / W2 search-index stores have durable,
// window-independent history for that scope), the scope heals and is
// gone from the queue for good. If it is NOT resolved (e.g. the W1/W2
// stores are disabled), the SAME structural gate that caused the
// original bail fires again on the healing attempt, and the bail path
// re-enqueues the scope with a fresh timestamp — so an unhealable
// scope recycles forever rather than being silently dropped OR
// silently served wrong. `depth()` / `stats()` feed
// workGraphHealth.ts's repairQueueDepth gauge specifically so that
// recycling is visible, never silent.
//
// Storage: a SQLite sidecar, same driver/loader/lifecycle pattern as
// threadRegisterStore.ts (bun:sqlite, WAL, busy_timeout). Deduped on
// (scope_kind, scope_id) — a scope re-bailing before its previous
// queue entry is drained just refreshes the reason/timestamp in place
// rather than accumulating duplicate rows.

import { join } from 'node:path';

import type { Scope, ScopeKind } from '../sync/contract/connectionsScopes.js';

export interface RepairQueueEntry {
  readonly id: number;
  readonly scope: Scope;
  readonly reason: string;
  readonly enqueuedAt: string;
}

export interface RepairQueueStats {
  readonly depth: number;
  readonly oldestEnqueuedAt: string | null;
}

export interface NeedsRepairState {
  readonly reason: string;
  readonly command: string;
  readonly detectedAt: string;
}

export interface RepairQueueStore {
  /** Idempotent per (scope_kind, scope_id): refreshes reason + timestamp on conflict. No-op on an empty scope list. */
  readonly enqueue: (scopes: readonly Scope[], reason: string) => void;
  /** Dequeues (removes) up to n oldest entries and returns them, oldest first. */
  readonly takeBatch: (n: number) => readonly RepairQueueEntry[];
  readonly depth: () => number;
  readonly stats: () => RepairQueueStats;
  /** Durable cross-process "run the CLI" marker (Recovery consent rule). Singleton — a fresh mark overwrites the previous one. */
  readonly markNeedsRepair: (reason: string, command: string) => void;
  readonly clearNeedsRepair: () => void;
  readonly readNeedsRepair: () => NeedsRepairState | null;
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
  CREATE TABLE IF NOT EXISTS repair_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    UNIQUE(scope_kind, scope_id)
  );
  CREATE TABLE IF NOT EXISTS needs_repair_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    reason TEXT NOT NULL,
    command TEXT NOT NULL,
    detected_at TEXT NOT NULL
  );
`;

const isScopeKind = (value: unknown): value is ScopeKind =>
  value === 'visit' ||
  value === 'url' ||
  value === 'tab-session' ||
  value === 'workstream' ||
  value === 'thread' ||
  value === 'topic';

export const createRepairQueueStore = async (vaultRoot: string): Promise<RepairQueueStore> => {
  const { Database } = await loadSqlite();
  const dbPath = join(vaultRoot, '_BAC', 'connections', 'repair-queue.db');
  const db = new Database(dbPath, { create: true, readwrite: true });
  db.exec(SCHEMA);

  const upsertEntry = db.query(
    `INSERT INTO repair_queue (scope_kind, scope_id, reason, enqueued_at)
     VALUES (?,?,?,?)
     ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
       reason = excluded.reason,
       enqueued_at = excluded.enqueued_at`,
  );
  const selectBatch = db.query(
    'SELECT id, scope_kind, scope_id, reason, enqueued_at FROM repair_queue ORDER BY id ASC LIMIT ?',
  );
  const deleteById = db.query('DELETE FROM repair_queue WHERE id = ?');
  const countAll = db.query('SELECT COUNT(*) AS n FROM repair_queue');
  const oldestTimestamp = db.query('SELECT MIN(enqueued_at) AS oldest FROM repair_queue');
  const upsertNeedsRepair = db.query(
    `INSERT INTO needs_repair_state (id, reason, command, detected_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       reason = excluded.reason,
       command = excluded.command,
       detected_at = excluded.detected_at`,
  );
  const selectNeedsRepair = db.query(
    'SELECT reason, command, detected_at FROM needs_repair_state WHERE id = 1',
  );
  const deleteNeedsRepair = db.query('DELETE FROM needs_repair_state WHERE id = 1');

  const enqueue = (scopes: readonly Scope[], reason: string): void => {
    if (scopes.length === 0) return;
    const enqueuedAt = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const scope of scopes) {
        if (scope.id.length === 0) continue;
        upsertEntry.run(scope.kind, scope.id, reason, enqueuedAt);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const takeBatch = (n: number): readonly RepairQueueEntry[] => {
    if (n <= 0) return [];
    const rows = selectBatch.all(n) as readonly {
      readonly id: number;
      readonly scope_kind: string;
      readonly scope_id: string;
      readonly reason: string;
      readonly enqueued_at: string;
    }[];
    if (rows.length === 0) return [];
    const entries: RepairQueueEntry[] = [];
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        deleteById.run(row.id);
        if (!isScopeKind(row.scope_kind)) continue;
        entries.push({
          id: row.id,
          scope: { kind: row.scope_kind, id: row.scope_id },
          reason: row.reason,
          enqueuedAt: row.enqueued_at,
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return entries;
  };

  const depth = (): number => {
    const row = countAll.get() as { readonly n: number } | null | undefined;
    return row?.n ?? 0;
  };

  const stats = (): RepairQueueStats => {
    const row = oldestTimestamp.get() as { readonly oldest: string | null } | null | undefined;
    return { depth: depth(), oldestEnqueuedAt: row?.oldest ?? null };
  };

  const markNeedsRepair = (reason: string, command: string): void => {
    upsertNeedsRepair.run(reason, command, new Date().toISOString());
  };

  const clearNeedsRepair = (): void => {
    deleteNeedsRepair.run();
  };

  const readNeedsRepair = (): NeedsRepairState | null => {
    const row = selectNeedsRepair.get() as
      | { readonly reason: string; readonly command: string; readonly detected_at: string }
      | null
      | undefined;
    if (row === undefined || row === null) return null;
    return { reason: row.reason, command: row.command, detectedAt: row.detected_at };
  };

  return {
    enqueue,
    takeBatch,
    depth,
    stats,
    markNeedsRepair,
    clearNeedsRepair,
    readNeedsRepair,
    close: () => {
      db.close?.();
    },
  };
};
