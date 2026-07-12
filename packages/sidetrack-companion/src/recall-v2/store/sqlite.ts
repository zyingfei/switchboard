// Recall v2 — SQLite FTS5 RecallStore implementation.
//
// Uses bun:sqlite (built into Bun, no native install) with FTS5 enabled
// by default. One database per vault, persisted at
// `_BAC/recall/v2/index.sqlite`. Schema is mtime-stable; rebuild on
// version bump is handled by `backfill.ts`.
//
// Why bun:sqlite over the existing `usearch` / `hnswlib-node`:
//   - FTS5 is mature, BM25-based, supports unicode61 tokenization
//   - No native build step — bun:sqlite ships with Bun
//   - Triggers auto-sync the FTS index from the source table
//   - Single-file durability + transactional writes (safer than the
//     current in-memory MiniSearch rebuilds-on-every-mtime-change)

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getSqliteDriver, type SqliteHandle, type SqliteStatement } from './driver.js';

import type {
  RecallStore,
  StoreDocument,
  StoreDocumentChunk,
  StoreFtsHit,
  StoreSourceKind,
} from './types.js';

// sqlite-vec ships a loadable extension binary. We resolve its
// platform-specific path here and call SqliteHandle.loadExtension
// directly — that keeps the load operation flowing through the
// driver abstraction (works with any future driver, not just bun:sqlite).
let cachedVecPath: string | null | undefined;
const resolveVecPath = (): string | null => {
  if (cachedVecPath !== undefined) return cachedVecPath;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vec = require('sqlite-vec') as { getLoadablePath?: () => string };
    cachedVecPath = typeof vec.getLoadablePath === 'function' ? vec.getLoadablePath() : null;
  } catch {
    cachedVecPath = null;
  }
  return cachedVecPath;
};

export const RECALL_DB_PATH = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'recall', 'v2', 'index.sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS docs (
  rowid          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id      TEXT UNIQUE NOT NULL,
  source_kind    TEXT NOT NULL,
  canonical_url  TEXT,
  title          TEXT,
  body           TEXT,
  url_tokens     TEXT,
  host           TEXT,
  first_seen_at  INTEGER,
  last_seen_at   INTEGER,
  thread_id      TEXT,
  content_hash   TEXT,
  body_indexed   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS docs_source ON docs(source_kind);
CREATE INDEX IF NOT EXISTS docs_last_seen ON docs(last_seen_at);
-- queryByCanonicalUrl is on the hot /v2/recall focus path (focus
-- lookup + graph-neighbor title hydration, several calls per request)
-- — without this index each call full-scans the docs table.
CREATE INDEX IF NOT EXISTS docs_canonical_url ON docs(canonical_url);

CREATE TABLE IF NOT EXISTS documents_chunks (
  chunk_id           TEXT PRIMARY KEY,
  document_entity_id TEXT NOT NULL,
  chunk_index        INTEGER NOT NULL,
  char_start         INTEGER NOT NULL,
  char_end           INTEGER NOT NULL,
  text               TEXT NOT NULL,
  evidence_terms_json TEXT NOT NULL,
  quality            TEXT NOT NULL,
  FOREIGN KEY(document_entity_id) REFERENCES docs(entity_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS documents_chunks_document
  ON documents_chunks(document_entity_id, chunk_index);

-- Tracks freshness signatures for the backfill staleness check.
-- See pipeline.ts:getOrOpenStore — backfill re-runs if the source-
-- of-truth signature differs from the stored one.
CREATE TABLE IF NOT EXISTS recall_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  title, body, url_tokens, host,
  content='docs', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- Keep FTS in sync via external content triggers (FTS5 contentless +
-- triggers pattern is the recommended approach for managed FTS).
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, title, body, url_tokens, host)
  VALUES (new.rowid, new.title, new.body, new.url_tokens, new.host);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, body, url_tokens, host)
  VALUES('delete', old.rowid, old.title, old.body, old.url_tokens, old.host);
END;
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, body, url_tokens, host)
  VALUES('delete', old.rowid, old.title, old.body, old.url_tokens, old.host);
  INSERT INTO docs_fts(rowid, title, body, url_tokens, host)
  VALUES (new.rowid, new.title, new.body, new.url_tokens, new.host);
END;
`;

const sourceKindFilter = (
  kinds: StoreSourceKind | readonly StoreSourceKind[],
): { sql: string; params: string[] } => {
  const arr: readonly StoreSourceKind[] = Array.isArray(kinds)
    ? (kinds as readonly StoreSourceKind[])
    : [kinds as StoreSourceKind];
  if (arr.length === 0) return { sql: '1=0', params: [] };
  if (arr.length === 1) return { sql: 'docs.source_kind = ?', params: [arr[0]!] };
  const placeholders = arr.map(() => '?').join(',');
  return { sql: `docs.source_kind IN (${placeholders})`, params: [...arr] };
};

/** Escape a free-text query for FTS5 MATCH. FTS5 has its own query
 *  syntax; bare words AND'ed together work fine for our case (the
 *  query-analysis layer already stripped stopwords). We just need to
 *  quote each token to avoid syntax errors on punctuation. */
const escapeFts5Query = (q: string): string => {
  const tokens = q.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  // FTS5 column-prefix syntax: each token becomes "tok" (double-quoted
  // to escape any operators); columns are unweighted here (boosts
  // happen via the bm25() ranking call below).
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
};

class SqliteRecallStore implements RecallStore {
  get vectorBackendAvailable(): boolean {
    return this.vecAvailable;
  }

  private readonly db: SqliteHandle;
  // Prepared statements — re-used across queries; the underlying
  // driver caches compiled plans so this is the recommended pattern.
  private readonly upsertStmt: SqliteStatement;
  private readonly deleteStmt: SqliteStatement;
  private readonly countStmt: SqliteStatement;
  private readonly countByKindStmt: SqliteStatement;

  private vecAvailable = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    const driver = getSqliteDriver();
    this.db = driver.open(dbPath);
    this.db.exec(SCHEMA);
    // sqlite-vec extension load. Requires the driver to report
    // `extensionsSupported`. For bun:sqlite that means setup-sqlite.ts
    // pointed Bun at a system libsqlite3 (Homebrew on macOS, distro
    // libsqlite3 on Linux). When unsupported, vec stays disabled and
    // vector queries return [] (the JSON sidecar in the pipeline
    // is the fallback).
    const vecPath = driver.extensionsSupported ? resolveVecPath() : null;
    if (vecPath !== null) {
      try {
        this.db.loadExtension(vecPath);
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS docs_vec USING vec0(
            entity_id TEXT PRIMARY KEY,
            embedding FLOAT[384]
          );
          CREATE VIRTUAL TABLE IF NOT EXISTS documents_chunks_vec USING vec0(
            chunk_id TEXT PRIMARY KEY,
            embedding float[384]
          );
        `);
        this.vecAvailable = true;
        console.warn(`[recall-v2] sqlite-vec loaded via ${driver.name}; docs_vec ready`);
      } catch (err) {
        console.warn('[recall-v2] sqlite-vec load failed (vectors will be []):', err);
      }
    }
    this.upsertStmt = this.db.prepare(`
      INSERT INTO docs (entity_id, source_kind, canonical_url, title, body, url_tokens, host,
                        first_seen_at, last_seen_at, thread_id, content_hash, body_indexed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_id) DO UPDATE SET
        source_kind=excluded.source_kind,
        canonical_url=excluded.canonical_url,
        title=excluded.title,
        body=excluded.body,
        url_tokens=excluded.url_tokens,
        host=excluded.host,
        first_seen_at=excluded.first_seen_at,
        last_seen_at=excluded.last_seen_at,
        thread_id=excluded.thread_id,
        content_hash=excluded.content_hash,
        body_indexed=excluded.body_indexed
    `);
    this.deleteStmt = this.db.prepare('DELETE FROM docs WHERE entity_id = ?');
    this.countStmt = this.db.prepare('SELECT COUNT(*) AS c FROM docs');
    this.countByKindStmt = this.db.prepare('SELECT COUNT(*) AS c FROM docs WHERE source_kind = ?');
  }

  upsertDocument(doc: StoreDocument): void {
    this.upsertStmt.run(
      doc.entityId,
      doc.sourceKind,
      doc.canonicalUrl ?? null,
      doc.title ?? null,
      doc.body ?? null,
      doc.urlTokens ?? null,
      doc.host ?? null,
      doc.firstSeenAtMs ?? null,
      doc.lastSeenAtMs ?? null,
      doc.threadId ?? null,
      doc.contentHash ?? null,
      doc.bodyIndexed,
    );
  }

  deleteDocument(entityId: string): void {
    this.deleteDocumentChunks(entityId);
    this.deleteVector(entityId);
    this.deleteStmt.run(entityId);
  }

  deleteDocumentsByHostFamily(domain: string): number {
    const trimmed = domain.trim().toLowerCase();
    if (trimmed.length === 0) return 0;
    // Match the eTLD+1 family: exact host or any subdomain of it. We
    // also defend against rows whose `host` was stored with a www.
    // prefix (host === 'www.' + domain) via the LIKE '%.'+domain arm.
    const suffix = `%.${trimmed}`;
    const rows = this.db
      .prepare('SELECT entity_id AS entityId FROM docs WHERE host = ? OR host LIKE ?')
      .all<{ entityId: string }>(trimmed, suffix);
    if (rows.length === 0) return 0;
    // deleteDocument cascades to chunks + vectors. Wrap in a
    // transaction so a multi-row purge is atomic + amortizes WAL fsync.
    this.runTransaction(() => {
      for (const row of rows) this.deleteDocument(row.entityId);
    });
    return rows.length;
  }

  getRecallMetadata(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM recall_metadata WHERE key = ?')
      .get<{ value: string }>(key);
    return row?.value;
  }

  setRecallMetadata(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO recall_metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  allEntityIdsByKind(sourceKind: StoreSourceKind): ReadonlySet<string> {
    const rows = this.db
      .prepare('SELECT entity_id AS entityId FROM docs WHERE source_kind = ?')
      .all<{ entityId: string }>(sourceKind);
    return new Set(rows.map((r) => r.entityId));
  }

  runTransaction<T>(fn: () => T): T {
    // BEGIN IMMEDIATE acquires the write lock up front so any other
    // writer blocks at BEGIN instead of conflicting mid-transaction.
    // Reads are unaffected (WAL allows concurrent readers).
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Already rolled back or never began — best-effort cleanup.
      }
      throw err;
    }
  }

  deleteVector(entityId: string): void {
    if (!this.vecAvailable) return;
    try {
      this.db.prepare('DELETE FROM docs_vec WHERE entity_id = ?').run(entityId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[recall-v2] vec delete failed:', err);
    }
  }

  upsertDocumentChunks(documentEntityId: string, chunks: readonly StoreDocumentChunk[]): void {
    this.db
      .prepare('DELETE FROM documents_chunks WHERE document_entity_id = ?')
      .run(documentEntityId);
    const stmt = this.db.prepare(`
      INSERT INTO documents_chunks (
        chunk_id, document_entity_id, chunk_index, char_start, char_end,
        text, evidence_terms_json, quality
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        document_entity_id=excluded.document_entity_id,
        chunk_index=excluded.chunk_index,
        char_start=excluded.char_start,
        char_end=excluded.char_end,
        text=excluded.text,
        evidence_terms_json=excluded.evidence_terms_json,
        quality=excluded.quality
    `);
    for (const chunk of chunks) {
      stmt.run(
        chunk.chunkId,
        chunk.documentEntityId,
        chunk.chunkIndex,
        chunk.charStart,
        chunk.charEnd,
        chunk.text,
        chunk.evidenceTermsJson,
        chunk.quality,
      );
    }
  }

  deleteDocumentChunks(documentEntityId: string): void {
    const rows = this.db
      .prepare('SELECT chunk_id AS chunkId FROM documents_chunks WHERE document_entity_id = ?')
      .all<{ chunkId: string }>(documentEntityId);
    this.db
      .prepare('DELETE FROM documents_chunks WHERE document_entity_id = ?')
      .run(documentEntityId);
    for (const row of rows) this.deleteChunkVector(row.chunkId);
  }

  deleteDocumentChunk(chunkId: string): void {
    this.db.prepare('DELETE FROM documents_chunks WHERE chunk_id = ?').run(chunkId);
    this.deleteChunkVector(chunkId);
  }

  allDocumentChunkIds(): ReadonlySet<string> {
    const rows = this.db
      .prepare('SELECT chunk_id AS chunkId FROM documents_chunks')
      .all<{ chunkId: string }>();
    return new Set(rows.map((row) => row.chunkId));
  }

  deleteChunkVector(chunkId: string): void {
    if (!this.vecAvailable) return;
    try {
      this.db.prepare('DELETE FROM documents_chunks_vec WHERE chunk_id = ?').run(chunkId);
    } catch (err) {
      console.warn('[recall-v2] chunk vec delete failed:', err);
    }
  }

  allChunkVectorIds(): ReadonlySet<string> {
    if (!this.vecAvailable) return new Set();
    try {
      const rows = this.db
        .prepare('SELECT chunk_id AS chunkId FROM documents_chunks_vec')
        .all<{ chunkId: string }>();
      return new Set(rows.map((r) => r.chunkId));
    } catch {
      return new Set();
    }
  }

  allVectorEntityIds(): ReadonlySet<string> {
    if (!this.vecAvailable) return new Set();
    try {
      const rows = this.db
        .prepare('SELECT entity_id AS entityId FROM docs_vec')
        .all<{ entityId: string }>();
      return new Set(rows.map((r) => r.entityId));
    } catch {
      return new Set();
    }
  }

  documentCount(sourceKind?: StoreSourceKind): number {
    const row = (
      sourceKind === undefined ? this.countStmt.get() : this.countByKindStmt.get(sourceKind)
    ) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  queryFts(opts: {
    readonly q: string;
    readonly sourceKind: StoreSourceKind | readonly StoreSourceKind[];
    readonly limit: number;
  }): readonly StoreFtsHit[] {
    const ftsQuery = escapeFts5Query(opts.q);
    if (ftsQuery === '""') return [];
    const filter = sourceKindFilter(opts.sourceKind);
    // BM25F field weights: title 2x body, url 1x body, host 0.5x.
    // Title is high-precision (short, intentional); body is noise-prone
    // (long, opportunistic). The 2x is calibrated against the eval
    // fixtures — bumping to 5x silently surfaces forbidden docs that
    // weakly match a common token in title (e.g. "security" in kernel
    // security docs vs CVE writeups). Source-quality differentiation
    // belongs at fusion (smooth gate on semantic) + post-retrieval
    // cross-encoder rerank, NOT at BM25 weights.
    //
    // `snippet(docs_fts, 1, '', '', '…', 64)` extracts the matched
    // passage from the body column (index 1) with a 64-token budget.
    // Fed to the cross-encoder rerank when enabled — the CE has a
    // 512-token sequence limit, so passing snippet (matched paragraph)
    // beats passing the raw body (silently truncated to the intro).
    const sql = `
      SELECT
        docs.entity_id    AS entityId,
        docs.source_kind  AS sourceKind,
        docs.canonical_url AS canonicalUrl,
        docs.title        AS title,
        docs.thread_id    AS threadId,
        docs.last_seen_at AS lastSeenAt,
        docs.first_seen_at AS firstSeenAt,
        -bm25(docs_fts, 2.0, 1.0, 1.0, 0.5) AS bm25,
        snippet(docs_fts, 1, '', '', '…', 64) AS bodySnippet
      FROM docs
      JOIN docs_fts ON docs.rowid = docs_fts.rowid
      WHERE docs_fts MATCH ?
        AND ${filter.sql}
      ORDER BY bm25 DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(ftsQuery, ...filter.params, opts.limit) as {
      entityId: string;
      sourceKind: string;
      canonicalUrl: string | null;
      title: string | null;
      threadId: string | null;
      lastSeenAt: number | null;
      firstSeenAt: number | null;
      bm25: number;
      bodySnippet: string | null;
    }[];
    return rows.map((r): StoreFtsHit => {
      // Empty snippet (title-only docs with no body) → undefined so
      // the cross-encoder rerank falls back to title alone.
      const snippet =
        r.bodySnippet !== null && r.bodySnippet.length > 0 ? r.bodySnippet : undefined;
      return {
        entityId: r.entityId,
        sourceKind: r.sourceKind as StoreSourceKind,
        ...(r.canonicalUrl === null ? {} : { canonicalUrl: r.canonicalUrl }),
        ...(r.title === null ? {} : { title: r.title }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(r.threadId === null ? {} : { threadId: r.threadId }),
        bm25: r.bm25,
        ...(r.firstSeenAt === null
          ? r.lastSeenAt === null
            ? {}
            : { capturedAtMs: r.lastSeenAt }
          : { capturedAtMs: r.firstSeenAt }),
      };
    });
  }

  queryByCanonicalUrl(opts: {
    readonly canonicalUrl: string;
    readonly limit: number;
  }): readonly StoreFtsHit[] {
    // Direct lookup — no FTS5, so URL punctuation doesn't matter and
    // the result is exact-match only. Used by the `focus` source so
    // the Now card surfaces the active page itself plus any
    // same-URL variants stored under different source_kind rows.
    const sql = `
      SELECT
        entity_id    AS entityId,
        source_kind  AS sourceKind,
        canonical_url AS canonicalUrl,
        title        AS title,
        thread_id    AS threadId,
        last_seen_at AS lastSeenAt,
        first_seen_at AS firstSeenAt
      FROM docs
      WHERE canonical_url = ?
      ORDER BY
        CASE source_kind WHEN 'page_content' THEN 0 WHEN 'timeline_visit' THEN 1 ELSE 2 END,
        COALESCE(last_seen_at, first_seen_at, 0) DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(opts.canonicalUrl, opts.limit) as {
      entityId: string;
      sourceKind: string;
      canonicalUrl: string | null;
      title: string | null;
      threadId: string | null;
      lastSeenAt: number | null;
      firstSeenAt: number | null;
    }[];
    return rows.map(
      (r): StoreFtsHit => ({
        entityId: r.entityId,
        sourceKind: r.sourceKind as StoreSourceKind,
        ...(r.canonicalUrl === null ? {} : { canonicalUrl: r.canonicalUrl }),
        ...(r.title === null ? {} : { title: r.title }),
        ...(r.threadId === null ? {} : { threadId: r.threadId }),
        // bm25 is N/A for direct lookup; use a constant 1.0 so the
        // pipeline's downstream candidate-from-hit conversion still
        // emits a stable per-row rank.
        bm25: 1,
        ...(r.firstSeenAt === null
          ? r.lastSeenAt === null
            ? {}
            : { capturedAtMs: r.lastSeenAt }
          : { capturedAtMs: r.firstSeenAt }),
      }),
    );
  }

  upsertVector(entityId: string, vec: Float32Array): void {
    if (!this.vecAvailable) return;
    try {
      // sqlite-vec stores vectors as JSON arrays in the virtual table;
      // upsert via DELETE + INSERT to avoid conflict on the PK.
      this.db.prepare('DELETE FROM docs_vec WHERE entity_id = ?').run(entityId);
      const arr = Array.from(vec);
      this.db
        .prepare('INSERT INTO docs_vec (entity_id, embedding) VALUES (?, ?)')
        .run(entityId, JSON.stringify(arr));
    } catch (err) {
      console.warn('[recall-v2] vec upsert failed:', err);
    }
  }

  upsertChunkVector(chunkId: string, vec: Float32Array): void {
    if (!this.vecAvailable) return;
    try {
      this.db.prepare('DELETE FROM documents_chunks_vec WHERE chunk_id = ?').run(chunkId);
      this.db
        .prepare('INSERT INTO documents_chunks_vec (chunk_id, embedding) VALUES (?, ?)')
        .run(chunkId, JSON.stringify(Array.from(vec)));
    } catch (err) {
      console.warn('[recall-v2] chunk vec upsert failed:', err);
    }
  }

  queryVector(opts: {
    readonly vec: Float32Array;
    readonly limit: number;
    readonly excludeEntityIds?: ReadonlySet<string>;
  }): readonly {
    readonly entityId: string;
    readonly canonicalUrl: string | undefined;
    readonly title: string | undefined;
    readonly cosineDistance: number;
    readonly bodyIndexed: 0 | 1;
  }[] {
    if (!this.vecAvailable) return [];
    try {
      const target = JSON.stringify(Array.from(opts.vec));
      // sqlite-vec rejects KNN queries unless the LIMIT (or `k = ?`
      // constraint) is bound to the docs_vec MATCH plan. A simple
      // `LEFT JOIN docs ... LIMIT N` hides the LIMIT from the vec0
      // virtual table — the runtime throws
      // `SQLiteError: A LIMIT or 'k = ?' constraint is required on
      // vec0 knn queries.`
      //
      // Fix: do the MATCH+LIMIT in a subquery (vec0 sees its own
      // LIMIT), then join out to docs for canonical_url / title.
      // body_indexed is already on the docs schema (1 = body extracted,
      // 0 = title+URL only). Returning it lets callers distinguish a
      // content vector from a title-only vector so they can LOG the
      // provenance of a KNN hit. It is READ-ONLY here: fusion/ordering
      // is unchanged (the ORDER BY is still cosine distance), and any
      // down-weighting of title-only hits is a serving-math change gated
      // behind the P1 freeze (ADR-0011). COALESCE guards the LEFT JOIN
      // miss (vector present but docs row swept) — treat unknown as 0.
      const sql = `
        SELECT v.entityId AS entityId,
               d.canonical_url AS canonicalUrl,
               d.title AS title,
               v.distance AS cosineDistance,
               COALESCE(d.body_indexed, 0) AS bodyIndexed
        FROM (
          SELECT entity_id AS entityId, distance
          FROM docs_vec
          WHERE embedding MATCH ?
          ORDER BY distance
          LIMIT ?
        ) AS v
        LEFT JOIN docs AS d ON d.entity_id = v.entityId
      `;
      const rows = this.db.prepare(sql).all(target, opts.limit) as {
        entityId: string;
        canonicalUrl: string | null;
        title: string | null;
        cosineDistance: number;
        bodyIndexed: number;
      }[];
      const mapped = rows.map((r) => ({
        entityId: r.entityId,
        canonicalUrl: r.canonicalUrl ?? undefined,
        title: r.title ?? undefined,
        cosineDistance: r.cosineDistance,
        bodyIndexed: (r.bodyIndexed === 1 ? 1 : 0) as 0 | 1,
      }));
      const exclude = opts.excludeEntityIds;
      if (exclude === undefined) return mapped;
      return mapped.filter((r) => !exclude.has(r.entityId));
    } catch (err) {
      console.warn('[recall-v2] vec query failed:', err);
      return [];
    }
  }

  close(): void {
    this.db.close();
  }
}

export const openSqliteRecallStore = (vaultRoot: string): RecallStore =>
  new SqliteRecallStore(RECALL_DB_PATH(vaultRoot));

export const openInMemoryRecallStore = (): RecallStore => new SqliteRecallStore(':memory:');
