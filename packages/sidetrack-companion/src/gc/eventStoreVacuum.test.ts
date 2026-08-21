import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { eventStoreDbPath, eventStoreVacuumArmed, runEventStoreVacuum } from './eventStoreVacuum.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

interface SqliteStatement {
  readonly run: (...params: readonly unknown[]) => unknown;
  readonly get: (...params: readonly unknown[]) => unknown;
}

interface SqliteDb {
  readonly exec: (sql: string) => unknown;
  readonly query: (sql: string) => SqliteStatement;
  readonly close: () => void;
}

const loadDatabase = async (): Promise<new (path: string) => SqliteDb> => {
  const module = (await import('bun:sqlite')) as { readonly Database: new (path: string) => SqliteDb };
  return module.Database;
};

describe('eventStoreVacuumArmed', () => {
  let prior: string | undefined;

  beforeEach(() => {
    prior = process.env['SIDETRACK_EVENT_STORE_VACUUM'];
    delete process.env['SIDETRACK_EVENT_STORE_VACUUM'];
  });

  afterEach(() => {
    if (prior === undefined) delete process.env['SIDETRACK_EVENT_STORE_VACUUM'];
    else process.env['SIDETRACK_EVENT_STORE_VACUUM'] = prior;
  });

  it('defaults OFF and only arms on an explicit 1/true', () => {
    expect(eventStoreVacuumArmed()).toBe(false);
    process.env['SIDETRACK_EVENT_STORE_VACUUM'] = 'yes-please';
    expect(eventStoreVacuumArmed()).toBe(false);
    process.env['SIDETRACK_EVENT_STORE_VACUUM'] = '1';
    expect(eventStoreVacuumArmed()).toBe(true);
    process.env['SIDETRACK_EVENT_STORE_VACUUM'] = 'true';
    expect(eventStoreVacuumArmed()).toBe(true);
  });
});

describe('runEventStoreVacuum', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-event-store-vacuum-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('is a clean no-op when event-store.db does not exist', async () => {
    const result = await runEventStoreVacuum(vaultRoot);
    expect(result).toMatchObject({
      present: false,
      bytesBefore: 0,
      bytesAfter: 0,
      bytesReclaimed: 0,
      dbPath: eventStoreDbPath(vaultRoot),
    });
    await expect(stat(eventStoreDbPath(vaultRoot))).rejects.toThrow();
  });

  sqliteIt('reclaims freelist bytes from a bloated fixture without losing any surviving rows', async () => {
    const Database = await loadDatabase();
    const dbPath = eventStoreDbPath(vaultRoot);
    const db = new Database(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE events (id INTEGER PRIMARY KEY, replica_id TEXT NOT NULL, payload TEXT NOT NULL);
    `);
    // Insert a large volume of rows, then delete most of them — this
    // leaves free pages in the b-tree that only VACUUM reclaims. A row
    // wide enough (2KB) that thousands of them produce a measurable file.
    const bigPayload = 'x'.repeat(2048);
    const insert = db.query('INSERT INTO events (replica_id, payload) VALUES (?, ?)');
    for (let i = 0; i < 4000; i += 1) insert.run('replica-a', bigPayload);
    // A canary row that survives the deletion — proves VACUUM never drops
    // live data, only reclaims what deletes already freed.
    db.query('INSERT INTO events (replica_id, payload) VALUES (?, ?)').run('replica-a', 'canary-row');
    db.query('DELETE FROM events WHERE payload = ?').run(bigPayload);
    db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
    db.close();

    const bytesBefore = (await stat(dbPath)).size;

    const result = await runEventStoreVacuum(vaultRoot);

    expect(result.present).toBe(true);
    expect(result.bytesBefore).toBe(bytesBefore);
    expect(result.bytesAfter).toBeLessThan(bytesBefore);
    expect(result.bytesReclaimed).toBe(bytesBefore - result.bytesAfter);
    expect(result.bytesReclaimed).toBeGreaterThan(0);

    const after = new Database(dbPath);
    try {
      const row = after.query('SELECT payload FROM events WHERE payload = ?').get('canary-row') as
        | { readonly payload: string }
        | undefined;
      expect(row?.payload).toBe('canary-row');
      const count = after.query('SELECT COUNT(*) AS n FROM events').get() as { readonly n: number };
      expect(count.n).toBe(1);
    } finally {
      after.close();
    }
  });
});
