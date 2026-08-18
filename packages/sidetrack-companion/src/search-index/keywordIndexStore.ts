// Keyword index — an incrementally-maintained inverted index (keyword ->
// bounded page set) plus a per-page keyword lookup, for the keyword layer
// (docs/plans/2026-08-16-category-flexibility-hyde.md, keyword section).
//
// SAME FAMILY AS searchQueryIndexStore.ts, DELIBERATELY. Colocated in
// search-index/ alongside searchQueryIndexStore.ts and captureTextFtsStore.ts
// — same SQLite scaffolding (bun:sqlite, WAL, `CREATE ... IF NOT EXISTS`, no
// migration framework — additive schema self-heals per this codebase's
// standing convention), same PK-pair posting-list shape
// (`search_query_index`'s `(query_key, visit_key)` -> `(keyword, page_key)`
// here).
//
// WHY A MAINTAINED STORE AND NOT A PURE FOLD (unlike entityIndex.ts, which
// recomputes live from the event log on every memoized read). Two downstream
// consumers need O(1) RANDOM ACCESS, not "recompute the whole thing when
// dirty": the concept-normalization step (keywordConcepts.ts) needs a stable
// per-page keyword list to embed against, and the split/new-topic clustering
// hybrid distance (splitSuggestionEngine.ts) needs per-page concept-id
// lookups on every candidate pair — paying an O(all gists) fold on every one
// of those would defeat the "no full rebuild" binding rule this feature is
// under. A page-keyed upsert costs O(k) (k = keywords for that one page, a
// small bounded constant, typically 3-7) regardless of corpus size — this
// is the "O(1) amortized" the design calls for.
//
// PAGE KEY = the SAME `kind:id` key contentEnrichment.ts's GistLookup uses
// (`foldKey` there) — 'url:<canonicalUrl>' or 'thread:<bac_id>' — so a
// caller that already has a GistLookup key can address this store with zero
// translation.
//
// NOT WIRED INTO connectionsMaterializer.ts. That file is explicitly
// off-limits for this feature (a concurrent sibling area). This store is
// driven from two places instead, neither of which touches the
// materializer: (1) the live ingest hook in
// http/routes/enrichmentRoutes.ts's POST /v1/enrichment/content handler,
// called once per newly-accepted gist (true O(1) per event); (2) the
// backfill lane (keywordBackfillLane.ts), which walks OLD gists (saved
// before this feature shipped) in bounded batches. Both call the SAME
// `upsertPageKeywords` — there is no separate "live" vs "backfill" write
// path to keep in sync.
//
// RETRACTION. contentEnrichment.ts already resolves gist retractions
// (`ENTITY_ENRICHMENT_RETRACTED`) against semantic timestamps, not stream
// order — this store does not re-derive that logic. A caller that observes a
// gist's retraction calls `removePage`; this store has no opinion on WHEN
// that should happen, only on being correct once told.
//
// BOUNDED POSTING LISTS. Neither searchQueryIndexStore.ts nor
// captureTextFtsStore.ts cap a key's row count at write time (bounding is
// done at the READ call site, per that pattern's own investigation). A
// keyword index is different: an unbounded posting list for a common term
// ("api", "guide") would grow forever and turn every lookup of it into an
// O(vault) scan — the exact shape this codebase's "hub" precedent
// (entityIndex.ts's ENTITY_HUB_MAX_REFS) exists to avoid one level up. So
// this store DOES cap at write time: inserting past KEYWORD_POSTING_CAP
// evicts the OLDEST posting for that keyword (by observedAtMs) — a bounded,
// most-recent-biased window, not a promise of "every page ever tagged with
// this word".

import { join } from 'node:path';

export const KEYWORD_POSTING_CAP = 500;
export const DEFAULT_PAGES_FOR_KEYWORD_LIMIT = 100;

export type KeywordSource = 'llm' | 'deterministic';

export interface KeywordPostingRow {
  readonly pageKey: string;
  readonly observedAtMs: number;
}

export interface KeywordIndexStats {
  readonly distinctKeywords: number;
  readonly distinctPages: number;
}

export interface KeywordIndexStore {
  /**
   * Replace one page's keyword set (posting-list membership + the per-page
   * reverse row) atomically. Called with an EMPTY array when extraction
   * genuinely found nothing usable — the page row is still written (with an
   * empty keyword list) so `keywordsForPage` can distinguish "processed,
   * found nothing" from "never processed" (the signal the backfill lane
   * needs to avoid reprocessing forever).
   */
  readonly upsertPageKeywords: (
    pageKey: string,
    keywords: readonly string[],
    source: KeywordSource,
    observedAtMs: number,
  ) => void;
  /** Withdraw a page entirely — its postings and its reverse row. Idempotent. */
  readonly removePage: (pageKey: string) => void;
  /** undefined = never processed by this store. [] = processed, no keywords
   *  found. This distinction is load-bearing for the backfill lane. */
  readonly keywordsForPage: (pageKey: string) => readonly string[] | undefined;
  readonly hasPage: (pageKey: string) => boolean;
  /** Most-recently-observed pages carrying this keyword, bounded. */
  readonly pagesForKeyword: (
    keyword: string,
    limit?: number,
  ) => readonly KeywordPostingRow[];
  /** Every distinct keyword ever posted, alphabetical (stable order for
   *  reproducible reassignment). Used by the degenerate-concept-
   *  distribution self-heal repair (keywordIngest.ts's
   *  repairDegenerateKeywordConcepts) to enumerate the full vocabulary to
   *  re-embed — bounded by the same "dozens to low thousands of distinct
   *  terms" vocabulary size this store's own header describes, so an
   *  unbounded SELECT here is the same cheap shape as `stats()`, not an
   *  O(corpus) scan. */
  readonly distinctKeywords: () => readonly string[];
  readonly stats: () => KeywordIndexStats;
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
  CREATE TABLE IF NOT EXISTS keyword_posting (
    keyword TEXT NOT NULL,
    page_key TEXT NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    PRIMARY KEY (keyword, page_key)
  );
  CREATE INDEX IF NOT EXISTS keyword_posting_page ON keyword_posting(page_key);
  CREATE TABLE IF NOT EXISTS keyword_page (
    page_key TEXT PRIMARY KEY,
    keywords_json TEXT NOT NULL,
    source TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
`;

interface PageRow {
  readonly keywords_json: string;
}

interface PostingRow {
  readonly page_key: string;
  readonly observed_at_ms: number;
}

const parseKeywords = (json: string): readonly string[] => {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
};

export const createKeywordIndexStore = async (vaultRoot: string): Promise<KeywordIndexStore> => {
  const { Database } = await loadSqlite();
  const dbPath = join(vaultRoot, '_BAC', 'connections', 'keyword-index.db');
  const db = new Database(dbPath, { create: true, readwrite: true });
  db.exec(SCHEMA);

  const selectPage = db.query('SELECT keywords_json FROM keyword_page WHERE page_key = ?');
  const upsertPageRow = db.query(
    `INSERT INTO keyword_page (page_key, keywords_json, source, updated_at_ms)
     VALUES (?,?,?,?)
     ON CONFLICT(page_key) DO UPDATE SET
       keywords_json = excluded.keywords_json,
       source = excluded.source,
       updated_at_ms = excluded.updated_at_ms`,
  );
  const deletePageRow = db.query('DELETE FROM keyword_page WHERE page_key = ?');
  const deletePagePostings = db.query('DELETE FROM keyword_posting WHERE page_key = ?');
  const insertPosting = db.query(
    `INSERT INTO keyword_posting (keyword, page_key, observed_at_ms)
     VALUES (?,?,?)
     ON CONFLICT(keyword, page_key) DO UPDATE SET observed_at_ms = excluded.observed_at_ms`,
  );
  const countPostingsForKeyword = db.query(
    'SELECT COUNT(*) AS c FROM keyword_posting WHERE keyword = ?',
  );
  const deleteOldestPostings = db.query(
    `DELETE FROM keyword_posting WHERE keyword = ? AND page_key IN (
       SELECT page_key FROM keyword_posting WHERE keyword = ?
       ORDER BY observed_at_ms ASC, page_key ASC LIMIT ?
     )`,
  );
  const selectPagesForKeyword = db.query(
    `SELECT page_key, observed_at_ms FROM keyword_posting WHERE keyword = ?
     ORDER BY observed_at_ms DESC, page_key ASC LIMIT ?`,
  );
  const countDistinctKeywords = db.query('SELECT COUNT(DISTINCT keyword) AS c FROM keyword_posting');
  const countDistinctPages = db.query('SELECT COUNT(*) AS c FROM keyword_page');
  const selectDistinctKeywords = db.query(
    'SELECT DISTINCT keyword FROM keyword_posting ORDER BY keyword',
  );

  const capPostingsFor = (keyword: string): void => {
    const row = countPostingsForKeyword.get(keyword) as { readonly c: number } | undefined;
    const count = row?.c ?? 0;
    if (count > KEYWORD_POSTING_CAP) {
      deleteOldestPostings.run(keyword, keyword, count - KEYWORD_POSTING_CAP);
    }
  };

  const upsertPageKeywords = (
    pageKey: string,
    keywords: readonly string[],
    source: KeywordSource,
    observedAtMs: number,
  ): void => {
    // Dedupe defensively — callers are expected to hand already-normalized,
    // deduped keywords (keywordExtract.ts), but the store's own correctness
    // must not depend on that.
    const distinct = [...new Set(keywords)];
    db.exec('BEGIN');
    try {
      deletePagePostings.run(pageKey);
      upsertPageRow.run(pageKey, JSON.stringify(distinct), source, observedAtMs);
      for (const keyword of distinct) {
        insertPosting.run(keyword, pageKey, observedAtMs);
        capPostingsFor(keyword);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const removePage = (pageKey: string): void => {
    db.exec('BEGIN');
    try {
      deletePagePostings.run(pageKey);
      deletePageRow.run(pageKey);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const keywordsForPage = (pageKey: string): readonly string[] | undefined => {
    // bun:sqlite's Statement.get() returns `null`, not `undefined`, for "no
    // row" — checked with `== null` so both are treated the same way.
    const row = selectPage.get(pageKey) as PageRow | null | undefined;
    if (row == null) return undefined;
    return parseKeywords(row.keywords_json);
  };

  const hasPage = (pageKey: string): boolean => selectPage.get(pageKey) != null;

  const pagesForKeyword = (
    keyword: string,
    limit: number = DEFAULT_PAGES_FOR_KEYWORD_LIMIT,
  ): readonly KeywordPostingRow[] => {
    const rows = selectPagesForKeyword.all(
      keyword,
      Math.max(0, limit),
    ) as readonly PostingRow[];
    return rows.map((row) => ({ pageKey: row.page_key, observedAtMs: row.observed_at_ms }));
  };

  const stats = (): KeywordIndexStats => {
    const keywordsRow = countDistinctKeywords.get() as { readonly c: number } | undefined;
    const pagesRow = countDistinctPages.get() as { readonly c: number } | undefined;
    return {
      distinctKeywords: keywordsRow?.c ?? 0,
      distinctPages: pagesRow?.c ?? 0,
    };
  };

  const distinctKeywords = (): readonly string[] => {
    const rows = selectDistinctKeywords.all() as readonly { readonly keyword: string }[];
    return rows.map((row) => row.keyword);
  };

  return {
    upsertPageKeywords,
    removePage,
    keywordsForPage,
    hasPage,
    pagesForKeyword,
    distinctKeywords,
    stats,
    close: () => {
      db.close?.();
    },
  };
};
