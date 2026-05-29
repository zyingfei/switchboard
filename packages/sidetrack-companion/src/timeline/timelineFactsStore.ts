// Derived, persistent fact store for timeline-day projections.
//
// The companion's source of truth is the causal JSONL event log. The
// connections materializer historically rebuilt timeline days by
// filtering the full merged AcceptedEvent[] every drain. This store
// persists the browser.timeline.observed payloads in SQLite so the
// materializer can catch up by watermark, then reconstruct the same
// pure timeline-day projection from compact fact rows.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BROWSER_TIMELINE_OBSERVED,
  isBrowserTimelineObservedPayload,
  type BrowserTimelineObservedPayload,
} from './events.js';
import {
  timelineDaysFromTimelineEvents,
  type TimelineDayProjectionWithDimensions,
} from './timelineDays.js';
import type { AcceptedEvent, VersionVector } from '../sync/causal.js';

export interface TimelineFactsStore {
  /** Idempotent by (replicaId, seq). Projects valid timeline observations; ignores all others. */
  readonly ingest: (event: AcceptedEvent) => void;
  /** Batch ingest in one transaction. Returns the count actually projected. */
  readonly ingestMany: (events: readonly AcceptedEvent[]) => number;
  /** Ingest only events past the persisted per-replica watermark. */
  readonly catchUp: (events: readonly AcceptedEvent[]) => Promise<number>;
  /** Byte-equivalent twin of Connections' legacy buildTimelineDays(merged). */
  readonly readTimelineDays: () => readonly TimelineDayProjectionWithDimensions[];
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
  CREATE TABLE IF NOT EXISTS timeline_observed_fact (
    replica_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    accepted_at_ms INTEGER NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (replica_id, seq)
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

export const createTimelineFactsStore = async (vaultRoot: string): Promise<TimelineFactsStore> => {
  const { Database } = await loadSqlite();
  const dbPath = join(vaultRoot, '_BAC', 'connections', 'timeline-facts.db');
  const db = new Database(dbPath, { create: true, readwrite: true });
  db.exec(SCHEMA);

  const upsertTimelineObserved = db.query(
    `INSERT OR IGNORE INTO timeline_observed_fact
       (replica_id, seq, accepted_at_ms, payload)
     VALUES (?,?,?,?)`,
  );
  const bumpWatermark = db.query(
    `INSERT INTO ingest_watermark (replica_id, max_seq) VALUES (?, ?)
     ON CONFLICT(replica_id) DO UPDATE SET max_seq = MAX(max_seq, excluded.max_seq)`,
  );

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
    let projected = false;
    if (
      event.type === BROWSER_TIMELINE_OBSERVED &&
      isBrowserTimelineObservedPayload(event.payload)
    ) {
      upsertTimelineObserved.run(replicaId, seq, event.acceptedAtMs, JSON.stringify(event.payload));
      projected = true;
    }
    // Watermark advances for EVERY event so catchUp can skip the whole
    // log tail, not just timeline-relevant events.
    bumpWatermark.run(replicaId, seq);
    return projected;
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

  const readTimelineDays = (): readonly TimelineDayProjectionWithDimensions[] => {
    const events: AcceptedEvent[] = [];
    for (const row of db
      .query(
        `SELECT replica_id, seq, accepted_at_ms, payload
         FROM timeline_observed_fact
         ORDER BY replica_id, seq`,
      )
      .all()) {
      try {
        const payload = JSON.parse(stringField(row, 'payload')) as unknown;
        if (!isBrowserTimelineObservedPayload(payload)) continue;
        events.push(reconstructTimelineEvent(row, payload));
      } catch {
        // skip malformed stored payload; JSONL stays authoritative
      }
    }
    return timelineDaysFromTimelineEvents(events);
  };

  const rebuildFromJsonl = async (logRoot: string): Promise<void> => {
    // True rebuild/repair: clear derived facts + watermark so stale rows
    // from a prior state can't survive. JSONL stays authoritative.
    db.exec(`
      DELETE FROM timeline_observed_fact;
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
    readTimelineDays,
    rebuildFromJsonl,
    watermark,
    close: () => {
      db.close?.();
    },
  };
};

// Minimal AcceptedEvent reconstruction for timelineDaysFromTimelineEvents,
// which reads only type and the validated timeline payload. The causal
// fields are retained for deterministic ordering diagnostics and tests.
const reconstructTimelineEvent = (
  row: unknown,
  payload: BrowserTimelineObservedPayload,
): AcceptedEvent => ({
  clientEventId: '',
  dot: { replicaId: stringField(row, 'replica_id'), seq: numberField(row, 'seq') },
  deps: {},
  aggregateId: '',
  type: BROWSER_TIMELINE_OBSERVED,
  payload,
  acceptedAtMs: numberField(row, 'accepted_at_ms'),
});
