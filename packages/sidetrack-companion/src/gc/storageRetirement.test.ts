import { existsSync, utimesSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  generationDbPath,
  reconcileLegacyToPublished,
  writePointer,
} from '../connections/generationBuffer.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createEventStore } from '../sync/eventStore.js';
import { applyStorageRetirementPlan, buildStorageRetirementPlan } from './storageRetirement.js';

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
  const specifier = 'bun:sqlite';
  const module = (await import(specifier)) as { readonly Database: new (path: string) => SqliteDb };
  return module.Database;
};

const acceptedEvent = (bacId = 'bac-capture-1'): AcceptedEvent => ({
  clientEventId: 'client-1',
  dot: { replicaId: 'replica-a', seq: 1 },
  deps: {},
  aggregateId: bacId,
  type: 'capture.recorded',
  payload: {
    bac_id: bacId,
    threadUrl: 'https://example.test/thread',
    provider: 'test',
    title: 'Thread',
    capturedAt: '2026-01-01T12:00:00.000Z',
    turns: [
      {
        ordinal: 1,
        role: 'user',
        text: 'hello',
        capturedAt: '2026-01-01T12:00:00.000Z',
      },
    ],
  },
  acceptedAtMs: Date.parse('2026-01-01T12:00:01.000Z'),
});

describe('proof-gated storage retirement', () => {
  let vaultRoot: string;
  let priorDoubleBuffer: string | undefined;
  let priorEventStore: string | undefined;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-storage-retirement-'));
    await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
    priorDoubleBuffer = process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'];
    priorEventStore = process.env['SIDETRACK_EVENT_STORE'];
    delete process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'];
    delete process.env['SIDETRACK_EVENT_STORE'];
  });

  afterEach(async () => {
    if (priorDoubleBuffer === undefined) delete process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'];
    else process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'] = priorDoubleBuffer;
    if (priorEventStore === undefined) delete process.env['SIDETRACK_EVENT_STORE'];
    else process.env['SIDETRACK_EVENT_STORE'] = priorEventStore;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const seedGeneration = async (genId: string, label: string): Promise<string> => {
    const Database = await loadDatabase();
    const connectionsDir = join(vaultRoot, '_BAC', 'connections');
    const path = generationDbPath(connectionsDir, genId);
    const db = new Database(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    db.query('INSERT INTO metadata (key, data) VALUES (?, ?)').run(
      'current',
      JSON.stringify({
        scope: { kind: 'all' },
        updatedAt: '2026-01-01T00:00:00.000Z',
        nodeCount: 0,
        edgeCount: 0,
        snapshotRevision: label,
        contentSignature: 'a'.repeat(64),
      }),
    );
    db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
    db.close();
    return path;
  };

  const writeCanonical = async (event: AcceptedEvent): Promise<string> => {
    const dir = join(vaultRoot, '_BAC', 'log', event.dot.replicaId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, '2026-01-01.jsonl');
    await writeFile(path, `${JSON.stringify(event)}\n`, 'utf8');
    return path;
  };

  sqliteIt('retires current.db only after S1 read-back and recreates it on rollback', async () => {
    const connectionsDir = join(vaultRoot, '_BAC', 'connections');
    const active = await seedGeneration('10-active', 'served');
    writePointer(connectionsDir, '10-active');
    const legacy = join(connectionsDir, 'current.db');
    await writeFile(legacy, await readFile(active));

    const plan = await buildStorageRetirementPlan(vaultRoot);
    const candidate = plan.candidates.find((row) => row.id === 'legacy-current-db');
    expect(candidate?.proof.status).toBe('verified');

    const result = await applyStorageRetirementPlan(plan, { confirmPlanId: plan.planId });
    expect(result.errors).toEqual([]);
    expect(result.removedCandidates).toContain('legacy-current-db');
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(active)).toBe(true);

    // The rollback path does not need a permanently resident duplicate: it
    // reconstructs current.db from the complete immutable pointer generation.
    expect(reconcileLegacyToPublished(connectionsDir)).toBe('10-active');
    expect(existsSync(legacy)).toBe(true);
    const Database = await loadDatabase();
    const restored = new Database(legacy);
    const row = restored.query('SELECT data FROM metadata WHERE key = ?').get('current') as {
      readonly data: string;
    };
    expect(JSON.parse(row.data)).toMatchObject({ snapshotRevision: 'served' });
    restored.close();
  });

  sqliteIt(
    'retires the disabled event-store mirror and rebuilds it from canonical JSONL',
    async () => {
      const event = acceptedEvent();
      const logPath = await writeCanonical(event);
      const store = await createEventStore(vaultRoot);
      store.ingest(event);
      store.close();
      // Temp-vault proof of quiescence. Production fails closed while this
      // shared-memory sidecar exists because another process may hold SQLite.
      await rm(join(vaultRoot, '_BAC', 'connections', 'event-store.db-shm'), { force: true });

      const plan = await buildStorageRetirementPlan(vaultRoot);
      const candidate = plan.candidates.find((row) => row.id === 'event-store-mirror');
      expect(candidate?.proof.status).toBe('verified');
      const result = await applyStorageRetirementPlan(plan, { confirmPlanId: plan.planId });
      expect(result.errors).toEqual([]);
      expect(existsSync(join(vaultRoot, '_BAC', 'connections', 'event-store.db'))).toBe(false);
      expect(JSON.parse((await readFile(logPath, 'utf8')).trim())).toEqual(event);

      const rebuilt = await createEventStore(vaultRoot);
      await rebuilt.rebuildFromJsonl(join(vaultRoot, '_BAC', 'log'));
      expect(rebuilt.readSince({})).toEqual([event]);
      rebuilt.close();
    },
  );

  sqliteIt('keeps compacted event-store receipts until their manifest is also proven', async () => {
    const event = acceptedEvent();
    await writeCanonical(event);
    const store = await createEventStore(vaultRoot);
    store.ingest(event);
    store.close();
    const Database = await loadDatabase();
    const db = new Database(join(vaultRoot, '_BAC', 'connections', 'event-store.db'));
    db.query(
      `INSERT INTO compacted_events
         (replica_id, seq, type, accepted_at_ms, shard_path, receipt_sha256)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('replica-a', 2, 'engagement.interval.observed', 1, 'replica-a/2026-01-01.jsonl', 'x');
    db.close();

    const plan = await buildStorageRetirementPlan(vaultRoot);
    expect(plan.candidates.find((row) => row.id === 'event-store-mirror')?.proof).toMatchObject({
      status: 'refuted',
    });
  });

  sqliteIt('retires a fully mirrored spool day but preserves canonical bytes', async () => {
    const event = acceptedEvent();
    const canonicalPath = await writeCanonical(event);
    const spoolDir = join(vaultRoot, '_BAC', 'events');
    await mkdir(spoolDir, { recursive: true });
    const spoolPath = join(spoolDir, '2026-01-01.jsonl');
    await writeFile(
      spoolPath,
      `${JSON.stringify({
        ...(event.payload as Record<string, unknown>),
        revision: 'r1',
        requestId: 'req1',
        receivedAt: '2026-01-01T12:00:02.000Z',
      })}\n`,
      'utf8',
    );
    const canonicalBefore = await readFile(canonicalPath, 'utf8');

    const plan = await buildStorageRetirementPlan(vaultRoot);
    expect(
      plan.candidates.find((row) => row.id === 'ingress-spool-day:2026-01-01')?.proof.status,
    ).toBe('verified');
    await applyStorageRetirementPlan(plan, { confirmPlanId: plan.planId });

    expect(existsSync(spoolPath)).toBe(false);
    expect(await readFile(canonicalPath, 'utf8')).toBe(canonicalBefore);
  });

  sqliteIt('rejects a stale plan before removing a tampered spool day', async () => {
    const event = acceptedEvent();
    await writeCanonical(event);
    const spoolDir = join(vaultRoot, '_BAC', 'events');
    await mkdir(spoolDir, { recursive: true });
    const spoolPath = join(spoolDir, '2026-01-01.jsonl');
    await writeFile(spoolPath, `${JSON.stringify(event.payload)}\n`, 'utf8');
    const plan = await buildStorageRetirementPlan(vaultRoot);

    await writeFile(spoolPath, `${JSON.stringify(event.payload)}\nnot-json\n`, 'utf8');
    await expect(applyStorageRetirementPlan(plan, { confirmPlanId: plan.planId })).rejects.toThrow(
      'plan is stale',
    );
    expect(existsSync(spoolPath)).toBe(true);
  });

  sqliteIt(
    'collects an aged orphan only while the active S1 generation remains readable',
    async () => {
      const connectionsDir = join(vaultRoot, '_BAC', 'connections');
      const active = await seedGeneration('20-active', 'served');
      const orphan = await seedGeneration('19-orphan', 'old');
      writePointer(connectionsDir, '20-active');
      const old = new Date(Date.now() - 2 * 60 * 60_000);
      for (const path of [orphan, `${orphan}-wal`, `${orphan}-shm`]) {
        if (existsSync(path)) utimesSync(path, old, old);
      }

      const plan = await buildStorageRetirementPlan(vaultRoot);
      const candidate = plan.candidates.find((row) => row.id === 'generation-orphan:19-orphan');
      expect(candidate?.proof.status).toBe('verified');
      await applyStorageRetirementPlan(plan, { confirmPlanId: plan.planId });

      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(active)).toBe(true);
      const Database = await loadDatabase();
      const reader = new Database(active);
      expect(reader.query('PRAGMA quick_check').get()).toBeDefined();
      reader.close();
    },
  );

  sqliteIt('fails closed when S1 signature proof is missing', async () => {
    const connectionsDir = join(vaultRoot, '_BAC', 'connections');
    const active = await seedGeneration('30-active', 'served');
    writePointer(connectionsDir, '30-active');
    const Database = await loadDatabase();
    const db = new Database(active);
    db.query('UPDATE metadata SET data = ? WHERE key = ?').run(
      JSON.stringify({ snapshotRevision: 'pre-s1' }),
      'current',
    );
    db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
    db.close();
    await writeFile(join(connectionsDir, 'current.db'), 'legacy-anchor', 'utf8');

    const plan = await buildStorageRetirementPlan(vaultRoot);
    expect(plan.candidates.find((row) => row.id === 'legacy-current-db')?.proof).toMatchObject({
      status: 'refuted',
    });
    expect(plan.reclaimableBytes).toBe(0);
  });
});
