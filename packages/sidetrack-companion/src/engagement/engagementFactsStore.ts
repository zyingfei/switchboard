// Derived, persistent fact store for engagement classifier inputs.
//
// The companion's source of truth is the causal JSONL event log. The
// connections materializer historically re-derived engagement inputs by
// walking the full `AcceptedEvent[]` (mergedMemo) every drain — three
// passes over ~180k parsed objects (navigation fold, engagement fold,
// snippet lineage). This store moves the four engagement-relevant event
// types into compact SQLite rows so the materializer can read classifier
// inputs without retaining or re-walking the raw object graph.
//
// It is DERIVED and REBUILDABLE: if the DB is missing/stale/corrupt, the
// JSONL log remains authoritative and `rebuildFromJsonl` repopulates it.
// Idempotent by (replicaId, seq) so re-ingesting the same event is safe.
//
// Byte-equivalence with the legacy path is structural: `readClassifierInputs`
// reconstructs the exact `EngagementAccumulator` operations via
// `engagementInputsFromFacts` (see producers/engagement-class-revision.ts),
// reusing the unchanged derive + `projectSnippetLineage`.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type EngagementSessionFactRow,
  engagementInputsFromFacts,
  type NavigationVisitFactRow,
} from '../producers/engagement-class-revision.js';
import {
  ENGAGEMENT_SESSION_AGGREGATED,
  isEngagementSessionAggregatedPayload,
} from './events.js';
import type { EngagementClassifierInput } from '../connections/engagementClassifier.js';
import { NAVIGATION_COMMITTED, isNavigationCommittedPayload } from '../navigation/events.js';
import {
  SELECTION_COPIED,
  SELECTION_PASTED,
  isSelectionCopiedPayload,
  isSelectionPastedPayload,
  type SelectionCopiedPayload,
  type SelectionPastedPayload,
} from '../snippets/events.js';
import type { AcceptedEvent, VersionVector } from '../sync/causal.js';
import type { TimelineDayProjection } from '../timeline/projection.js';

export interface EngagementFactsStore {
  /** Idempotent by (replicaId, seq). Projects the four relevant event
   * types into fact rows; ignores all others. */
  readonly ingest: (event: AcceptedEvent) => void;
  /** Batch ingest in one transaction. Returns the count actually projected. */
  readonly ingestMany: (events: readonly AcceptedEvent[]) => number;
  /** Ingest only events past the persisted per-replica watermark.
   * Async + chunked so a cold full seed (~180k events) yields to the
   * event loop instead of blocking the main thread. */
  readonly catchUp: (events: readonly AcceptedEvent[]) => Promise<number>;
  /** Byte-equivalent twin of buildEngagementClassifierInputs(merged, days). */
  readonly readClassifierInputs: (
    timelineDays: readonly TimelineDayProjection[],
  ) => readonly EngagementClassifierInput[];
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
  CREATE TABLE IF NOT EXISTS engagement_session_fact (
    replica_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    accepted_at_ms INTEGER NOT NULL,
    visit_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    active_ms INTEGER NOT NULL,
    visible_ms INTEGER NOT NULL,
    focused_window_ms INTEGER NOT NULL,
    idle_ms INTEGER NOT NULL,
    foreground_bursts INTEGER NOT NULL,
    return_count INTEGER NOT NULL,
    scroll_events INTEGER NOT NULL,
    max_scroll_ratio REAL NOT NULL,
    copy_count INTEGER NOT NULL,
    paste_count INTEGER NOT NULL,
    PRIMARY KEY (replica_id, seq)
  );
  CREATE TABLE IF NOT EXISTS navigation_visit_fact (
    replica_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    accepted_at_ms INTEGER NOT NULL,
    visit_id TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    PRIMARY KEY (replica_id, seq)
  );
  CREATE TABLE IF NOT EXISTS selection_copy_fact (
    replica_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    accepted_at_ms INTEGER NOT NULL,
    visit_id TEXT NOT NULL,
    selection_hash TEXT NOT NULL,
    simhash64 TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    line_count INTEGER NOT NULL,
    content_kind_hint TEXT NOT NULL,
    PRIMARY KEY (replica_id, seq)
  );
  CREATE TABLE IF NOT EXISTS selection_paste_fact (
    replica_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    accepted_at_ms INTEGER NOT NULL,
    selection_hash TEXT NOT NULL,
    simhash64 TEXT NOT NULL,
    char_count INTEGER NOT NULL,
    destination_kind TEXT NOT NULL,
    destination_id TEXT NOT NULL,
    PRIMARY KEY (replica_id, seq)
  );
  CREATE TABLE IF NOT EXISTS ingest_watermark (
    replica_id TEXT PRIMARY KEY,
    max_seq INTEGER NOT NULL
  );
`;

// Pure, sqlite-free projection of events → the fact arrays the derive
// seam consumes. The store's ingest/readClassifierInputs mirror this
// field selection across the SQLite boundary; this function is the
// drift/replay path and the runnable byte-equivalence target (no Bun
// runtime needed). Byte-equivalent to buildEngagementClassifierInputs.
export const engagementInputsFromEvents = (
  events: readonly AcceptedEvent[],
  timelineDays: readonly TimelineDayProjection[],
): readonly EngagementClassifierInput[] => {
  const engagementFacts: EngagementSessionFactRow[] = [];
  const navigationFacts: NavigationVisitFactRow[] = [];
  const selectionEvents: AcceptedEvent[] = [];
  for (const event of events) {
    if (
      event.type === ENGAGEMENT_SESSION_AGGREGATED &&
      isEngagementSessionAggregatedPayload(event.payload)
    ) {
      engagementFacts.push({
        replicaId: event.dot.replicaId,
        seq: event.dot.seq,
        visitId: event.payload.visitId,
        sessionId: event.payload.sessionId,
        acceptedAtMs: event.acceptedAtMs,
        engagement: event.payload.dimensions.engagement,
      });
    } else if (event.type === NAVIGATION_COMMITTED && isNavigationCommittedPayload(event.payload)) {
      navigationFacts.push({
        visitId: event.payload.visitId,
        canonicalUrl: event.payload.canonicalUrl,
      });
    } else if (
      (event.type === SELECTION_COPIED && isSelectionCopiedPayload(event.payload)) ||
      (event.type === SELECTION_PASTED && isSelectionPastedPayload(event.payload))
    ) {
      selectionEvents.push(event);
    }
  }
  return engagementInputsFromFacts({ engagementFacts, navigationFacts, selectionEvents, timelineDays });
};

const numberField = (row: unknown, field: string): number => {
  const value = (row as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : Number(value);
};
const stringField = (row: unknown, field: string): string =>
  String((row as Record<string, unknown>)[field]);

export const createEngagementFactsStore = async (
  vaultRoot: string,
): Promise<EngagementFactsStore> => {
  const { Database } = await loadSqlite();
  const dbPath = join(vaultRoot, '_BAC', 'connections', 'engagement-facts.db');
  const db = new Database(dbPath, { create: true, readwrite: true });
  db.exec(SCHEMA);

  const upsertEngagement = db.query(
    `INSERT OR IGNORE INTO engagement_session_fact
       (replica_id, seq, accepted_at_ms, visit_id, session_id,
        active_ms, visible_ms, focused_window_ms, idle_ms, foreground_bursts,
        return_count, scroll_events, max_scroll_ratio, copy_count, paste_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const upsertNavigation = db.query(
    `INSERT OR IGNORE INTO navigation_visit_fact
       (replica_id, seq, accepted_at_ms, visit_id, canonical_url)
     VALUES (?,?,?,?,?)`,
  );
  const upsertCopy = db.query(
    `INSERT OR IGNORE INTO selection_copy_fact
       (replica_id, seq, accepted_at_ms, visit_id, selection_hash, simhash64,
        char_count, line_count, content_kind_hint)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const upsertPaste = db.query(
    `INSERT OR IGNORE INTO selection_paste_fact
       (replica_id, seq, accepted_at_ms, selection_hash, simhash64,
        char_count, destination_kind, destination_id)
     VALUES (?,?,?,?,?,?,?,?)`,
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
    if (event.type === ENGAGEMENT_SESSION_AGGREGATED && isEngagementSessionAggregatedPayload(event.payload)) {
      const e = event.payload.dimensions.engagement;
      upsertEngagement.run(
        replicaId, seq, event.acceptedAtMs, event.payload.visitId, event.payload.sessionId,
        e.activeMs, e.visibleMs, e.focusedWindowMs, e.idleMs, e.foregroundBursts,
        e.returnCount, e.scrollEvents, e.maxScrollRatio, e.copyCount, e.pasteCount,
      );
      projected = true;
    } else if (event.type === NAVIGATION_COMMITTED && isNavigationCommittedPayload(event.payload)) {
      upsertNavigation.run(
        replicaId, seq, event.acceptedAtMs, event.payload.visitId, event.payload.canonicalUrl,
      );
      projected = true;
    } else if (event.type === SELECTION_COPIED && isSelectionCopiedPayload(event.payload)) {
      const p = event.payload;
      upsertCopy.run(
        replicaId, seq, event.acceptedAtMs, p.visitId, p.selectionHash, p.simhash64,
        p.charCount, p.lineCount, p.contentKindHint,
      );
      projected = true;
    } else if (event.type === SELECTION_PASTED && isSelectionPastedPayload(event.payload)) {
      const p = event.payload;
      upsertPaste.run(
        replicaId, seq, event.acceptedAtMs, p.selectionHash, p.simhash64,
        p.charCount, p.destinationKind, p.destinationId,
      );
      projected = true;
    }
    // Watermark advances for EVERY event so catchUp can skip the whole
    // log tail, not just engagement-relevant events.
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

  const readClassifierInputs = (
    timelineDays: readonly TimelineDayProjection[],
  ): readonly EngagementClassifierInput[] => {
    const engagementFacts: EngagementSessionFactRow[] = db
      .query('SELECT * FROM engagement_session_fact')
      .all()
      .map((row) => ({
        replicaId: stringField(row, 'replica_id'),
        seq: numberField(row, 'seq'),
        visitId: stringField(row, 'visit_id'),
        sessionId: stringField(row, 'session_id'),
        acceptedAtMs: numberField(row, 'accepted_at_ms'),
        engagement: {
          activeMs: numberField(row, 'active_ms'),
          visibleMs: numberField(row, 'visible_ms'),
          focusedWindowMs: numberField(row, 'focused_window_ms'),
          idleMs: numberField(row, 'idle_ms'),
          foregroundBursts: numberField(row, 'foreground_bursts'),
          returnCount: numberField(row, 'return_count'),
          scrollEvents: numberField(row, 'scroll_events'),
          maxScrollRatio: numberField(row, 'max_scroll_ratio'),
          copyCount: numberField(row, 'copy_count'),
          pasteCount: numberField(row, 'paste_count'),
        },
      }));
    // (replicaId, seq) order to match legacy readMerged()'s sort
    // (causal.ts) so last-write-wins canonical resolution is identical
    // even when accepted-time order differs from dot order.
    const navigationFacts: NavigationVisitFactRow[] = db
      .query(
        'SELECT visit_id, canonical_url FROM navigation_visit_fact ORDER BY replica_id, seq',
      )
      .all()
      .map((row) => ({
        visitId: stringField(row, 'visit_id'),
        canonicalUrl: stringField(row, 'canonical_url'),
      }));
    const selectionEvents: AcceptedEvent[] = [
      ...db
        .query('SELECT * FROM selection_copy_fact')
        .all()
        .map((row): AcceptedEvent => {
          const payload: SelectionCopiedPayload = {
            payloadVersion: 1,
            visitId: stringField(row, 'visit_id'),
            selectionHash: stringField(row, 'selection_hash'),
            simhash64: stringField(row, 'simhash64'),
            charCount: numberField(row, 'char_count'),
            lineCount: numberField(row, 'line_count'),
            contentKindHint: stringField(row, 'content_kind_hint') as SelectionCopiedPayload['contentKindHint'],
            rawTextStored: false,
          };
          return reconstructSelectionEvent(row, SELECTION_COPIED, payload);
        }),
      ...db
        .query('SELECT * FROM selection_paste_fact')
        .all()
        .map((row): AcceptedEvent => {
          const payload: SelectionPastedPayload = {
            payloadVersion: 1,
            destinationKind: stringField(row, 'destination_kind') as SelectionPastedPayload['destinationKind'],
            destinationId: stringField(row, 'destination_id'),
            selectionHash: stringField(row, 'selection_hash'),
            simhash64: stringField(row, 'simhash64'),
            charCount: numberField(row, 'char_count'),
            rawTextStored: false,
          };
          return reconstructSelectionEvent(row, SELECTION_PASTED, payload);
        }),
    ];
    return engagementInputsFromFacts({
      engagementFacts,
      navigationFacts,
      selectionEvents,
      timelineDays,
    });
  };

  const rebuildFromJsonl = async (logRoot: string): Promise<void> => {
    // True rebuild/repair: clear derived facts + watermark so stale rows
    // from a prior state can't survive. JSONL stays authoritative.
    db.exec(`
      DELETE FROM engagement_session_fact;
      DELETE FROM navigation_visit_fact;
      DELETE FROM selection_copy_fact;
      DELETE FROM selection_paste_fact;
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
        files = (await readdir(join(logRoot, replicaDir))).filter((f) => f.endsWith('.jsonl')).sort();
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
    readClassifierInputs,
    rebuildFromJsonl,
    watermark,
    close: () => {
      db.close?.();
    },
  };
};

// Minimal AcceptedEvent reconstruction for projectSnippetLineage, which
// reads only acceptedAtMs, dot, and the selection payload fields. The
// causal fields (clientEventId/deps/aggregateId) are unused by the
// lineage matcher, so placeholders are safe.
const reconstructSelectionEvent = (
  row: unknown,
  type: typeof SELECTION_COPIED | typeof SELECTION_PASTED,
  payload: SelectionCopiedPayload | SelectionPastedPayload,
): AcceptedEvent => ({
  clientEventId: '',
  dot: { replicaId: stringField(row, 'replica_id'), seq: numberField(row, 'seq') },
  deps: {},
  aggregateId: '',
  type,
  payload,
  acceptedAtMs: numberField(row, 'accepted_at_ms'),
});
