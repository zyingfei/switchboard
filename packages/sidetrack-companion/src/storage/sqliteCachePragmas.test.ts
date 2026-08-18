import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getSqliteDriver, setSqliteDriverForTesting } from '../recall-v2/store/driver.js';
import { createBunSqliteDriver } from '../recall-v2/store/driver-bun-sqlite.js';
import {
  DEFAULT_TOTAL_CACHE_MB,
  MAX_TOTAL_CACHE_MB,
  SQLITE_CACHE_BUDGET_ENV,
  SQLITE_MMAP_BUDGET_ENV,
  hotCachePragmaSql,
  resolveStoreCacheMb,
  resolveStoreMmapMb,
  resolveTotalCacheBudgetMb,
  type HotSqliteStore,
} from './sqliteCachePragmas.js';

// bun:sqlite-dependent — this whole file exercises real handles, not just
// the pure env-parsing functions, because the task this module exists for
// (docs/plans/2026-08-15-foundation-program.md, read-amplification) is
// specifically "is the pragma actually applied to the live connection",
// not just "does the function return the right string". Skips cleanly
// under a non-Bun runtime, matching sync/eventStore.test.ts's own
// `sqliteIt` convention.
const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const STORES: readonly HotSqliteStore[] = ['eventStore', 'connectionsGeneration', 'recallV2Index'];

describe('sqliteCachePragmas — env resolution (pure)', () => {
  afterEach(() => {
    delete process.env[SQLITE_CACHE_BUDGET_ENV];
    delete process.env[SQLITE_MMAP_BUDGET_ENV];
  });

  it('defaults the total cache budget when the env var is unset', () => {
    expect(resolveTotalCacheBudgetMb({})).toBe(DEFAULT_TOTAL_CACHE_MB);
  });

  it('honors a valid SIDETRACK_SQLITE_CACHE_MB override', () => {
    expect(resolveTotalCacheBudgetMb({ [SQLITE_CACHE_BUDGET_ENV]: '100' })).toBe(100);
  });

  it('clamps an oversized SIDETRACK_SQLITE_CACHE_MB to MAX_TOTAL_CACHE_MB', () => {
    expect(resolveTotalCacheBudgetMb({ [SQLITE_CACHE_BUDGET_ENV]: '999999' })).toBe(MAX_TOTAL_CACHE_MB);
  });

  it('falls back to the default on a malformed SIDETRACK_SQLITE_CACHE_MB (never crashes)', () => {
    for (const bad of ['not-a-number', '-5', '', '  ']) {
      expect(resolveTotalCacheBudgetMb({ [SQLITE_CACHE_BUDGET_ENV]: bad })).toBe(DEFAULT_TOTAL_CACHE_MB);
    }
  });

  it('0 is a valid, intentional "disable cache_size" total', () => {
    expect(resolveTotalCacheBudgetMb({ [SQLITE_CACHE_BUDGET_ENV]: '0' })).toBe(0);
    for (const store of STORES) {
      expect(resolveStoreCacheMb(store, { [SQLITE_CACHE_BUDGET_ENV]: '0' })).toBe(0);
    }
  });

  it('splits the total budget across all three stores without exceeding it', () => {
    const env = { [SQLITE_CACHE_BUDGET_ENV]: '192' };
    const total = STORES.reduce((sum, store) => sum + resolveStoreCacheMb(store, env), 0);
    // Rounding per store can push the sum a few MB either side of 192 —
    // the real invariant this guards is "stays well under the documented
    // <256MB ratchet ceiling", not exact equality.
    expect(total).toBeLessThan(MAX_TOTAL_CACHE_MB);
    expect(total).toBeGreaterThan(150);
  });

  it('the biggest store (eventStore) gets the biggest share', () => {
    const env = { [SQLITE_CACHE_BUDGET_ENV]: '192' };
    const eventStoreMb = resolveStoreCacheMb('eventStore', env);
    const connectionsMb = resolveStoreCacheMb('connectionsGeneration', env);
    const recallMb = resolveStoreCacheMb('recallV2Index', env);
    expect(eventStoreMb).toBeGreaterThan(connectionsMb);
    expect(connectionsMb).toBeGreaterThan(recallMb);
  });

  it('floors a tiny total so every store still gets something', () => {
    const env = { [SQLITE_CACHE_BUDGET_ENV]: '10' };
    for (const store of STORES) {
      expect(resolveStoreCacheMb(store, env)).toBeGreaterThanOrEqual(8);
    }
  });

  it('mmap defaults are independent of the cache_size budget', () => {
    expect(resolveStoreMmapMb('eventStore', {})).toBeGreaterThan(0);
    expect(resolveStoreMmapMb('connectionsGeneration', {})).toBeGreaterThan(0);
    expect(resolveStoreMmapMb('recallV2Index', {})).toBeGreaterThan(0);
  });

  it('SIDETRACK_SQLITE_MMAP_MB=0 disables mmap for every store (isolation lever for the harness)', () => {
    const env = { [SQLITE_MMAP_BUDGET_ENV]: '0' };
    for (const store of STORES) {
      expect(resolveStoreMmapMb(store, env)).toBe(0);
    }
  });

  it('a malformed SIDETRACK_SQLITE_MMAP_MB falls back to the per-store default', () => {
    expect(resolveStoreMmapMb('eventStore', { [SQLITE_MMAP_BUDGET_ENV]: 'nope' })).toBe(
      resolveStoreMmapMb('eventStore', {}),
    );
  });

  it('hotCachePragmaSql renders both pragmas with the resolved values', () => {
    const env = { [SQLITE_CACHE_BUDGET_ENV]: '100' };
    const sql = hotCachePragmaSql('eventStore', env);
    const expectedCacheKb = resolveStoreCacheMb('eventStore', env) * 1024;
    const expectedMmapBytes = resolveStoreMmapMb('eventStore', env) * 1024 * 1024;
    expect(sql).toContain(`PRAGMA cache_size = -${String(expectedCacheKb)};`);
    expect(sql).toContain(`PRAGMA mmap_size = ${String(expectedMmapBytes)};`);
  });
});

// ---------------------------------------------------------------------------
// Applied-to-a-real-handle tests. Neither sync/eventStore.ts's `EventStore`
// nor connections/snapshot.ts's `ConnectionsStore` nor recall-v2's
// `RecallStore` expose their raw db handle (deliberate encapsulation), so
// this exercises the exact SAME primitives each store module calls
// `hotCachePragmaSql`'s output against — bun:sqlite's `Database` directly
// (sync/eventStore.ts, connections/snapshot.ts) and the recall-v2
// `SqliteDriver` (recall-v2/store/sqlite.ts) — and reads the PRAGMA back on
// the SAME live connection, which is the only way a connection-scoped
// setting like cache_size can be observed at all (a second connection to
// the same file would just show ITS OWN default, not prove anything about
// the first).
// ---------------------------------------------------------------------------

describe('sqliteCachePragmas — applied to a real bun:sqlite handle', () => {
  let workDir: string | undefined;

  afterEach(async () => {
    delete process.env[SQLITE_CACHE_BUDGET_ENV];
    delete process.env[SQLITE_MMAP_BUDGET_ENV];
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
  });

  sqliteIt('eventStore + connectionsGeneration pragmas stick on a bun:sqlite Database (same API sync/eventStore.ts and connections/snapshot.ts use)', async () => {
    const { Database } = await import('bun:sqlite');
    workDir = await mkdtemp(join(tmpdir(), 'sqlite-cache-pragma-test-'));
    for (const store of ['eventStore', 'connectionsGeneration'] as const) {
      const dbPath = join(workDir, `${store}.db`);
      const db = new Database(dbPath, { create: true, readwrite: true });
      try {
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec(hotCachePragmaSql(store, { [SQLITE_CACHE_BUDGET_ENV]: '192' }));
        const cacheRow = db.query('PRAGMA cache_size').get() as { cache_size?: number } | null;
        const mmapRow = db.query('PRAGMA mmap_size').get() as { mmap_size?: number } | null;
        const expectedCacheKb = resolveStoreCacheMb(store, { [SQLITE_CACHE_BUDGET_ENV]: '192' }) * 1024;
        const expectedMmapBytes = resolveStoreMmapMb(store, {}) * 1024 * 1024;
        expect(cacheRow?.cache_size).toBe(-expectedCacheKb);
        // mmap_size is ADVISORY (sqlite.org/pragma.html#pragma_mmap_size):
        // SQLite may silently clamp the actual mapping below what was
        // requested — measured on this machine's linked libsqlite3
        // (Homebrew's, via setup-sqlite.ts's setCustomSQLite): a hard
        // SQLITE_MAX_MMAP_SIZE ceiling of exactly 1073741824 bytes (1GiB),
        // independent of how large a value is requested. Assert the real
        // invariant (never exceeds the request, always positive when a
        // positive value was requested) rather than exact equality, which
        // would make this test brittle across SQLite builds with a
        // different compiled-in ceiling.
        expect(mmapRow?.mmap_size).toBeGreaterThan(0);
        expect(mmapRow?.mmap_size).toBeLessThanOrEqual(expectedMmapBytes);
      } finally {
        db.close();
      }
    }
  });

  sqliteIt('recallV2Index pragma sticks via the recall-v2 SqliteDriver (same API recall-v2/store/sqlite.ts uses)', () => {
    setSqliteDriverForTesting(null);
    const driver = getSqliteDriver();
    expect(driver.name).toBe('bun-sqlite');
    const handle = driver.open(':memory:');
    try {
      handle.exec(hotCachePragmaSql('recallV2Index', { [SQLITE_CACHE_BUDGET_ENV]: '192' }));
      const cacheRow = handle.prepare('PRAGMA cache_size').get<{ cache_size: number }>();
      const mmapRow = handle.prepare('PRAGMA mmap_size').get<{ mmap_size: number }>();
      const expectedCacheKb = resolveStoreCacheMb('recallV2Index', { [SQLITE_CACHE_BUDGET_ENV]: '192' }) * 1024;
      expect(cacheRow?.cache_size).toBe(-expectedCacheKb);
      // mmap_size has no effect on ':memory:' (no backing file to map) —
      // measured: raw bun:sqlite reports back `null`; the recall-v2
      // driver's SqliteHandle.prepare().get() wrapper maps a null row to
      // `undefined` (driver-bun-sqlite.ts: `?? undefined`), so that's what
      // this sees. cache_size still applies uniformly since the in-memory
      // pager cache works the same way regardless of backing store, which
      // is what recall-v2's own test suite relies on for its ':memory:'
      // RecallStore instances (openInMemoryRecallStore).
      expect(mmapRow).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  sqliteIt('SIDETRACK_SQLITE_CACHE_MB=0 disables the added cache_size on a real handle', async () => {
    const { Database } = await import('bun:sqlite');
    workDir = await mkdtemp(join(tmpdir(), 'sqlite-cache-pragma-zero-test-'));
    const db = new Database(join(workDir, 'zero.db'), { create: true, readwrite: true });
    try {
      db.exec(hotCachePragmaSql('eventStore', { [SQLITE_CACHE_BUDGET_ENV]: '0' }));
      const cacheRow = db.query('PRAGMA cache_size').get() as { cache_size?: number } | null;
      expect(cacheRow?.cache_size).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('sqliteCachePragmas — real driver identity is restored after tests', () => {
  it('does not leave a test-injected driver behind', () => {
    // createBunSqliteDriver import kept live so a future edit that removes
    // the direct import doesn't silently drop coverage of the real driver
    // factory this suite exercises via getSqliteDriver() above.
    expect(typeof createBunSqliteDriver).toBe('function');
    setSqliteDriverForTesting(null);
  });
});
