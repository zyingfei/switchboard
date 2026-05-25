// Bootstrap Bun's SQLite to use a system library that supports
// extension loading. Must be called BEFORE any `new Database(...)`
// runs anywhere in the process — bun:sqlite caches the library
// handle on first use and refuses subsequent setCustomSQLite calls
// with "SQLite already loaded".
//
// Imported FIRST from cli.ts so the call lands before
// connections/snapshot.ts or any other module touches Database.

import { existsSync } from 'node:fs';

const detectCustomSqlitePath = (): string | null => {
  const envPath = process.env['SIDETRACK_SQLITE_LIB'];
  if (typeof envPath === 'string' && envPath.length > 0 && existsSync(envPath)) {
    return envPath;
  }
  const candidates = [
    '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
    '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
    '/usr/lib/x86_64-linux-gnu/libsqlite3.so',
    '/usr/lib/aarch64-linux-gnu/libsqlite3.so',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
};

export const installCustomSqlite = (): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('bun:sqlite') as {
      Database: { setCustomSQLite?: (path: string) => void };
    };
    if (typeof mod.Database.setCustomSQLite !== 'function') return;
    const path = detectCustomSqlitePath();
    if (path === null) return;
    mod.Database.setCustomSQLite(path);
    // eslint-disable-next-line no-console
    console.warn(`[recall-v2] using custom SQLite library at ${path} (sqlite-vec capable)`);
  } catch (err) {
    // bun:sqlite unavailable (Node runtime) — silently skip.
    void err;
  }
};
