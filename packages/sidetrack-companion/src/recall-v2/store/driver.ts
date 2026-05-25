// Driver abstraction for SQLite + sqlite-vec.
//
// Decision history (2026-05-24):
//   The user asked us to move vector-enabled SQLite access "behind a
//   Node adapter, using node:sqlite with allowExtension: true or
//   better-sqlite3, both of which document extension-loading paths."
//
//   At the time of writing, the companion runs under Bun, and:
//     - Bun does NOT expose `node:sqlite` (still missing built-in)
//     - Bun does NOT load `better-sqlite3` (oven-sh/bun#4290, open)
//   So neither of the user's suggested concrete drivers is callable
//   under our current runtime.
//
//   The Bun bundled SQLite (bun:sqlite) blocks `loadExtension` by
//   security default, but `Database.setCustomSQLite()` lets us point
//   Bun at a system libsqlite3 compiled with extension loading. That
//   path is what `setup-sqlite.ts` wires; it works on machines with
//   Homebrew's `sqlite` formula installed (or any libsqlite3.so/dylib
//   on the search path / via SIDETRACK_SQLITE_LIB).
//
//   This file is the SEAM: the rest of recall-v2 talks to `SqliteDriver`,
//   not to bun:sqlite directly. When Bun ships node:sqlite or
//   better-sqlite3 support, dropping a second driver in here and
//   selecting it via env is one file's worth of work — no caller
//   changes. That is the spirit of the user's "Node adapter"
//   request, even though the concrete second driver can't land today.

export interface SqliteStatement {
  run(...params: readonly (string | number | null)[]): { changes: number };
  all<T = unknown>(...params: readonly (string | number | null)[]): T[];
  get<T = unknown>(...params: readonly (string | number | null)[]): T | undefined;
}

export interface SqliteHandle {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  loadExtension(path: string): void;
  close(): void;
}

export interface SqliteDriver {
  readonly name: string;
  /** True if this driver can `loadExtension`. The bun:sqlite driver
   *  reports true only when setup-sqlite.ts pointed Bun at a system
   *  libsqlite3 with extension loading enabled. */
  readonly extensionsSupported: boolean;
  open(path: string): SqliteHandle;
}

let cachedDriver: SqliteDriver | null = null;

/** Resolve the active driver. Today: bun:sqlite. Future: better-sqlite3
 *  or node:sqlite when Bun supports them — gated behind env so callers
 *  don't need to know which is live. */
export const getSqliteDriver = (): SqliteDriver => {
  if (cachedDriver !== null) return cachedDriver;
  // Future selection logic goes here. For now there is exactly one
  // working driver under Bun.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createBunSqliteDriver } = require('./driver-bun-sqlite.js') as {
    createBunSqliteDriver: () => SqliteDriver;
  };
  cachedDriver = createBunSqliteDriver();
  return cachedDriver;
};

/** Test-only — lets tests inject an in-memory or alternate driver. */
export const setSqliteDriverForTesting = (driver: SqliteDriver | null): void => {
  cachedDriver = driver;
};
