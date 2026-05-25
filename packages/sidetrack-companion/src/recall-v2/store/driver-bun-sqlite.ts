// bun:sqlite driver. Pairs with setup-sqlite.ts (which installs the
// system libsqlite3 via Database.setCustomSQLite at process entry).

import type { SqliteDriver, SqliteHandle, SqliteStatement } from './driver.js';

let extensionProbe: boolean | null = null;

const probeExtensionsSupported = (): boolean => {
  if (extensionProbe !== null) return extensionProbe;
  let db: import('bun:sqlite').Database | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('bun:sqlite') as typeof import('bun:sqlite');
    db = new mod.Database(':memory:');
    // sqlite-vec ships a helper that calls loadExtension internally.
    // Use it as the probe so a "yes" here means we can actually load
    // vec, not just that the C API is exposed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vec = require('sqlite-vec') as { load?: (db: unknown) => void };
    if (typeof vec.load !== 'function') {
      extensionProbe = false;
      return false;
    }
    // vec.load() invokes db.loadExtension internally; succeeds only
    // when Bun was pointed at a system libsqlite3 with extensions on.
    vec.load(db);
    extensionProbe = true;
    return true;
  } catch {
    extensionProbe = false;
    return false;
  } finally {
    // Always close the probe db — without this a failed `vec.load`
    // would leak the :memory: handle for the process lifetime.
    try {
      db?.close();
    } catch {
      // best-effort; closing an already-broken handle can throw.
    }
  }
};

class BunSqliteHandle implements SqliteHandle {
  constructor(private readonly db: import('bun:sqlite').Database) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  loadExtension(path: string): void {
    // bun:sqlite's loadExtension only works when setCustomSQLite()
    // pointed Bun at a system libsqlite3 compiled with extension
    // loading enabled — see setup-sqlite.ts.
    (this.db as unknown as { loadExtension(p: string): void }).loadExtension(path);
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: readonly (string | number | null)[]) => {
        // bun:sqlite's run() returns { changes, lastInsertRowid } —
        // map to the narrower contract.
        const res = stmt.run(...(params as unknown[]));
        return { changes: Number(res.changes ?? 0) };
      },
      all: <T = unknown>(...params: readonly (string | number | null)[]): T[] =>
        stmt.all(...(params as unknown[])) as T[],
      get: <T = unknown>(...params: readonly (string | number | null)[]): T | undefined =>
        (stmt.get(...(params as unknown[])) as T | null) ?? undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}

export const createBunSqliteDriver = (): SqliteDriver => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('bun:sqlite') as typeof import('bun:sqlite');
  return {
    name: 'bun-sqlite',
    extensionsSupported: probeExtensionsSupported(),
    open: (path) => new BunSqliteHandle(new mod.Database(path)),
  };
};
