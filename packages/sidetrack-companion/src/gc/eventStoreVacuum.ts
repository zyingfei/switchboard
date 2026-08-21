// F2 apply, event-store maintenance — VACUUM the typed event-store mirror
// (`_BAC/connections/event-store.db`).
//
// Hot-tail retirement (`analytics/hotTailRetirement.ts`) shrinks the
// HOT-TAIL JSONL by moving whole shards out of `_BAC/log`; it does nothing
// for the SQLite mirror's own on-disk size. SQLite never automatically
// reclaims free pages left behind by deletes (compact-engagement's
// `applyCompactionReceipt` row pruning, a future `rebuildFromJsonl`, or
// ordinary churn) — only an explicit `VACUUM` rewrites the file without the
// freed pages. `connections/snapshot.ts` already has its own VACUUM path,
// but that one is for the CONNECTIONS GRAPH generation only, and is a
// documented no-op under in-place publish (see
// docs/plans/2026-08-15-foundation-program.md, "Storage-tier incremental
// publish"). This is the event-store's first dedicated maintenance
// entrypoint.
//
// Same safety bar as compact-engagement / hot-tail retirement --apply:
// SIDETRACK_EVENT_STORE_VACUUM=1 arm switch (this module's own — the CLI
// does not bypass it) + the CLI takes the vault's recall process-lock
// first and refuses if a live companion holds it. VACUUM rewrites the
// WHOLE file in place; a live companion's open handle on the same file
// would see it change out from under it, and two writers racing a VACUUM
// against a live WAL user is exactly the kind of desync the process-lock
// exists to prevent (same reasoning as compact-engagement's own header
// comment). VACUUM itself is intrinsically non-lossy — SQLite guarantees
// byte-identical row content, only physical layout changes — so there is
// no additional proof-gate beyond "nothing else has this file open".

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export const EVENT_STORE_VACUUM_ARM_ENV = 'SIDETRACK_EVENT_STORE_VACUUM';

export const eventStoreVacuumArmed = (): boolean => {
  const raw = process.env[EVENT_STORE_VACUUM_ARM_ENV];
  return raw === '1' || raw === 'true';
};

export const eventStoreDbPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'connections', 'event-store.db');

export interface EventStoreVacuumResult {
  readonly vaultRoot: string;
  readonly dbPath: string;
  /** False when there is no event-store.db at all — a clean no-op, not an
   *  error (mirrors every other maintenance op's "nothing to do" posture). */
  readonly present: boolean;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly bytesReclaimed: number;
}

interface SqliteDatabase {
  readonly exec: (sql: string) => unknown;
  readonly close: () => void;
}

interface SqliteModule {
  readonly Database: new (
    filename: string,
    options?: { readonly readwrite?: boolean },
  ) => SqliteDatabase;
}

const loadSqlite = async (): Promise<SqliteModule> => {
  const module = (await import('bun:sqlite')) as Partial<SqliteModule>;
  if (typeof module.Database !== 'function') {
    throw new Error('bun:sqlite Database export is unavailable');
  }
  return { Database: module.Database };
};

/**
 * VACUUM the event-store mirror in place and report bytes before/after.
 * Absent file is a clean no-op (`present: false`, both byte counts 0) —
 * never creates the file. Caller (cli.ts) owns the arm-env check and the
 * recall process-lock; this function assumes both are already satisfied,
 * kept separate so it stays independently unit-testable without process
 * lock ceremony, matching `applyEngagementCompaction` /
 * `applyHotTailRetirement`'s own plan/apply split.
 */
export const runEventStoreVacuum = async (vaultRoot: string): Promise<EventStoreVacuumResult> => {
  const dbPath = eventStoreDbPath(vaultRoot);
  const before = await stat(dbPath).catch(() => null);
  if (before === null) {
    return { vaultRoot, dbPath, present: false, bytesBefore: 0, bytesAfter: 0, bytesReclaimed: 0 };
  }
  const { Database } = await loadSqlite();
  const db = new Database(dbPath, { readwrite: true });
  try {
    db.exec('VACUUM');
  } finally {
    db.close();
  }
  const after = await stat(dbPath);
  return {
    vaultRoot,
    dbPath,
    present: true,
    bytesBefore: before.size,
    bytesAfter: after.size,
    bytesReclaimed: Math.max(0, before.size - after.size),
  };
};
