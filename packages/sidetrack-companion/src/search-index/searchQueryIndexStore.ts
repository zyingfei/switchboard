// W2 of the F8 IVM plan (docs/plans/2026-08-16-f8-ivm-designs.md) —
// standalone sidecar for the search-visit join. NOT WIRED into the
// materializer yet; this file only exists so a later wave can read
// `visitsForQuery` instead of scanning every visit on every drain.
//
// Today the full build recomputes the `same_search_query` ranker
// candidate join from scratch by walking every visit record and
// re-detecting/normalizing its search query
// (src/ranker/candidates.ts:583-591 `searchQueryKeys`/
// `normalizeSearchQuery`; src/ranker/features.ts:456-479
// `searchQueriesForVisit`). This store persists (query_key, visit_key)
// pairs incrementally so that join becomes an indexed lookup.
//
// Search-URL detection reuses `detectSearchUrl` from
// timeline/sanitize.ts — the SAME function the materializer's own
// search-visit gate calls
// (src/sync/contract/connectionsMaterializer.ts:2274-2277
// `pendingEventIsSearchTimelineVisit`:
// `detectSearchUrl(event.payload.canonicalUrl ?? event.payload.url) !== null`).
// This store mirrors that exact condition rather than importing the
// materializer (which is being edited concurrently by another agent
// and is off-limits for this task).
//
// `query_key` normalization reuses `normalizeSearchQuery` from
// ./searchTextMatch.ts, itself a verbatim extraction of the
// (currently duplicated, unexported) helper in
// src/ranker/candidates.ts:583-584 / src/ranker/features.ts:456-457 —
// the SAME normalization the `same_search_query` candidate path uses,
// so `visitsForQuery` keys line up with that path once wired.
//
// `visit_key` uses the same `stripFragmentAndTrailingSlash` URL
// normalization src/connections/snapshot.ts uses for its timeline-visit
// node keys (snapshot.ts:671-672) — duplicated here as the tiny
// one-liner it is; the codebase already keeps ~8 independent copies of
// this exact helper (grep `stripFragmentAndTrailingSlash` across
// src/connections, src/tabsession, src/engagement, src/urls) rather
// than force a cross-module import for a single regex.
//
// Lifecycle (ingest/ingestMany/catchUp/watermark/rebuildFromJsonl/
// close) mirrors src/timeline/timelineFactsStore.ts's discipline:
// idempotent ingest keyed by (replicaId, seq) at the watermark layer,
// per-replica watermark that advances on EVERY event (not just
// relevant ones) so catchUp can skip irrelevant log tail cheaply,
// chunked catchUp that yields between chunks, and a recovery-only
// rebuildFromJsonl that replays the raw log (never called from an
// operational path — see the plan doc's "Binding rule").

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BROWSER_TIMELINE_OBSERVED, isBrowserTimelineObservedPayload } from '../timeline/events.js';
import { detectSearchUrl } from '../timeline/sanitize.js';
import { normalizeSearchQuery } from './searchTextMatch.js';
import type { AcceptedEvent, VersionVector } from '../sync/causal.js';

export interface SearchVisitRow {
  readonly visitKey: string;
  readonly observedAt: string;
}

export interface SearchQueryIndexStore {
  /** Idempotent by (queryKey, visitKey) — re-ingesting the same event
   *  is a no-op (same pair, same observedAt). Returns true when the
   *  event minted/refreshed a pair. */
  readonly ingest: (event: AcceptedEvent) => boolean;
  /** Batch ingest in one transaction. Returns the count that minted/
   *  refreshed a pair. */
  readonly ingestMany: (events: readonly AcceptedEvent[]) => number;
  /** Ingest only events past the persisted per-replica watermark. */
  readonly catchUp: (events: readonly AcceptedEvent[]) => Promise<number>;
  /** All (visitKey, observedAt) pairs sharing a query key. `queryKey`
   *  is normalized internally, so callers may pass a raw or
   *  already-normalized query string. */
  readonly visitsForQuery: (queryKey: string) => readonly SearchVisitRow[];
  /** Stream the JSONL shards and repopulate facts (cold rebuild /
   *  repair). Recovery-only — never called from an operational path. */
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
  CREATE TABLE IF NOT EXISTS search_query_index (
    query_key TEXT NOT NULL,
    visit_key TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (query_key, visit_key)
  );
  CREATE INDEX IF NOT EXISTS search_query_index_visit ON search_query_index(visit_key);
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

// Verbatim duplicate of src/connections/snapshot.ts:671-672 (see
// module comment for why this stays a local one-liner rather than a
// forced cross-module import).
const stripFragmentAndTrailingSlash = (url: string): string =>
  url.replace(/#.*$/u, '').replace(/\/+$/u, '');

export const createSearchQueryIndexStore = async (
  vaultRoot: string,
): Promise<SearchQueryIndexStore> => {
  const { Database } = await loadSqlite();
  const dbPath = join(vaultRoot, '_BAC', 'connections', 'search-query-index.db');
  const db = new Database(dbPath, { create: true, readwrite: true });
  db.exec(SCHEMA);

  const upsertPair = db.query(
    `INSERT INTO search_query_index (query_key, visit_key, observed_at)
     VALUES (?,?,?)
     ON CONFLICT(query_key, visit_key) DO UPDATE SET
       observed_at = MAX(observed_at, excluded.observed_at)`,
  );
  const bumpWatermark = db.query(
    `INSERT INTO ingest_watermark (replica_id, max_seq) VALUES (?, ?)
     ON CONFLICT(replica_id) DO UPDATE SET max_seq = MAX(max_seq, excluded.max_seq)`,
  );

  const ingest = (event: AcceptedEvent): boolean => {
    // Defensive: skip structurally-malformed events instead of
    // throwing inside a batch (mirrors timelineFactsStore.ts).
    if (
      typeof event?.dot?.replicaId !== 'string' ||
      typeof event.dot.seq !== 'number' ||
      typeof event.acceptedAtMs !== 'number'
    ) {
      return false;
    }
    const { replicaId, seq } = event.dot;
    let minted = false;
    if (
      event.type === BROWSER_TIMELINE_OBSERVED &&
      isBrowserTimelineObservedPayload(event.payload)
    ) {
      const payload = event.payload;
      const url = payload.canonicalUrl ?? payload.url;
      // Same condition as connectionsMaterializer.ts:2274-2277
      // `pendingEventIsSearchTimelineVisit` — see module comment.
      const search = detectSearchUrl(url);
      if (search !== null) {
        const queryKey = normalizeSearchQuery(search.query);
        if (queryKey.length > 0) {
          const visitKey = stripFragmentAndTrailingSlash(url);
          upsertPair.run(queryKey, visitKey, payload.observedAt);
          minted = true;
        }
      }
    }
    // Watermark advances for EVERY event so catchUp can skip the
    // whole log tail, not just search-relevant events.
    bumpWatermark.run(replicaId, seq);
    return minted;
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

  const visitsForQuery = (queryKey: string): readonly SearchVisitRow[] => {
    const normalized = normalizeSearchQuery(queryKey);
    const rows = db
      .query(
        `SELECT visit_key, observed_at FROM search_query_index
         WHERE query_key = ?
         ORDER BY visit_key`,
      )
      .all(normalized);
    return rows.map((row) => ({
      visitKey: stringField(row, 'visit_key'),
      observedAt: stringField(row, 'observed_at'),
    }));
  };

  const rebuildFromJsonl = async (logRoot: string): Promise<void> => {
    // True rebuild/repair: clear derived facts + watermark so stale
    // rows from a prior state can't survive. JSONL stays authoritative.
    // Recovery-only — see plan doc "Binding rule" (no operational path
    // may replay the log from the beginning).
    db.exec(`
      DELETE FROM search_query_index;
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
    ingest: (event) => ingest(event),
    ingestMany,
    catchUp,
    visitsForQuery,
    rebuildFromJsonl,
    watermark,
    close: () => {
      db.close?.();
    },
  };
};
