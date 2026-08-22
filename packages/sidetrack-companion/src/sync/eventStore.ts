// Derived, persistent SQLite mirror of the causal JSONL event log.
//
// JSONL is the ONLY source of truth. This store is a disposable, rebuildable
// mirror and exists so hot materializers can read small ordered tails without
// materializing the full AcceptedEvent[] in the JS heap. When the feature is
// disabled, gc/storageRetirement.ts may retire it only after reading every
// mirror row back identically from canonical JSONL; no reverse recovery path
// from SQLite to JSONL exists or is permitted.

import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  type EngagementCompactionManifestEntry,
  readEngagementCompactionManifest,
  verifyCompactionShardState,
} from '../gc/engagementCompactionManifest.js';
import { ENGAGEMENT_INTERVAL_OBSERVED } from '../engagement/events.js';
import { isAcceptedEvent } from './eventLog.js';
import type { AcceptedEvent, Hlc, TargetRef, VersionVector } from './causal.js';
import {
  incrementDotCollisions,
  incrementDuplicateCaptures,
  incrementStoreSkippedOutOfOrder,
} from './eventLaneHealth.js';
import { USER_ORGANIZED_ITEM, isUserOrganizedItemPayload } from '../feedback/events.js';
import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload } from '../timeline/events.js';
import { hotCachePragmaSql } from '../storage/sqliteCachePragmas.js';

// Duplicated, one-line-on-purpose: `http/routes/visitsRoutes.ts` has its own
// `resolverCanonicalUrlKey` and `connections/snapshot.ts` its own
// `normalizeResolverUrl` — same normalization (strip #fragment, strip
// trailing slashes), three independent copies. A store module (this file)
// must not import from a route module (wrong dependency direction), and a
// shared import would still cost a cross-package hop for one regex; the
// existing snapshot.ts precedent already treats this as fine to duplicate.
const resolverUrlKey = (raw: string): string => raw.replace(/#.*$/u, '').replace(/\/+$/u, '');

// The `resolver_url` index value for one event, computed at ingest AND
// backfill time (must stay in exact lockstep with
// resolverSignalEventsForCanonicalUrls / resolverTimelineEventsForCanonicalUrls
// in http/routes/visitsRoutes.ts — those are the JS-filter equivalents this
// column exists to replace). Two independent key spaces share the one
// column because the two event types never collide on `type` in a caller's
// WHERE clause:
//   - BROWSER_TIMELINE_OBSERVED: resolverUrlKey(canonicalUrl ?? url) —
//     NORMALIZED, matching resolverTimelineEventsForCanonicalUrls' symmetric
//     normalization of both sides.
//   - USER_ORGANIZED_ITEM with itemKind === 'canonical-url': the RAW
//     itemId, unnormalized — matching resolverSignalEventsForCanonicalUrls'
//     exact-string Set.has(itemId) (no normalization there today; changing
//     that would be a behavior change, not an index-backing one).
//   - Everything else (including USER_FLOW_REJECTED, which carries no URL
//     at all and must stay on the unconditional type-scoped read): ''.
const resolverUrlForEvent = (type: string, payload: unknown): string => {
  if (type === BROWSER_TIMELINE_OBSERVED) {
    if (!isBrowserTimelineObservedPayload(payload)) return '';
    return resolverUrlKey(payload.canonicalUrl ?? payload.url);
  }
  if (type === USER_ORGANIZED_ITEM) {
    if (!isUserOrganizedItemPayload(payload)) return '';
    return payload.itemKind === 'canonical-url' ? payload.itemId : '';
  }
  return '';
};

export interface EventStore {
  /** Idempotent by (replicaId, seq). Watermark advances for every valid event. */
  readonly ingest: (event: AcceptedEvent) => void;
  readonly ingestMany: (events: readonly AcceptedEvent[]) => number;
  /** Ingest only events past the persisted per-replica watermark. */
  readonly catchUp: (events: readonly AcceptedEvent[]) => Promise<number>;
  /** Stream JSONL shards and ingest only events past the store watermark.
   *  `priorRoots` (e.g. the F2 retired-log mirror), when supplied, are
   *  walked to completion — including their own watermark-advancing
   *  flush — BEFORE `logRoot`; see the implementation's header comment
   *  for why that order is load-bearing, not cosmetic. */
  readonly catchUpFromJsonl: (logRoot: string, priorRoots?: readonly string[]) => Promise<number>;
  /** True rebuild/repair: clear derived rows first, then stream JSONL.
   *  Same `priorRoots` ordering contract as catchUpFromJsonl. */
  readonly rebuildFromJsonl: (logRoot: string, priorRoots?: readonly string[]) => Promise<void>;
  /** Ordered like readMerged().filter(event => event.dot.seq > frontier[replica] ?? 0). */
  readonly readSince: (frontier: VersionVector) => readonly AcceptedEvent[];
  /** All retained events for one aggregate, ordered like readSince —
   *  O(aggregate rows) via events_aggregate_idx, replacing the request-
   *  path readMerged()+filter that cost a full-log materialization per
   *  per-aggregate projection GET (measured: 9.1s cold on 866k events,
   *  fired in bursts on every extension service-worker reconnect). */
  readonly readByAggregate: (aggregateId: string) => readonly AcceptedEvent[];
  /** Events whose maintained `resolver_url` index value is in `resolverUrls`,
   *  restricted to `types` — O(matching rows) via events_resolver_url_idx,
   *  replacing the request-path pattern of reading a type-scoped chunk (via
   *  forEachChunkOfTypes) and then JS-filtering it down to one or a handful
   *  of canonical URLs (resolverSignalEventsForCanonicalUrls /
   *  resolverTimelineEventsForCanonicalUrls in http/routes/visitsRoutes.ts).
   *  `resolver_url` is populated at ingest time by `resolverUrlForEvent`
   *  below — see its doc comment for the exact per-type key semantics
   *  (some types, e.g. USER_FLOW_REJECTED, carry no URL and are never
   *  matched here; callers must still read those via forEachChunkOfTypes). */
  readonly readByResolverUrls: (
    resolverUrls: readonly string[],
    types: readonly string[],
  ) => readonly AcceptedEvent[];
  /** Most-recent `limit` events of ONE type, via events_accepted_at_ms_idx
   *  (DESC) — a BOUNDED alternative to forEachChunkOfTypes for callers that
   *  need breadth (a graph/discovery input, not a specific URL's own
   *  events) but not the entire type-scoped history. Order is most-recent-
   *  first, NOT the (replica_id, seq) order forEachChunkOfTypes returns —
   *  callers that need causal order must sort the result themselves; the
   *  one caller today (resolver candidate generation) does not. */
  readonly readMostRecentByType: (type: string, limit: number) => readonly AcceptedEvent[];
  readonly maxAcceptedAtMs: () => number;
  /** MAX(accepted_at_ms) for a single event type (events_type_idx filter),
   *  0 when the type has never been seen. A single aggregate query — used
   *  by the engagement-lane freshness probe to spot aggregate-vs-interval
   *  divergence without materializing rows. */
  readonly maxAcceptedAtMsForType: (type: string) => number;
  /** Most recent accepted time represented only by a verified compaction receipt. */
  readonly maxCompactedAcceptedAtMsForType: (type: string) => number;
  /** Physical retained event rows. */
  readonly count: () => number;
  /**
   * Sum(watermark) minus exact dots covered by trusted compaction receipts.
   * Genuine sequence holes remain expected and therefore visible in the delta.
   */
  readonly expectedRetainedCount: () => number;
  readonly forEachChunk: (
    cb: (chunk: readonly AcceptedEvent[]) => void | Promise<void>,
    chunkSize: number,
  ) => Promise<void>;
  /** Like forEachChunk but filtered to the given event types at the SQL
   *  level (events_type_idx). O(matching rows) instead of O(all events)
   *  — health/feedback probes want a tiny typed subset of a log that is
   *  ~92% engagement.interval, so a full forEachChunk scan dominated the
   *  5s health budget. */
  readonly forEachChunkOfTypes: (
    types: readonly string[],
    cb: (chunk: readonly AcceptedEvent[]) => void | Promise<void>,
    chunkSize: number,
  ) => Promise<void>;
  readonly watermark: () => VersionVector;
  /** Per-UTC-day aggregate of RETAINED rows for one replica (day = the UTC
   *  date of accepted_at_ms). The columnar sealer's planning + verification
   *  read: compacted dots are already absent here, so a seal derived from
   *  these stats mirrors the retained set, not raw JSONL. */
  readonly sealDayStats: (replicaId: string) => readonly SealDayStat[];
  /** Retained rows for one replica-day ordered by seq, as raw column values
   *  (payload stays the stored JSON TEXT) — exactly what a sealed segment
   *  writes. Day bounds are UTC-midnight accepted_at_ms bounds, matching
   *  sealDayStats bucketing. */
  readonly readSealRows: (replicaId: string, day: string) => readonly SealRow[];
  /** Retained rows for one replica-day ordered by seq, as FULL AcceptedEvent
   *  objects (unlike readSealRows, which mirrors exactly what a seal WRITES
   *  — no deps/target/hlc, by design). Day-bounded via the same
   *  accepted_at_ms index readSealRows/sealDayStats use. Added for
   *  analytics/sealedScan.ts's hot-tail read: the columnar scan router reads
   *  sealed days from Parquet (which cannot carry deps/target/hlc — see that
   *  module's header) and must not ALSO degrade the unsealed/hot tail's
   *  fidelity just because the sealed portion has to. Purely additive —
   *  no existing method's behavior changes. */
  readonly readEventsForDay: (replicaId: string, day: string) => readonly AcceptedEvent[];
  /** COUNT(*) of `compacted_events` rows for one replica-day, same UTC-day
   *  bucketing as sealDayStats/readSealRows (a compaction receipt's dropped
   *  dots are all stamped with the shard's own day by construction — see
   *  applyCompactionReceipt below). The ledger-provenance check the sealer
   *  runs before healing a day whose retained-row count dropped to exactly
   *  zero (F1 compaction can legitimately empty an entire day): a count
   *  that covers the previously sealed row count proves the drop was
   *  ledgered, not silent data loss. Zero means no ledger evidence at all
   *  — the fail-closed signal an empty-day seal must never be written for. */
  readonly compactedRowCountForDay: (replicaId: string, day: string) => number;
  readonly close: () => void;
}

export interface SealDayStat {
  /** UTC YYYY-MM-DD of accepted_at_ms. */
  readonly day: string;
  readonly rows: number;
  readonly seqLo: number;
  readonly seqHi: number;
}

export interface SealRow {
  readonly replicaId: string;
  readonly seq: number;
  readonly type: string;
  readonly acceptedAtMs: number;
  readonly aggregateId: string;
  readonly clientEventId: string;
  /** Stored JSON TEXT, passed through untouched. */
  readonly payload: string;
}

/** Machine-readable single-source declaration consumed by docs/tests. */
export const EVENT_STORE_AUTHORITY = 'canonical-jsonl' as const;
export const EVENT_STORE_STORAGE_ROLE = 'rebuildable-mirror' as const;

// F3 (2026-08-16) — evaluated flipping this to default-ON and DID NOT ship
// it; stays opt-in (env=1). Every hot reader that consults this flag
// (workGraphHealth.ts, section15Collector.ts, recall/ingestor.ts,
// attribution-v1/artifact.ts, ranker/retrain.ts's readRetrainEventSources)
// already degrades correctly to a readMerged()/streamFiltered() fallback
// when the flag is off, and both live companions (test + daily) have run
// =1 continuously for days with no regression — the CODE is ready. The
// blocker is test-fixture debt, measured directly: flipping the process
// default to ON (tried on this branch, then reverted) turned 67 assertions
// red across 19 files (`bun test`, full suite), concentrated in the
// sync/contract/connectionsMaterializer.*.test.ts + connectionsHnsw*.test.ts
// ecosystem (29 of the 67). Root cause is one repeated fixture shape: a
// test builds a REAL temp vaultRoot but injects a STUB EventLog (only
// `readMerged`/`streamFiltered` implemented) on the assumption that "the
// store path is unused for a bare vault root" (verbatim comment,
// attribution-v1/armedResolve.test.ts) — true only while the store
// defaults off. With it on, `getCaughtUpSharedEventStore` opens a REAL
// (empty) sqlite store against that real temp dir instead of no-op'ing,
// and typed readers silently read the empty store instead of the
// seeded stub, dropping the fixture's events. Reproduced and isolated:
// `git stash` (removes only this flag's default) turns the SAME 6
// armedResolve.test.ts failures green again. Fixing this properly means
// auditing 19 files' fixtures (many touching
// sync/contract/connectionsMaterializer.ts, which this PR does not
// modify) — real work, out of scope for a readMerged-migration PR.
// Recommended follow-up: either give tests a way to stub the shared event
// store itself (not just EventLog), or have the affected fixtures pin
// SIDETRACK_EVENT_STORE=0 explicitly; then flip this default in its own
// PR with the full suite green.
//
// The seeding path a future flip would rely on is already proven safe:
// a vault whose `_BAC/connections/event-store.db` does not yet exist pays
// ONE bounded catch-up pass (`catchUpFromJsonl`, chunked + yielding, the
// same path every store-backed caller already shares via
// `getCaughtUpSharedEventStore` / `startCoalescedEventStoreCatchUp`) the
// first time anything opens the store; every later open is a cheap
// incremental catch-up bounded by the per-shard byte-offset watermark
// (`shard_progress`), not a re-scan — see eventStore.test.ts's
// "F3 default-flip" describe block.
//
// Prior history this supersedes: shipped default-OFF on two net-negative
// measurements (2026-05-xx, 2026-05-29 — a naive raw-SQLite-fetch memory/
// CPU profile predating forEachChunkOfTypes typed reads, serve-stale
// catch-up splitting, and per-caller SQL aggregation). Neither measurement
// is the reason it stays off today; the fixture debt above is.
export const eventStoreEnabled = (): boolean => process.env['SIDETRACK_EVENT_STORE'] === '1';

const sharedEventStores = new Map<string, Promise<EventStore | null>>();
// Single-flight guard for catch-up: concurrent callers (a background
// /v1/status kick + an inline resolve/projection/health read) share ONE
// catchUpFromJsonl pass. Without this, the first read after idle on a large
// vault runs a 40s+ catch-up per caller — duplicated CPU and racing shard-
// progress/watermark writes on the same SQLite handle.
const catchUpInFlight = new Map<string, Promise<number>>();

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
  const specifier = 'bun:sqlite';
  const module = (await import(specifier)) as Partial<SqliteModule>;
  if (typeof module.Database !== 'function') {
    throw new Error('bun:sqlite Database export is unavailable');
  }
  return { Database: module.Database };
};

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 2500;
  CREATE TABLE IF NOT EXISTS events (
    replica_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    client_event_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    accepted_at_ms INTEGER NOT NULL,
    deps TEXT NOT NULL,
    target TEXT NOT NULL,
    hlc TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    resolver_url TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (replica_id, seq)
  );
  CREATE INDEX IF NOT EXISTS events_accepted_at_ms_idx ON events(accepted_at_ms);
  CREATE INDEX IF NOT EXISTS events_replica_seq_idx ON events(replica_id, seq);
  CREATE INDEX IF NOT EXISTS events_aggregate_idx ON events(aggregate_id, replica_id, seq);
  CREATE INDEX IF NOT EXISTS events_type_idx ON events(type, replica_id, seq);
  CREATE INDEX IF NOT EXISTS events_type_accepted_at_idx ON events(type, accepted_at_ms);
  -- Columnar scan routing (2026-08-18): readSealRows/sealDayStats/
  -- readEventsForDay all filter WHERE replica_id = ? AND accepted_at_ms
  -- BETWEEN lo AND hi. Without a compound (replica_id, accepted_at_ms)
  -- index, the planner falls back to events_accepted_at_ms_idx alone —
  -- a scan of EVERY replica's rows in the day's timestamp range, not just
  -- the requested replica's — measured 227MB/1054ms read for a single
  -- 4,766-row hot day on a real multi-replica vault (a live capturing
  -- replica's "today" plus the harness's own synthetic replica sharing
  -- the same day). This index makes the lookup a direct lo/hi seek scoped
  -- to one replica. Pre-existing queries (readSealRows, the sealer's own
  -- per-day read) get this fix for free — it was never specific to this
  -- task's new readEventsForDay.
  CREATE INDEX IF NOT EXISTS events_replica_accepted_at_idx ON events(replica_id, accepted_at_ms);
  CREATE TABLE IF NOT EXISTS ingest_watermark (
    replica_id TEXT PRIMARY KEY,
    max_seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS shard_progress (
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    read_offset INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS compacted_events (
    replica_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    accepted_at_ms INTEGER NOT NULL,
    shard_path TEXT NOT NULL,
    receipt_sha256 TEXT NOT NULL,
    PRIMARY KEY (replica_id, seq)
  );
  CREATE INDEX IF NOT EXISTS compacted_events_type_idx
    ON compacted_events(type, accepted_at_ms);
  CREATE TABLE IF NOT EXISTS compaction_receipt_trust (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    trusted INTEGER NOT NULL CHECK (trusted IN (0, 1))
  );
  INSERT OR IGNORE INTO compaction_receipt_trust (singleton, trusted) VALUES (1, 1);
`;

const numberField = (row: unknown, field: string): number => {
  const value = (row as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : Number(value);
};

// bun:sqlite `.run()` returns `{ changes, lastInsertRowid }`. `changes`
// is 0 when an `INSERT OR IGNORE` was ignored because the primary key
// already existed. We validate the shape as unknown before reading it.
const rowsChanged = (runResult: unknown): number => {
  if (typeof runResult !== 'object' || runResult === null) return 0;
  const changes = (runResult as Record<string, unknown>)['changes'];
  return typeof changes === 'number' ? changes : 0;
};

const stringField = (row: unknown, field: string): string =>
  String((row as Record<string, unknown>)[field]);

const optionalJsonText = (value: unknown): string => JSON.stringify(value ?? null);

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

const isStructurallyValidAcceptedEvent = (event: AcceptedEvent): boolean =>
  isAcceptedEvent(event) && Number.isFinite(event.dot.seq) && Number.isFinite(event.acceptedAtMs);

const rowToAcceptedEvent = (row: unknown): AcceptedEvent | null => {
  try {
    const target = parseJson(stringField(row, 'target'));
    const hlc = parseJson(stringField(row, 'hlc'));
    const event: AcceptedEvent = {
      clientEventId: stringField(row, 'client_event_id'),
      dot: {
        replicaId: stringField(row, 'replica_id'),
        seq: numberField(row, 'seq'),
      },
      deps: parseJson(stringField(row, 'deps')) as VersionVector,
      aggregateId: stringField(row, 'aggregate_id'),
      type: stringField(row, 'type'),
      payload: parseJson(stringField(row, 'payload')),
      acceptedAtMs: numberField(row, 'accepted_at_ms'),
      ...(target === null ? {} : { target: target as TargetRef }),
      ...(hlc === null ? {} : { hlc: hlc as Hlc }),
    };
    return isStructurallyValidAcceptedEvent(event) ? event : null;
  } catch {
    return null;
  }
};

const rowsToEvents = (rows: readonly unknown[]): AcceptedEvent[] => {
  const out: AcceptedEvent[] = [];
  for (const row of rows) {
    const event = rowToAcceptedEvent(row);
    if (event !== null) out.push(event);
  }
  return out;
};

const SELECT_COLUMNS = `
  replica_id, seq, client_event_id, type, payload, accepted_at_ms,
  deps, target, hlc, aggregate_id
`;

interface ShardProgress {
  readonly size: number;
  readonly mtimeMs: number;
  readonly readOffset: number;
}

export const createEventStore = async (vaultRoot: string): Promise<EventStore> => {
  const { Database } = await loadSqlite();
  const dbPath = join(vaultRoot, '_BAC', 'connections', 'event-store.db');
  await mkdir(join(vaultRoot, '_BAC', 'connections'), { recursive: true });
  const db = new Database(dbPath, { create: true, readwrite: true });
  db.exec(SCHEMA);
  // Hot, held-for-process-lifetime handle over a store that regularly
  // reaches ~1GB on a real vault — see storage/sqliteCachePragmas.ts for
  // why (read-amplification: default 2MB cache_size against a ~1GB db).
  db.exec(hotCachePragmaSql('eventStore'));

  // Migration for stores created before `resolver_url` existed: the raw
  // SCHEMA's `CREATE TABLE IF NOT EXISTS` is a no-op against an already-
  // present `events` table, so a pre-existing store's column is missing
  // until this ALTER runs once. Cheap PRAGMA read on every open afterward
  // (column already present ⇒ no-op); the one-time ALTER + backfill only
  // fires the FIRST open after this code ships. See resolverUrlForEvent for
  // the backfilled value's exact semantics.
  const eventsColumns = db.query("PRAGMA table_info('events')").all();
  const resolverUrlColumnMissing = !eventsColumns.some(
    (column) => stringField(column, 'name') === 'resolver_url',
  );
  if (resolverUrlColumnMissing) {
    db.exec("ALTER TABLE events ADD COLUMN resolver_url TEXT NOT NULL DEFAULT ''");
  }
  const updateResolverUrl = db.query(
    'UPDATE events SET resolver_url = ? WHERE replica_id = ? AND seq = ?',
  );
  const backfillResolverUrlColumn = async (): Promise<void> => {
    const BACKFILL_CHUNK = 2000;
    const backfillTypes = [BROWSER_TIMELINE_OBSERVED, USER_ORGANIZED_ITEM];
    const typePlaceholders = backfillTypes.map(() => '?').join(', ');
    let lastReplicaId = '';
    let lastSeq = 0;
    while (true) {
      const rows = db
        .query(
          `SELECT replica_id, seq, type, payload FROM events
             WHERE type IN (${typePlaceholders})
               AND (replica_id > ? OR (replica_id = ? AND seq > ?))
             ORDER BY replica_id, seq
             LIMIT ?`,
        )
        .all(...backfillTypes, lastReplicaId, lastReplicaId, lastSeq, BACKFILL_CHUNK);
      if (rows.length === 0) return;
      db.exec('BEGIN');
      try {
        for (const row of rows) {
          const replicaId = stringField(row, 'replica_id');
          const seq = numberField(row, 'seq');
          let payload: unknown = null;
          try {
            payload = parseJson(stringField(row, 'payload'));
          } catch {
            payload = null;
          }
          const resolverUrl = resolverUrlForEvent(stringField(row, 'type'), payload);
          if (resolverUrl.length > 0) updateResolverUrl.run(resolverUrl, replicaId, seq);
          lastReplicaId = replicaId;
          lastSeq = seq;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      if (rows.length < BACKFILL_CHUNK) return;
      // Yield between chunks — this can walk a few hundred thousand rows on
      // first upgrade; never hold the loop for the whole pass uninterrupted.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  if (resolverUrlColumnMissing) {
    await backfillResolverUrlColumn();
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS events_resolver_url_idx ON events(resolver_url, type, replica_id, seq)',
  );

  const insertEvent = db.query(
    `INSERT OR IGNORE INTO events
       (replica_id, seq, client_event_id, type, payload, accepted_at_ms,
        deps, target, hlc, aggregate_id, resolver_url)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const bumpWatermark = db.query(
    `INSERT INTO ingest_watermark (replica_id, max_seq) VALUES (?, ?)
     ON CONFLICT(replica_id) DO UPDATE SET max_seq = MAX(max_seq, excluded.max_seq)`,
  );
  const selectClientEventIdByDot = db.query(
    'SELECT client_event_id FROM events WHERE replica_id = ? AND seq = ?',
  );
  const selectShardProgress = db.query(
    'SELECT size, mtime_ms, read_offset FROM shard_progress WHERE path = ?',
  );
  const upsertShardProgress = db.query(
    `INSERT INTO shard_progress (path, size, mtime_ms, read_offset) VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       read_offset = excluded.read_offset`,
  );
  const selectCompactedReceiptByDot = db.query(
    'SELECT receipt_sha256 FROM compacted_events WHERE replica_id = ? AND seq = ?',
  );
  const selectStoredTypeByDot = db.query(
    'SELECT type FROM events WHERE replica_id = ? AND seq = ?',
  );
  const insertCompactedEvent = db.query(
    `INSERT OR IGNORE INTO compacted_events
       (replica_id, seq, type, accepted_at_ms, shard_path, receipt_sha256)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const deleteCompactedEvent = db.query(
    'DELETE FROM events WHERE replica_id = ? AND seq = ? AND type = ?',
  );
  const setCompactionReceiptTrust = db.query(
    'UPDATE compaction_receipt_trust SET trusted = ? WHERE singleton = 1',
  );

  const applyCompactionReceipt = (entry: EngagementCompactionManifestEntry): void => {
    db.exec('BEGIN');
    try {
      for (const range of entry.droppedSequenceRanges) {
        for (let seq = range.from; seq <= range.to; seq += 1) {
          const existingReceipt = selectCompactedReceiptByDot.get(entry.replicaId, seq);
          if (existingReceipt !== null && existingReceipt !== undefined) {
            if (stringField(existingReceipt, 'receipt_sha256') !== entry.receiptSha256) {
              throw new Error('compaction-receipt-dot-conflict');
            }
            continue;
          }
          const stored = selectStoredTypeByDot.get(entry.replicaId, seq);
          if (
            stored !== null &&
            stored !== undefined &&
            stringField(stored, 'type') !== ENGAGEMENT_INTERVAL_OBSERVED
          ) {
            throw new Error('compaction-receipt-type-mismatch');
          }
          insertCompactedEvent.run(
            entry.replicaId,
            seq,
            ENGAGEMENT_INTERVAL_OBSERVED,
            entry.maxDroppedAcceptedAtMs,
            entry.shard,
            entry.receiptSha256,
          );
          deleteCompactedEvent.run(entry.replicaId, seq, ENGAGEMENT_INTERVAL_OBSERVED);
          bumpWatermark.run(entry.replicaId, seq);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const mirrorContainsEveryShardEvent = async (shardPath: string): Promise<boolean> => {
    const lines = createInterface({
      input: createReadStream(shardPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          return false;
        }
        if (!isAcceptedEvent(parsed)) return false;
        const stored = selectClientEventIdByDot.get(parsed.dot.replicaId, parsed.dot.seq);
        if (
          stored === null ||
          stored === undefined ||
          stringField(stored, 'client_event_id') !== parsed.clientEventId
        ) {
          return false;
        }
      }
      return true;
    } finally {
      lines.close();
    }
  };

  const ingest = (event: AcceptedEvent): boolean => {
    if (!isStructurallyValidAcceptedEvent(event)) return false;
    const { replicaId, seq } = event.dot;
    const runResult = insertEvent.run(
      replicaId,
      seq,
      event.clientEventId,
      event.type,
      JSON.stringify(event.payload),
      event.acceptedAtMs,
      JSON.stringify(event.deps),
      optionalJsonText(event.target),
      optionalJsonText(event.hlc),
      event.aggregateId,
      resolverUrlForEvent(event.type, event.payload),
    );
    // changes === 0 ⇒ the INSERT OR IGNORE hit the (replica_id, seq)
    // primary key: a row already exists for this dot. Classify the
    // anomaly against the stored row (one indexed lookup, only on the
    // rare ignore path — never the hot insert path). Same
    // client_event_id ⇒ a duplicate replica-seq dot redelivered
    // (duplicate capture); different ⇒ two distinct events claim the
    // same dot (a true collision). Either way the store keeps the
    // first-written row (INSERT OR IGNORE); we only observe.
    if (rowsChanged(runResult) === 0) {
      const existing = selectClientEventIdByDot.get(replicaId, seq);
      if (existing === null || existing === undefined) {
        incrementDuplicateCaptures();
      } else if (stringField(existing, 'client_event_id') === event.clientEventId) {
        incrementDuplicateCaptures();
      } else {
        incrementDotCollisions();
      }
    }
    bumpWatermark.run(replicaId, seq);
    return true;
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
    let count = 0;
    let pending: AcceptedEvent[] = [];
    for (const event of events) {
      if (!isStructurallyValidAcceptedEvent(event)) continue;
      if (event.dot.seq <= (wm[event.dot.replicaId] ?? 0)) {
        // Event at or below the persisted per-replica watermark: an
        // out-of-order / already-committed redelivery that is
        // permanently dropped from this catch-up.
        incrementStoreSkippedOutOfOrder();
        continue;
      }
      pending.push(event);
      if (pending.length >= CATCHUP_CHUNK) {
        count += ingestMany(pending);
        pending = [];
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    if (pending.length > 0) count += ingestMany(pending);
    return count;
  };

  // F2 seam (2026-08-21): `priorRoots`, when supplied, are walked to
  // completion — including their own flush() cycles — BEFORE `logRoot`.
  // This is NOT optional ordering: `wm` (the per-replica watermark) only
  // ever advances forward via flush(), and any later-seen event at or
  // below a replica's current watermark is treated as an already-committed
  // redelivery and PERMANENTLY skipped (see the `<=` check below). Once
  // any hot-tail shard for a replica has been flushed, that replica's
  // watermark can be at/above older retired-day seqs, so walking the hot
  // root before an as-yet-unprocessed retired root would silently drop the
  // retired root's rows. The one production caller
  // (companion.ts/lineage's boot warm-walk) still passes a single logRoot
  // and no priorRoots — unaffected, identical behaviour to before this
  // change. A cold-repair/rebuild caller that wants full history including
  // any F2-retired days (analytics/hotTailRetirement.ts) passes
  // `priorRoots: [retiredEventLogRoot(vaultRoot)]`.
  const catchUpFromJsonl = async (
    logRoot: string,
    priorRoots: readonly string[] = [],
  ): Promise<number> => {
    if (priorRoots.length > 0) {
      // Audible: only cold-repair/rebuild callers supply priorRoots — the
      // per-drain hot path never does, so this line firing per drain would
      // itself be the regression signal.
      // eslint-disable-next-line no-console -- structured cold-repair evidence
      console.info(
        `[event-store] jsonl catch-up order=prior-first priorRoots=${String(priorRoots.length)} logRoot=${logRoot}`,
      );
    }
    const vaultRoot = join(logRoot, '..', '..');
    const manifestRead = await readEngagementCompactionManifest(vaultRoot);
    const manifestEntries =
      manifestRead.state === 'valid'
        ? new Map(
            manifestRead.manifest.entries.map(
              (entry) => [join(logRoot, entry.shard), entry] as const,
            ),
          )
        : new Map<string, EngagementCompactionManifestEntry>();
    const storedReceipts = db.query('SELECT DISTINCT receipt_sha256 FROM compacted_events').all();
    const manifestReceiptIds = new Set(
      manifestRead.state === 'valid'
        ? manifestRead.manifest.entries.map((entry) => entry.receiptSha256)
        : [],
    );
    // Absent and invalid are distinct at the boundary, but either makes prior
    // compacted-dot accounting untrusted. The rows stay recoverable; count()
    // simply stops crediting them until the matching valid manifest returns.
    const receiptsTrusted = storedReceipts.every((row) =>
      manifestReceiptIds.has(stringField(row, 'receipt_sha256')),
    );
    setCompactionReceiptTrust.run(receiptsTrusted ? 1 : 0);
    let count = 0;
    let wm = watermark();
    let pending: AcceptedEvent[] = [];
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      count += ingestMany(pending);
      pending = [];
      wm = watermark();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    for (const root of [...priorRoots, logRoot]) {
      let replicaDirs: string[];
      try {
        replicaDirs = (await readdir(root)).sort();
      } catch {
        continue;
      }
      for (const replicaDir of replicaDirs) {
        let files: string[];
        try {
          files = (await readdir(join(root, replicaDir)))
            .filter((file) => file.endsWith('.jsonl'))
            .sort();
        } catch {
          continue;
        }
        for (const file of files) {
          const shardPath = join(root, replicaDir, file);
          let shardStat: Awaited<ReturnType<typeof stat>>;
          try {
            shardStat = await stat(shardPath);
          } catch {
            continue;
          }
          if (!shardStat.isFile()) continue;
          const size = shardStat.size;
          const mtimeMs = Math.trunc(shardStat.mtimeMs);
          const progressRow = selectShardProgress.get(shardPath);
          const progress: ShardProgress | null =
            progressRow === null || progressRow === undefined
              ? null
              : {
                  size: numberField(progressRow, 'size'),
                  mtimeMs: numberField(progressRow, 'mtime_ms'),
                  readOffset: numberField(progressRow, 'read_offset'),
                };
          if (progress !== null && progress.size === size && progress.mtimeMs === mtimeMs) {
            continue;
          }

          const receipt = manifestEntries.get(shardPath);
          const receiptState =
            receipt === undefined ? null : await verifyCompactionShardState(vaultRoot, receipt);
          if (receiptState === 'mismatch' || receiptState === 'missing') {
            setCompactionReceiptTrust.run(0);
          }
          if (
            progress !== null &&
            receipt !== undefined &&
            receiptState === 'compacted' &&
            progress.size === receipt.sourceBytes &&
            progress.readOffset <= receipt.sourceBytes &&
            (await mirrorContainsEveryShardEvent(shardPath))
          ) {
            // Recognised intentional shrink: account for the exact removed dots,
            // prune their stale mirror rows, and advance straight to the new EOF.
            // Unknown/tampered shrinks do not enter this branch and retain the
            // legacy reparse + anomaly-counter behavior.
            applyCompactionReceipt(receipt);
            upsertShardProgress.run(shardPath, size, mtimeMs, size);
            continue;
          }

          const readOffset =
            progress === null || progress.readOffset > size ? 0 : Math.max(0, progress.readOffset);
          const byteLength = size - readOffset;
          if (byteLength <= 0) {
            upsertShardProgress.run(shardPath, size, mtimeMs, readOffset);
            continue;
          }

          let tail: Buffer;
          try {
            const handle = await open(shardPath, 'r');
            try {
              tail = Buffer.alloc(byteLength);
              const result = await handle.read(tail, 0, byteLength, readOffset);
              tail = tail.subarray(0, result.bytesRead);
            } finally {
              await handle.close();
            }
          } catch {
            continue;
          }

          const lastNewline = tail.lastIndexOf(0x0a);
          if (lastNewline < 0) {
            upsertShardProgress.run(shardPath, size, mtimeMs, readOffset);
            continue;
          }
          const nextReadOffset = readOffset + lastNewline + 1;
          const raw = tail.subarray(0, lastNewline + 1).toString('utf8');
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            try {
              const parsed = JSON.parse(trimmed) as unknown;
              if (!isAcceptedEvent(parsed)) continue;
              if (parsed.dot.seq <= (wm[parsed.dot.replicaId] ?? 0)) {
                // Below the per-replica watermark: an out-of-order /
                // already-committed shard event, permanently skipped.
                incrementStoreSkippedOutOfOrder();
                continue;
              }
              pending.push(parsed);
              if (pending.length >= CATCHUP_CHUNK) await flush();
            } catch {
              // skip malformed line; JSONL stays authoritative
            }
          }
          upsertShardProgress.run(shardPath, size, mtimeMs, nextReadOffset);
          if (progress === null && receipt !== undefined && receiptState === 'compacted') {
            // Fresh/rebuilt store: ingest the retained file first, then advance
            // the watermark across exactly the receipt-covered dots. This avoids
            // classifying retained lower-sequence rows as out-of-order.
            await flush();
            applyCompactionReceipt(receipt);
            wm = watermark();
          }
        }
      }
      // Flush at each root boundary (not just chunk boundaries) so a
      // subsequent root's watermark reads reflect everything this root
      // just contributed — required for the ordering guarantee above.
      await flush();
    }
    return count;
  };

  const rebuildFromJsonl = async (
    logRoot: string,
    priorRoots: readonly string[] = [],
  ): Promise<void> => {
    db.exec(`
      DELETE FROM events;
      DELETE FROM ingest_watermark;
      DELETE FROM shard_progress;
      DELETE FROM compacted_events;
      UPDATE compaction_receipt_trust SET trusted = 1 WHERE singleton = 1;
    `);
    await catchUpFromJsonl(logRoot, priorRoots);
  };

  const readSince = (frontier: VersionVector): readonly AcceptedEvent[] => {
    const entries = Object.entries(frontier).filter(([, seq]) => Number.isFinite(seq));
    if (entries.length === 0) {
      return rowsToEvents(
        db.query(`SELECT ${SELECT_COLUMNS} FROM events ORDER BY replica_id, seq`).all(),
      );
    }
    const notInPlaceholders = entries.map(() => '?').join(',');
    const clauses = [`replica_id NOT IN (${notInPlaceholders})`];
    const params: unknown[] = entries.map(([replicaId]) => replicaId);
    for (const [replicaId, seq] of entries) {
      clauses.push('(replica_id = ? AND seq > ?)');
      params.push(replicaId, seq);
    }
    return rowsToEvents(
      db
        .query(
          `SELECT ${SELECT_COLUMNS}
           FROM events
           WHERE ${clauses.join(' OR ')}
           ORDER BY replica_id, seq`,
        )
        .all(...params),
    );
  };

  const readByAggregate = (aggregateId: string): readonly AcceptedEvent[] =>
    rowsToEvents(
      db
        .query(
          `SELECT ${SELECT_COLUMNS}
           FROM events
           WHERE aggregate_id = ?
           ORDER BY replica_id, seq`,
        )
        .all(aggregateId),
    );

  const readByResolverUrls = (
    resolverUrls: readonly string[],
    types: readonly string[],
  ): readonly AcceptedEvent[] => {
    if (resolverUrls.length === 0 || types.length === 0) return [];
    const urlPlaceholders = resolverUrls.map(() => '?').join(', ');
    const typePlaceholders = types.map(() => '?').join(', ');
    return rowsToEvents(
      db
        .query(
          `SELECT ${SELECT_COLUMNS}
           FROM events
           WHERE resolver_url IN (${urlPlaceholders}) AND type IN (${typePlaceholders})
           ORDER BY replica_id, seq`,
        )
        .all(...resolverUrls, ...types),
    );
  };

  const readMostRecentByType = (type: string, limit: number): readonly AcceptedEvent[] => {
    if (limit <= 0) return [];
    return rowsToEvents(
      db
        .query(
          `SELECT ${SELECT_COLUMNS}
           FROM events
           WHERE type = ?
           ORDER BY accepted_at_ms DESC
           LIMIT ?`,
        )
        .all(type, Math.floor(limit)),
    );
  };

  const maxAcceptedAtMs = (): number => {
    const row = db
      .query(
        `SELECT MAX(value) AS max FROM (
           SELECT COALESCE(MAX(accepted_at_ms), 0) AS value FROM events
           UNION ALL
           SELECT CASE
             WHEN (SELECT trusted FROM compaction_receipt_trust WHERE singleton = 1) = 1
             THEN COALESCE(MAX(accepted_at_ms), 0)
             ELSE 0
           END AS value FROM compacted_events
         )`,
      )
      .get();
    return row === null || row === undefined ? 0 : numberField(row, 'max');
  };

  const maxAcceptedAtMsForType = (type: string): number => {
    const row = db
      .query('SELECT COALESCE(MAX(accepted_at_ms), 0) AS max FROM events WHERE type = ?')
      .get(type);
    return row === null || row === undefined ? 0 : numberField(row, 'max');
  };

  const maxCompactedAcceptedAtMsForType = (type: string): number => {
    const row = db
      .query(
        `SELECT CASE WHEN trust.trusted = 1
           THEN COALESCE(MAX(compacted.accepted_at_ms), 0)
           ELSE 0
         END AS max
         FROM compaction_receipt_trust AS trust
         LEFT JOIN compacted_events AS compacted ON compacted.type = ?
         WHERE trust.singleton = 1`,
      )
      .get(type);
    return row === null || row === undefined ? 0 : numberField(row, 'max');
  };

  const count = (): number => {
    const row = db.query('SELECT COUNT(*) AS count FROM events').get();
    return row === null || row === undefined ? 0 : numberField(row, 'count');
  };

  const expectedRetainedCount = (): number => {
    const expectedFromWatermark = Object.values(watermark()).reduce((sum, seq) => sum + seq, 0);
    const row = db
      .query(
        `SELECT CASE
           WHEN (SELECT trusted FROM compaction_receipt_trust WHERE singleton = 1) = 1
           THEN COUNT(*)
           ELSE 0
         END AS count
         FROM compacted_events`,
      )
      .get();
    const trustedCompactedCount = row === null || row === undefined ? 0 : numberField(row, 'count');
    return expectedFromWatermark - trustedCompactedCount;
  };

  const forEachChunk = async (
    cb: (chunk: readonly AcceptedEvent[]) => void | Promise<void>,
    chunkSize: number,
  ): Promise<void> => {
    const size = Math.max(1, Math.floor(chunkSize));
    let lastReplicaId = '';
    let lastSeq = 0;
    while (true) {
      const rows = db
        .query(
          `SELECT ${SELECT_COLUMNS}
           FROM events
           WHERE replica_id > ? OR (replica_id = ? AND seq > ?)
           ORDER BY replica_id, seq
           LIMIT ?`,
        )
        .all(lastReplicaId, lastReplicaId, lastSeq, size);
      const chunk = rowsToEvents(rows);
      if (chunk.length === 0) return;
      await cb(chunk);
      const last = chunk[chunk.length - 1];
      if (last === undefined) return;
      lastReplicaId = last.dot.replicaId;
      lastSeq = last.dot.seq;
      if (chunk.length < size) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const forEachChunkOfTypes = async (
    types: readonly string[],
    cb: (chunk: readonly AcceptedEvent[]) => void | Promise<void>,
    chunkSize: number,
  ): Promise<void> => {
    if (types.length === 0) return;
    const size = Math.max(1, Math.floor(chunkSize));
    const placeholders = types.map(() => '?').join(', ');
    let lastReplicaId = '';
    let lastSeq = 0;
    while (true) {
      const rows = db
        .query(
          `SELECT ${SELECT_COLUMNS}
           FROM events
           WHERE type IN (${placeholders})
             AND (replica_id > ? OR (replica_id = ? AND seq > ?))
           ORDER BY replica_id, seq
           LIMIT ?`,
        )
        .all(...types, lastReplicaId, lastReplicaId, lastSeq, size);
      const chunk = rowsToEvents(rows);
      if (chunk.length === 0) return;
      await cb(chunk);
      const last = chunk[chunk.length - 1];
      if (last === undefined) return;
      lastReplicaId = last.dot.replicaId;
      lastSeq = last.dot.seq;
      if (chunk.length < size) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  // UTC-midnight bounds for a YYYY-MM-DD day — integer ms, index-friendly
  // (events_accepted_at_ms_idx) where a strftime() predicate would scan.
  const dayBoundsMs = (day: string): { readonly lo: number; readonly hi: number } => {
    const lo = Date.parse(`${day}T00:00:00.000Z`);
    if (!Number.isFinite(lo)) throw new Error(`invalid day stamp: ${day}`);
    return { lo, hi: lo + 24 * 60 * 60 * 1000 };
  };

  const sealDayStats = (replicaId: string): readonly SealDayStat[] => {
    const rows = db
      .query(
        `SELECT strftime('%Y-%m-%d', accepted_at_ms / 1000, 'unixepoch') AS day,
                COUNT(*) AS n, MIN(seq) AS seq_lo, MAX(seq) AS seq_hi
           FROM events WHERE replica_id = ?
          GROUP BY day ORDER BY day`,
      )
      .all(replicaId);
    return rows.map((row) => ({
      day: stringField(row, 'day'),
      rows: numberField(row, 'n'),
      seqLo: numberField(row, 'seq_lo'),
      seqHi: numberField(row, 'seq_hi'),
    }));
  };

  const readSealRows = (replicaId: string, day: string): readonly SealRow[] => {
    const { lo, hi } = dayBoundsMs(day);
    const rows = db
      .query(
        `SELECT replica_id, seq, type, accepted_at_ms, aggregate_id,
                client_event_id, payload
           FROM events
          WHERE replica_id = ? AND accepted_at_ms >= ? AND accepted_at_ms < ?
          ORDER BY seq`,
      )
      .all(replicaId, lo, hi);
    return rows.map((row) => ({
      replicaId: stringField(row, 'replica_id'),
      seq: numberField(row, 'seq'),
      type: stringField(row, 'type'),
      acceptedAtMs: numberField(row, 'accepted_at_ms'),
      aggregateId: stringField(row, 'aggregate_id'),
      clientEventId: stringField(row, 'client_event_id'),
      payload: stringField(row, 'payload'),
    }));
  };

  const readEventsForDay = (replicaId: string, day: string): readonly AcceptedEvent[] => {
    const { lo, hi } = dayBoundsMs(day);
    const rows = db
      .query(
        `SELECT ${SELECT_COLUMNS}
           FROM events
          WHERE replica_id = ? AND accepted_at_ms >= ? AND accepted_at_ms < ?
          ORDER BY seq`,
      )
      .all(replicaId, lo, hi);
    return rowsToEvents(rows);
  };

  const compactedRowCountForDay = (replicaId: string, day: string): number => {
    const { lo, hi } = dayBoundsMs(day);
    const row = db
      .query(
        `SELECT COUNT(*) AS n FROM compacted_events
          WHERE replica_id = ? AND accepted_at_ms >= ? AND accepted_at_ms < ?`,
      )
      .get(replicaId, lo, hi);
    return numberField(row, 'n');
  };

  return {
    ingest: (event) => {
      ingest(event);
    },
    ingestMany,
    catchUp,
    catchUpFromJsonl,
    rebuildFromJsonl,
    readSince,
    readByAggregate,
    readByResolverUrls,
    readMostRecentByType,
    maxAcceptedAtMs,
    maxAcceptedAtMsForType,
    maxCompactedAcceptedAtMsForType,
    count,
    expectedRetainedCount,
    forEachChunk,
    forEachChunkOfTypes,
    watermark,
    sealDayStats,
    readSealRows,
    readEventsForDay,
    compactedRowCountForDay,
    close: () => {
      db.close?.();
    },
  };
};

export const getSharedEventStore = (vaultRoot: string): Promise<EventStore | null> => {
  if (!eventStoreEnabled()) return Promise.resolve(null);
  const existing = sharedEventStores.get(vaultRoot);
  if (existing !== undefined) return existing;
  const created = createEventStore(vaultRoot).catch(() => null);
  sharedEventStores.set(vaultRoot, created);
  return created;
};

// Test-only: injected at the head of every coalesced pass so tests can hold
// a catch-up open deterministically and prove serve-stale reads do not wait.
let catchUpGateForTest: (() => Promise<void>) | null = null;
export const setEventStoreCatchUpGateForTest = (gate: (() => Promise<void>) | null): void => {
  catchUpGateForTest = gate;
};

// ONE coalesced catch-up pass per vault PER PROCESS. Every caller — the
// awaited route variant below, the serve-stale kick, and the connections
// materializer's own pre-drain passes — shares the same in-flight promise,
// so no caller can ever start a second overlapping JSONL pass on a store
// another caller is already filling. (Measured before this existed: an HTTP
// read arriving mid-drain-pass started its OWN pass and parked 30-70s.)
// Process-local by design: the reconcile child has its own module instance
// and store handle; cross-process exclusion remains SQLite busy_timeout.
// Returns the pass's ingested-event count; a joiner receives the count of
// the pass it waited on, which is what the drain's diagnostics want anyway.
export const startCoalescedEventStoreCatchUp = (
  vaultRoot: string,
  store: EventStore,
): Promise<number> => {
  const existing = catchUpInFlight.get(vaultRoot);
  if (existing !== undefined) return existing;
  const pass = (async (): Promise<number> => {
    try {
      if (catchUpGateForTest !== null) await catchUpGateForTest();
      return await store.catchUpFromJsonl(join(vaultRoot, '_BAC', 'log'));
    } finally {
      catchUpInFlight.delete(vaultRoot);
    }
  })();
  catchUpInFlight.set(vaultRoot, pass);
  return pass;
};

export const getCaughtUpSharedEventStore = async (
  vaultRoot: string,
): Promise<EventStore | null> => {
  const store = await getSharedEventStore(vaultRoot);
  if (store === null) return null;
  await startCoalescedEventStoreCatchUp(vaultRoot, store);
  return store;
};

// Serve-stale variant for interactive reads: returns the store AS-IS —
// watermark-bounded and internally consistent, just possibly behind the
// JSONL tail — and kicks (or joins) the coalesced catch-up WITHOUT awaiting
// it. This is the read side of the inversion /v1/status shipped long ago
// (kickBackgroundEventStoreCatchUp): freshness is the background pass's
// problem, never a request's. A serve-stale reader must not fail because
// ingest failed, so the kicked pass's rejection is swallowed here; the
// awaited variant above still surfaces it to callers that require freshness.
export const getSharedEventStoreServeStale = async (
  vaultRoot: string,
): Promise<EventStore | null> => {
  const store = await getSharedEventStore(vaultRoot);
  if (store === null) return null;
  startCoalescedEventStoreCatchUp(vaultRoot, store).catch(() => {});
  return store;
};

// Deterministic token for WHAT A STALE READ ACTUALLY SAW. Anything that
// memoizes a fold computed from a serve-stale store MUST key the memo on
// this — never on eventLog.logSignature(), which advances on shard appends
// the stale read has not ingested. A fold cached under the log signature
// would claim coverage it does not have and keep serving the stale result
// even after catch-up lands (the memo-poisoning shape this repo has hit
// before, on the gist lookup).
export const eventStoreCoverageToken = (store: EventStore): string => {
  const wm = store.watermark();
  return `store:${Object.keys(wm)
    .sort()
    .map((replica) => `${replica}=${String(wm[replica] ?? 0)}`)
    .join(',')}`;
};
