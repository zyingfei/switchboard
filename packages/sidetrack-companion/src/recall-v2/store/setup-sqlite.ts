// Bootstrap Bun's SQLite to use a system library that supports
// extension loading. Must be called BEFORE any `new Database(...)`
// runs anywhere in the process — bun:sqlite caches the library
// handle on first use and refuses subsequent setCustomSQLite calls
// with "SQLite already loaded".
//
// IMPORTANT — module side effect:
//   The setCustomSQLite call runs at MODULE EVALUATION time, not on a
//   manual `installCustomSqlite()` call from cli.ts. ESM hoists all
//   `import` declarations above the importing module's body, so a
//   "call this after import" pattern is racy — any other static
//   import in cli.ts that transitively touches bun:sqlite could
//   construct a Database BEFORE the call.
//
//   The fix: do the work as a side effect during this module's own
//   evaluation, then `cli.ts` just needs to import this module FIRST
//   (depth-first import resolution evaluates the imported module
//   completely before moving to the next import in the same
//   document). The exported `installCustomSqlite` is now a no-op
//   kept for backwards compatibility + manual re-probing in tests.

import { existsSync } from 'node:fs';

const detectCustomSqlitePath = (): string | null => {
  const envPath = process.env['SIDETRACK_SQLITE_LIB'];
  if (typeof envPath === 'string') {
    // Explicit opt-out: run against Bun's built-in SQLite (no sqlite-vec).
    // Used by CI so the test suite matches the local dev default, where
    // no system libsqlite3 sits on the probe path. A vec-capable system
    // lib (e.g. Ubuntu's /usr/lib/.../libsqlite3.so) enforces strict vec
    // column dimensions and rejects the low-dimension fixtures some
    // recall/connections tests feed — a test-fixture mismatch, not a
    // product issue. See the vec-integration-lane followup.
    const normalized = envPath.trim().toLowerCase();
    if (['off', 'none', '0', 'false', 'disabled'].includes(normalized)) return null;
    if (envPath.length > 0 && existsSync(envPath)) return envPath;
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

let installed = false;

const doInstall = (): void => {
  if (installed) return;
  installed = true;
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

// Side effect: run on module evaluation so import order alone is
// sufficient to guarantee setCustomSQLite fires before any other
// import in cli.ts evaluates Database. Do NOT remove this call.
doInstall();

/** Kept for callers that want to retry installation explicitly (tests).
 *  Idempotent — bun:sqlite only honors setCustomSQLite once per
 *  process. */
export const installCustomSqlite = (): void => {
  doInstall();
};
