import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import MiniSearch from 'minisearch';

import { extractPageEvidenceFeatures } from '../page-evidence/extract.js';
import { ANALYZER_VERSION, analyze } from '../search/analyzer.js';
import {
  PAGE_CONTENT_COVERAGE_STATES,
  PAGE_CONTENT_EXTRACTED,
  PAGE_CONTENT_TOMBSTONED,
  type ContentSearchHit,
  type PageContentChunk,
  type PageContentCoverage,
  type PageContentCoverageState,
  type PageContentExtractedPayload,
  type PageContentRecord,
  type PageContentTombstonedPayload,
} from './types.js';
import { recordCanonicalCollision } from './canonicalize-telemetry.js';
import { classifyPageContentQuality } from './quality.js';

// ─────────────────────────────────────────────────────────────────────
// F5 — single SQLite store (2026-08-16)
//
// Replaces the by-url/*.json + raw/*.json + chunks/*.json +
// manifest.json + chunks/manifest.json + ingest-state.json small-file
// layout (~703 files + a 157KB chunks-manifest rewritten on EVERY
// capture on the test vault — see docs/plans/2026-08-15-foundation-
// program.md F5 design note for the SQLite-vs-chDB-vs-DuckDB
// comparison). One `records` table (the full PageContentRecord as
// JSON plus indexed columns for the manifest-equivalent aggregate
// queries), one `raw_content` table keyed by contentHash, one `chunks`
// table keyed by contentHash. Rows ARE the manifest now: the #356/#357
// incremental-manifest-upsert machinery (applyPageContentManifestUpsert,
// rebuildPageContentManifests) is deleted — pageContentCoverageCounts
// reads a live SQL aggregate instead of a persisted, per-write-rewritten
// artifact. WAL + busy_timeout matches the vault-wide bun:sqlite
// crash-safety pattern (engagementFactsStore.ts, captureTextFtsStore.ts).
//
// ONE-TIME PORT (binding, no back-compat layer): on first open, if no
// page-content.db exists yet but the legacy by-url/ directory has
// entries, every legacy record/raw/chunk file is imported into a temp
// db, verified (row counts must match what was inserted), then
// published with a single atomic rename over the final path. A crash
// mid-port leaves only an abandoned temp file — the next open sees no
// final db and restarts the whole import from the untouched legacy
// files (idempotent by construction: the port never resumes partial
// rows, it always rebuilds the temp db from scratch). The legacy files
// are left on disk for an operator to delete manually; this module
// never deletes them and stops reading them entirely once the SQLite
// store exists.

interface SqliteStatement {
  readonly run: (
    ...params: readonly unknown[]
  ) => { readonly changes: number; readonly lastInsertRowid: number | bigint };
  readonly get: (...params: readonly unknown[]) => unknown;
  readonly all: (...params: readonly unknown[]) => readonly unknown[];
}
interface SqliteDatabase {
  readonly exec: (sql: string) => unknown;
  readonly query: (sql: string) => SqliteStatement;
  readonly close?: (opts?: { readonly throwOnError?: boolean }) => void;
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
  CREATE TABLE IF NOT EXISTS records (
    canonical_url TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    content_hash TEXT,
    updated_at TEXT NOT NULL,
    record_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS records_state ON records(state);
  CREATE TABLE IF NOT EXISTS raw_content (
    content_hash TEXT PRIMARY KEY,
    raw_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks (
    content_hash TEXT PRIMARY KEY,
    chunks_json TEXT NOT NULL
  );
`;

export const pageContentRoot = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'page-content');
export const pageContentDbPath = (vaultRoot: string): string =>
  join(pageContentRoot(vaultRoot), 'page-content.db');

// Legacy file-layout paths — port source ONLY. Never written again once
// the SQLite store exists; read here purely to import them once.
const legacyByUrlDir = (vaultRoot: string): string => join(pageContentRoot(vaultRoot), 'by-url');
const legacyRawDir = (vaultRoot: string): string => join(pageContentRoot(vaultRoot), 'raw');
const legacyChunksDir = (vaultRoot: string): string => join(pageContentRoot(vaultRoot), 'chunks');

const readJsonLegacy = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

const safeLegacyRecord = (value: unknown): PageContentRecord | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Partial<PageContentRecord>;
  if (
    typeof record.url !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    typeof record.coverage !== 'object' ||
    record.coverage === null
  ) {
    return null;
  }
  const coverage = record.coverage as Partial<PageContentCoverage>;
  if (typeof coverage.canonicalUrl !== 'string' || typeof coverage.state !== 'string') return null;
  return record as PageContentRecord;
};

const rmQuiet = async (path: string): Promise<void> => {
  await rm(path, { force: true });
};

/** Imports the legacy by-url/raw/chunks file layout into a fresh temp
 *  db, verifies row counts, then atomically publishes it over
 *  `finalPath`. Never called when `finalPath` already exists. */
const portLegacyPageContent = async (
  vaultRoot: string,
  finalPath: string,
  legacyByUrlNames: readonly string[],
  Database: SqliteModule['Database'],
): Promise<void> => {
  const tmpPath = `${finalPath}.porting.tmp`;
  // A prior crash mid-port may have left a partial temp db (or its
  // WAL/SHM sidecars) behind. Discard it unconditionally and restart
  // the import from the untouched legacy files — the port always
  // rebuilds the temp db from scratch, never resumes partial rows, so
  // this is safe regardless of how far a prior attempt got.
  await rmQuiet(tmpPath);
  await rmQuiet(`${tmpPath}-wal`);
  await rmQuiet(`${tmpPath}-shm`);

  const db = new Database(tmpPath, { create: true, readwrite: true });
  let recordCount = 0;
  let rawCount = 0;
  let chunkCount = 0;
  try {
    db.exec(SCHEMA);

    const insertRecord = db.query(
      'INSERT OR REPLACE INTO records (canonical_url, state, content_hash, updated_at, record_json) VALUES (?,?,?,?,?)',
    );
    db.exec('BEGIN');
    try {
      for (const name of legacyByUrlNames) {
        const record = safeLegacyRecord(
          await readJsonLegacy(join(legacyByUrlDir(vaultRoot), name)),
        );
        if (record === null) continue;
        insertRecord.run(
          record.coverage.canonicalUrl,
          record.coverage.state,
          record.coverage.contentHash ?? null,
          record.updatedAt,
          JSON.stringify(record),
        );
        recordCount += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const insertRaw = db.query(
      'INSERT OR REPLACE INTO raw_content (content_hash, raw_json) VALUES (?,?)',
    );
    const rawNames = (await readdir(legacyRawDir(vaultRoot)).catch(() => [] as string[])).filter(
      (name) => name.endsWith('.json'),
    );
    db.exec('BEGIN');
    try {
      for (const name of rawNames) {
        const raw = await readJsonLegacy<unknown>(join(legacyRawDir(vaultRoot), name));
        if (raw === null) continue;
        insertRaw.run(name.slice(0, -'.json'.length), JSON.stringify(raw));
        rawCount += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const insertChunks = db.query(
      'INSERT OR REPLACE INTO chunks (content_hash, chunks_json) VALUES (?,?)',
    );
    const chunkNames = (
      await readdir(legacyChunksDir(vaultRoot)).catch(() => [] as string[])
    ).filter((name) => name.endsWith('.json') && name !== 'manifest.json');
    db.exec('BEGIN');
    try {
      for (const name of chunkNames) {
        const chunkDoc = await readJsonLegacy<unknown>(join(legacyChunksDir(vaultRoot), name));
        if (chunkDoc === null) continue;
        insertChunks.run(name.slice(0, -'.json'.length), JSON.stringify(chunkDoc));
        chunkCount += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    // Verify before publishing: the temp db's row counts must match what
    // we just inserted (a crash/short-write mid-transaction would have
    // thrown above already, but this catches any silent driver-level
    // truncation before this becomes the durable store).
    const countOf = (table: string): number =>
      (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const verifiedRecords = countOf('records');
    const verifiedRaw = countOf('raw_content');
    const verifiedChunks = countOf('chunks');
    if (
      verifiedRecords !== recordCount ||
      verifiedRaw !== rawCount ||
      verifiedChunks !== chunkCount
    ) {
      throw new Error(
        `page-content port count mismatch: records ${String(verifiedRecords)}/${String(recordCount)}, ` +
          `raw ${String(verifiedRaw)}/${String(rawCount)}, chunks ${String(verifiedChunks)}/${String(chunkCount)}`,
      );
    }
    db.close?.();
  } catch (error) {
    db.close?.();
    await rmQuiet(tmpPath);
    await rmQuiet(`${tmpPath}-wal`);
    await rmQuiet(`${tmpPath}-shm`);
    throw error;
  }

  // Atomic publish: the fully-populated, verified temp db becomes the
  // durable store in one rename. A crash before this line leaves only
  // an abandoned temp file (cleaned up on the next port attempt); a
  // crash after it is a normal SQLite file, already durable.
  await rename(tmpPath, finalPath);
  await rmQuiet(`${tmpPath}-wal`);
  await rmQuiet(`${tmpPath}-shm`);
  console.warn(
    `[page-content] ported legacy file layout to SQLite: ${String(recordCount)} records, ` +
      `${String(rawCount)} raw text docs, ${String(chunkCount)} chunk docs. ` +
      `Old layout preserved at ${legacyByUrlDir(vaultRoot)} (and sibling raw/, chunks/) — safe to delete.`,
  );
};

const ensurePageContentDbFile = async (vaultRoot: string): Promise<void> => {
  const finalPath = pageContentDbPath(vaultRoot);
  if (existsSync(finalPath)) return;
  await mkdir(pageContentRoot(vaultRoot), { recursive: true });
  const legacyNames = (
    await readdir(legacyByUrlDir(vaultRoot)).catch(() => [] as string[])
  ).filter((name) => name.endsWith('.json'));
  const { Database } = await loadSqlite();
  if (legacyNames.length === 0) {
    // Fresh vault (or nothing legacy to import) — create the store
    // directly, no port.
    const db = new Database(finalPath, { create: true, readwrite: true });
    db.exec(SCHEMA);
    db.close?.();
    return;
  }
  await portLegacyPageContent(vaultRoot, finalPath, legacyNames, Database);
};

const dbCache = new Map<string, Promise<SqliteDatabase>>();

const getPageContentDb = (vaultRoot: string): Promise<SqliteDatabase> => {
  const cached = dbCache.get(vaultRoot);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<SqliteDatabase> => {
    await ensurePageContentDbFile(vaultRoot);
    const { Database } = await loadSqlite();
    const db = new Database(pageContentDbPath(vaultRoot), { create: true, readwrite: true });
    db.exec(SCHEMA);
    return db;
  })();
  dbCache.set(vaultRoot, promise);
  promise.catch(() => {
    // Don't cache a failed open — the next call gets a clean retry.
    if (dbCache.get(vaultRoot) === promise) dbCache.delete(vaultRoot);
  });
  return promise;
};

/** Boot hook: ports (if needed) and opens the store, so the one-time
 *  port runs deterministically at startup rather than silently on the
 *  first request. Safe to call repeatedly (cached). */
export const ensurePageContentStoreReady = async (vaultRoot: string): Promise<void> => {
  await getPageContentDb(vaultRoot);
};

/** Test-only: drop the in-process db-handle cache so a subsequent call
 *  re-evaluates "does page-content.db exist" from scratch, simulating a
 *  fresh process boot without actually spawning one. */
export const __resetPageContentDbCacheForTests = (vaultRoot?: string): void => {
  if (vaultRoot === undefined) {
    dbCache.clear();
    return;
  }
  dbCache.delete(vaultRoot);
};

// ─────────────────────────────────────────────────────────────────────
// Pure helpers (unaffected by storage backend)
// ─────────────────────────────────────────────────────────────────────

const MAX_RAW_TEXT_CHARS = 100_000;
const MAX_CHUNKS_PER_PAGE = 80;
const CHUNK_TARGET_CHARS = 1_200;

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'igshid',
  'ref_src',
  'ref',
  'share',
]);

export const canonicalizePageUrl = (raw: string): string => {
  const parsed = new URL(raw);
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key);
    }
  }
  const sorted = [...parsed.searchParams.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  parsed.search = '';
  for (const [k, v] of sorted) parsed.searchParams.append(k, v);
  const out = parsed.toString().replace(/\/$/u, '');
  return out.length > 0 ? out : parsed.toString();
};

const canonicalizePageUrlAndRecord = (raw: string): string => {
  const canonicalUrl = canonicalizePageUrl(raw);
  recordCanonicalCollision(raw, canonicalUrl);
  return canonicalUrl;
};

export const sha256Hex = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

export const splitPageContentIntoChunks = (input: {
  readonly canonicalUrl: string;
  readonly url: string;
  readonly title?: string;
  readonly contentHash: string;
  readonly text: string;
  readonly extractedAt: string;
  readonly quality: 'high' | 'medium' | 'low';
  readonly extractionStrategy: 'manual-selection' | 'reader-mode' | 'visible-dom';
}): readonly PageContentChunk[] => {
  const paragraphs = input.text
    .split(/\n{2,}/u)
    .map((part) => part.replace(/\s+/gu, ' ').trim())
    .filter((part) => part.length > 0);
  const chunks: PageContentChunk[] = [];
  let cursor = 0;
  let buffer = '';
  let bufferStart = 0;
  const flush = (): void => {
    const text = buffer.trim();
    if (text.length === 0 || chunks.length >= MAX_CHUNKS_PER_PAGE) {
      buffer = '';
      return;
    }
    const charStart = bufferStart;
    const charEnd = charStart + text.length;
    chunks.push({
      id: `${sha256Hex(input.canonicalUrl).slice(0, 24)}:${String(chunks.length)}`,
      canonicalUrl: input.canonicalUrl,
      url: input.url,
      ...(input.title === undefined ? {} : { title: input.title }),
      contentHash: input.contentHash,
      chunkIndex: chunks.length,
      charStart,
      charEnd,
      text,
      extractedAt: input.extractedAt,
      quality: input.quality,
      extractionStrategy: input.extractionStrategy,
    });
    buffer = '';
  };

  for (const paragraph of paragraphs.length > 0 ? paragraphs : [input.text]) {
    const index = input.text.indexOf(paragraph, cursor);
    if (buffer.length === 0) {
      bufferStart = index >= 0 ? index : cursor;
    }
    if (buffer.length + paragraph.length > CHUNK_TARGET_CHARS && buffer.length > 0) {
      flush();
      bufferStart = index >= 0 ? index : cursor;
    }
    buffer = buffer.length === 0 ? paragraph : `${buffer}\n\n${paragraph}`;
    cursor = (index >= 0 ? index : cursor) + paragraph.length;
  }
  flush();
  return chunks;
};

const qualityWeightFor = (quality: 'high' | 'medium' | 'low'): number => {
  if (quality === 'high') return 1;
  if (quality === 'medium') return 0.75;
  return 0.25;
};

const enrichChunksWithEvidence = (
  chunks: readonly PageContentChunk[],
): readonly PageContentChunk[] =>
  chunks.map((chunk) => ({
    ...chunk,
    terms: extractPageEvidenceFeatures({
      canonicalUrl: chunk.canonicalUrl,
      url: chunk.url,
      ...(chunk.title === undefined ? {} : { title: chunk.title }),
      text: chunk.text,
    }).terms.slice(0, 24),
    qualityWeight: qualityWeightFor(chunk.quality),
  }));

// ─────────────────────────────────────────────────────────────────────
// SQL-backed record/raw/chunk access
// ─────────────────────────────────────────────────────────────────────

const parseRecordRow = (row: unknown): PageContentRecord =>
  JSON.parse((row as { record_json: string }).record_json) as PageContentRecord;

const readAllRecords = async (vaultRoot: string): Promise<readonly PageContentRecord[]> => {
  const db = await getPageContentDb(vaultRoot);
  const rows = db.query('SELECT record_json FROM records ORDER BY canonical_url').all();
  return rows.map(parseRecordRow);
};

const readRecordByCanonicalUrl = async (
  vaultRoot: string,
  canonicalUrl: string,
): Promise<PageContentRecord | null> => {
  const db = await getPageContentDb(vaultRoot);
  const row = db
    .query('SELECT record_json FROM records WHERE canonical_url = ?')
    .get(canonicalUrl);
  return row === null || row === undefined ? null : parseRecordRow(row);
};

export interface OverCollapsedRecord {
  readonly canonicalUrl: string;
  readonly chunkCount: number;
  readonly lastIndexedAt: string | null;
  readonly contentHash: string | null;
}

export const scanForOverCollapsedPageContent = async (
  vaultRoot: string,
): Promise<readonly OverCollapsedRecord[]> => {
  const db = await getPageContentDb(vaultRoot);
  const rows = db
    .query('SELECT record_json FROM records ORDER BY canonical_url LIMIT 100')
    .all();
  const records: OverCollapsedRecord[] = [];
  for (const row of rows) {
    const coverage = parseRecordRow(row).coverage;
    if (typeof coverage.chunkCount !== 'number') continue;
    if (coverage.chunkCount <= 25) continue;
    records.push({
      canonicalUrl: coverage.canonicalUrl,
      chunkCount: coverage.chunkCount,
      lastIndexedAt: coverage.lastIndexedAt ?? null,
      contentHash: coverage.contentHash ?? null,
    });
  }
  return records.sort((left, right) => right.chunkCount - left.chunkCount);
};

export const readPageContentCoverage = async (
  vaultRoot: string,
  rawCanonicalUrl: string,
): Promise<PageContentCoverage> => {
  const canonicalUrl = canonicalizePageUrlAndRecord(rawCanonicalUrl);
  const record = await readRecordByCanonicalUrl(vaultRoot, canonicalUrl);
  return (
    record?.coverage ?? {
      canonicalUrl,
      state: 'metadata_only_legacy',
      policyReason: 'not_indexed_yet',
    }
  );
};

export const readPageContentCoverageMap = async (
  vaultRoot: string,
  rawCanonicalUrls: readonly string[],
): Promise<ReadonlyMap<string, PageContentCoverage>> => {
  const out = new Map<string, PageContentCoverage>();
  for (const raw of rawCanonicalUrls) {
    const coverage = await readPageContentCoverage(vaultRoot, raw);
    out.set(coverage.canonicalUrl, coverage);
  }
  return out;
};

const writeRecordRow = (db: SqliteDatabase, record: PageContentRecord): void => {
  db.query(
    `INSERT INTO records (canonical_url, state, content_hash, updated_at, record_json)
     VALUES (?,?,?,?,?)
     ON CONFLICT(canonical_url) DO UPDATE SET
       state = excluded.state,
       content_hash = excluded.content_hash,
       updated_at = excluded.updated_at,
       record_json = excluded.record_json`,
  ).run(
    record.coverage.canonicalUrl,
    record.coverage.state,
    record.coverage.contentHash ?? null,
    record.updatedAt,
    JSON.stringify(record),
  );
};

export const writePageContentExtracted = async (
  vaultRoot: string,
  payload: PageContentExtractedPayload,
): Promise<PageContentCoverage> => {
  const canonicalUrl = canonicalizePageUrlAndRecord(payload.canonicalUrl);
  recordCanonicalCollision(payload.url, canonicalUrl);
  const contentHash = payload.content.contentHash || sha256Hex(payload.content.text);
  const quality = classifyPageContentQuality(payload.qualitySignals);
  const db = await getPageContentDb(vaultRoot);

  if (quality.state === 'metadata_only_error') {
    const coverage: PageContentCoverage = {
      canonicalUrl,
      state: 'metadata_only_error',
      qualitySignals: payload.qualitySignals,
      lastVisitedAt: payload.extractedAt,
      extractionSource: payload.extractionSource,
      ...(quality.error === undefined ? {} : { error: quality.error }),
    };
    writeRecordRow(db, {
      coverage,
      url: payload.url,
      ...(payload.title === undefined ? {} : { title: payload.title }),
      ...(payload.provider === undefined ? {} : { provider: payload.provider }),
      updatedAt: payload.extractedAt,
      sourceEventType: PAGE_CONTENT_EXTRACTED,
    } satisfies PageContentRecord);
    invalidatePageContentLexicalIndex(vaultRoot);
    return coverage;
  }

  const text = payload.content.text.slice(0, MAX_RAW_TEXT_CHARS);
  const chunks = enrichChunksWithEvidence(
    splitPageContentIntoChunks({
      canonicalUrl,
      url: payload.url,
      ...(payload.title === undefined ? {} : { title: payload.title }),
      contentHash,
      text,
      extractedAt: payload.extractedAt,
      quality: quality.quality ?? payload.quality,
      extractionStrategy: payload.extractionSource,
    }),
  );
  const coverage: PageContentCoverage = {
    canonicalUrl,
    state: quality.state,
    quality: quality.quality ?? payload.quality,
    qualitySignals: payload.qualitySignals,
    lastVisitedAt: payload.extractedAt,
    lastIndexedAt: payload.extractedAt,
    contentHash,
    extractionSource: payload.extractionSource,
    chunkCount: chunks.length,
    indexedCharCount: text.length,
  };
  // One transaction per capture: record + raw text + chunks land
  // together (all-or-nothing), replacing what used to be 3 separate
  // file writes plus a 157KB manifest rewrite.
  db.exec('BEGIN');
  try {
    writeRecordRow(db, {
      coverage,
      url: payload.url,
      ...(payload.title === undefined ? {} : { title: payload.title }),
      ...(payload.provider === undefined ? {} : { provider: payload.provider }),
      updatedAt: payload.extractedAt,
      sourceEventType: PAGE_CONTENT_EXTRACTED,
    } satisfies PageContentRecord);
    db.query(
      `INSERT INTO raw_content (content_hash, raw_json) VALUES (?,?)
       ON CONFLICT(content_hash) DO UPDATE SET raw_json = excluded.raw_json`,
    ).run(
      contentHash,
      JSON.stringify({
        version: 1,
        canonicalUrl,
        url: payload.url,
        ...(payload.title === undefined ? {} : { title: payload.title }),
        extractedAt: payload.extractedAt,
        text,
        ...(payload.content.markdown === undefined ? {} : { markdown: payload.content.markdown }),
      }),
    );
    db.query(
      `INSERT INTO chunks (content_hash, chunks_json) VALUES (?,?)
       ON CONFLICT(content_hash) DO UPDATE SET chunks_json = excluded.chunks_json`,
    ).run(contentHash, JSON.stringify({ version: 1, chunks }));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  invalidatePageContentLexicalIndex(vaultRoot);
  return coverage;
};

export const writePageContentTombstoned = async (
  vaultRoot: string,
  payload: PageContentTombstonedPayload,
): Promise<PageContentCoverage> => {
  const canonicalUrl = canonicalizePageUrlAndRecord(payload.canonicalUrl);
  const previous = await readPageContentCoverage(vaultRoot, canonicalUrl);
  const contentHash = payload.contentHash ?? previous.contentHash;
  const coverage: PageContentCoverage = {
    canonicalUrl,
    state: 'tombstoned',
    policyReason: payload.reason,
    ...(previous.lastVisitedAt === undefined ? {} : { lastVisitedAt: previous.lastVisitedAt }),
    ...(previous.lastIndexedAt === undefined ? {} : { lastIndexedAt: previous.lastIndexedAt }),
    ...(contentHash === undefined ? {} : { contentHash }),
  };
  const db = await getPageContentDb(vaultRoot);
  db.exec('BEGIN');
  try {
    writeRecordRow(db, {
      coverage,
      url: canonicalUrl,
      updatedAt: payload.tombstonedAt,
      sourceEventType: PAGE_CONTENT_TOMBSTONED,
    } satisfies PageContentRecord);
    if (contentHash !== undefined) {
      db.query('DELETE FROM raw_content WHERE content_hash = ?').run(contentHash);
      db.query('DELETE FROM chunks WHERE content_hash = ?').run(contentHash);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  invalidatePageContentLexicalIndex(vaultRoot);
  return coverage;
};

export const readPageContentExtractedPayloadForEvidence = async (
  vaultRoot: string,
  rawCanonicalUrl: string,
): Promise<PageContentExtractedPayload | null> => {
  const canonicalUrl = canonicalizePageUrlAndRecord(rawCanonicalUrl);
  const record = await readRecordByCanonicalUrl(vaultRoot, canonicalUrl);
  const coverage = record?.coverage;
  if (
    record === null ||
    coverage === undefined ||
    coverage.contentHash === undefined ||
    coverage.quality === undefined ||
    coverage.qualitySignals === undefined ||
    coverage.extractionSource === undefined ||
    (coverage.state !== 'indexed' &&
      coverage.state !== 'indexed_low_quality' &&
      coverage.state !== 'stale_index')
  ) {
    return null;
  }
  const db = await getPageContentDb(vaultRoot);
  const rawRow = db
    .query('SELECT raw_json FROM raw_content WHERE content_hash = ?')
    .get(coverage.contentHash) as { raw_json: string } | null | undefined;
  const raw =
    rawRow === null || rawRow === undefined
      ? null
      : (JSON.parse(rawRow.raw_json) as {
          readonly url?: unknown;
          readonly title?: unknown;
          readonly extractedAt?: unknown;
          readonly text?: unknown;
          readonly markdown?: unknown;
        });
  if (raw === null || typeof raw.text !== 'string' || raw.text.length === 0) return null;
  return {
    payloadVersion: 1,
    canonicalUrl,
    url: typeof raw.url === 'string' ? raw.url : record.url,
    ...(typeof raw.title === 'string'
      ? { title: raw.title }
      : record.title === undefined
        ? {}
        : { title: record.title }),
    ...(record.provider === undefined ? {} : { provider: record.provider }),
    extractedAt:
      typeof raw.extractedAt === 'string'
        ? raw.extractedAt
        : (coverage.lastIndexedAt ?? record.updatedAt),
    extractionSource: coverage.extractionSource,
    extractionPolicy: { trigger: 'manual' },
    quality: coverage.quality,
    qualitySignals: coverage.qualitySignals,
    content: {
      text: raw.text,
      ...(typeof raw.markdown === 'string' ? { markdown: raw.markdown } : {}),
      contentHash: coverage.contentHash,
      charCount: raw.text.length,
    },
  };
};

const readChunksRowByContentHash = async (
  vaultRoot: string,
  contentHash: string,
): Promise<readonly PageContentChunk[] | null> => {
  const db = await getPageContentDb(vaultRoot);
  const row = db.query('SELECT chunks_json FROM chunks WHERE content_hash = ?').get(contentHash) as
    | { chunks_json: string }
    | null
    | undefined;
  if (row === null || row === undefined) return null;
  const parsed = JSON.parse(row.chunks_json) as { readonly chunks?: readonly PageContentChunk[] };
  return parsed.chunks ?? [];
};

/** Direct by-contentHash chunk read, no coverage-state gating. Used by
 *  recall-v2's backfill (readers that already know a contentHash — from
 *  either the current page-content record or a page-evidence record's
 *  remembered contentHash — and want exactly the chunks stored under
 *  it, the same semantics the old direct `chunks/<hash>.json` file read
 *  had). Chunks are returned exactly as stored (already
 *  evidence-enriched at write time) — never null unless nothing was
 *  ever written under this hash. */
export const readPageContentChunksByContentHash = async (
  vaultRoot: string,
  contentHash: string,
): Promise<readonly PageContentChunk[] | null> => readChunksRowByContentHash(vaultRoot, contentHash);

/** Test-only: write an arbitrary raw chunks JSON blob (`{version, chunks}`
 *  shape) directly into the `chunks` table for one contentHash,
 *  bypassing extraction entirely. Lets recall-v2's backfill tests seed
 *  chunk fixtures with deterministic ids without running the real
 *  splitter/enrichment pipeline. Same `__`-prefixed test-hook
 *  convention as page-evidence's __writeRawPageEvidenceRowForTests. */
export const __writeRawPageContentChunksForTests = async (
  vaultRoot: string,
  contentHash: string,
  rawChunksJson: string,
): Promise<void> => {
  const db = await getPageContentDb(vaultRoot);
  db.query(
    `INSERT INTO chunks (content_hash, chunks_json) VALUES (?,?)
     ON CONFLICT(content_hash) DO UPDATE SET chunks_json = excluded.chunks_json`,
  ).run(contentHash, rawChunksJson);
};

export const readPageContentChunksForCanonicalUrls = async (
  vaultRoot: string,
  rawCanonicalUrls: readonly string[],
): Promise<ReadonlyMap<string, readonly PageContentChunk[]>> => {
  const out = new Map<string, readonly PageContentChunk[]>();
  const uniqueCanonicalUrls = [
    ...new Set(rawCanonicalUrls.map(canonicalizePageUrlAndRecord)),
  ].sort();
  for (const canonicalUrl of uniqueCanonicalUrls) {
    const record = await readRecordByCanonicalUrl(vaultRoot, canonicalUrl);
    const coverage = record?.coverage;
    if (
      coverage === undefined ||
      coverage.contentHash === undefined ||
      (coverage.state !== 'indexed' &&
        coverage.state !== 'indexed_low_quality' &&
        coverage.state !== 'stale_index')
    ) {
      continue;
    }
    const chunks = (await readChunksRowByContentHash(vaultRoot, coverage.contentHash)) ?? [];
    if (chunks.length > 0) out.set(canonicalUrl, enrichChunksWithEvidence(chunks));
  }
  return out;
};

// Snippet around the first analyzed term that appears in the text.
// Analyzer-aware so CJK queries find a relevant window (every
// bigram/unigram counts as a candidate anchor) and dotted-identifier
// parts hit the right spot.
const snippetFor = (text: string, query: string, maxChars = 220): string => {
  const lower = text.toLowerCase();
  const tokens = analyze(query);
  const pos =
    tokens
      .map((token) => lower.indexOf(token))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, pos - Math.floor(maxChars / 3));
  return text
    .slice(start, start + maxChars)
    .replace(/\s+/gu, ' ')
    .trim();
};

// In-memory MiniSearch over every indexed chunk. Built lazily per
// vaultRoot, cached by promise so concurrent callers share the same
// in-flight build, invalidated on every write/tombstone so the next
// query rebuilds against fresh content. `queryPageContent` triggers
// the (lazy) build on first call via `ensurePageContentLexicalIndex`.
// Companion startup no longer pre-warms this at boot (removed
// 2026-08-15: `queryPageContent` had zero production callers — see
// cli.ts for the verification note) but a caller may still call
// `ensurePageContentLexicalIndex` directly to warm ahead of the
// first query.

interface PageContentIndexEntry {
  readonly chunk: PageContentChunk;
  readonly coverage: PageContentCoverage;
  readonly recordTitle?: string;
}

export interface PageContentLexicalIndex {
  readonly mini: MiniSearch<{
    id: string;
    text: string;
    title: string;
    canonicalUrl: string;
  }>;
  readonly idToEntry: ReadonlyMap<string, PageContentIndexEntry>;
  // Stable signature: bumping ANALYZER_VERSION OR adding/removing
  // chunks changes this. Surfaced to /v1/system/health so an
  // operator can confirm the analyzer they're querying against.
  readonly revision: string;
}

let cached: { vaultRoot: string; promise: Promise<PageContentLexicalIndex> } | null = null;

const buildPageContentLexicalIndex = async (
  vaultRoot: string,
): Promise<PageContentLexicalIndex> => {
  const records = await readAllRecords(vaultRoot);
  const mini = new MiniSearch<{
    id: string;
    text: string;
    title: string;
    canonicalUrl: string;
  }>({
    fields: ['text', 'title'],
    storeFields: ['id', 'canonicalUrl'],
    idField: 'id',
    tokenize: analyze,
    processTerm: (term) => term.toLowerCase(),
    searchOptions: {
      tokenize: analyze,
      processTerm: (term) => term.toLowerCase(),
      boost: { text: 1, title: 2 },
      prefix: true,
      fuzzy: 0.15,
    },
  });
  const idToEntry = new Map<string, PageContentIndexEntry>();
  let indexedChunks = 0;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    const coverage = record.coverage;
    if (
      coverage.contentHash === undefined ||
      (coverage.state !== 'indexed' &&
        coverage.state !== 'indexed_low_quality' &&
        coverage.state !== 'stale_index')
    ) {
      continue;
    }
    const chunks = (await readChunksRowByContentHash(vaultRoot, coverage.contentHash)) ?? [];
    for (const chunk of chunks) {
      // Chunk ids are `<contentHash>:<ix>`, so two records with IDENTICAL
      // content (canonical-URL twins) collide. mini.add throws on a
      // duplicate id, and one throw used to kill the ENTIRE warm build —
      // no lexical index at all for the whole session. Identical content
      // is one searchable document: first record wins, siblings skip.
      if (idToEntry.has(chunk.id)) continue;
      idToEntry.set(chunk.id, {
        chunk,
        coverage,
        ...(record.title === undefined ? {} : { recordTitle: record.title }),
      });
      mini.add({
        id: chunk.id,
        text: chunk.text,
        title: chunk.title ?? record.title ?? '',
        canonicalUrl: coverage.canonicalUrl,
      });
      indexedChunks += 1;
    }
    // Yield to the event loop every ~50 indexed chunks so `/v1/status`
    // stays responsive while a large vault rebuilds at startup.
    if (indexedChunks > 0 && indexedChunks % 50 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return {
    mini,
    idToEntry,
    revision: `${String(ANALYZER_VERSION)}:${String(indexedChunks)}`,
  };
};

export const ensurePageContentLexicalIndex = (
  vaultRoot: string,
): Promise<PageContentLexicalIndex> => {
  if (cached !== null && cached.vaultRoot === vaultRoot) return cached.promise;
  cached = { vaultRoot, promise: buildPageContentLexicalIndex(vaultRoot) };
  return cached.promise;
};

export const invalidatePageContentLexicalIndex = (vaultRoot: string): void => {
  if (cached?.vaultRoot === vaultRoot) cached = null;
};

// Visible for tests.
export const __resetPageContentLexicalIndexCacheForTests = (): void => {
  cached = null;
};

export const queryPageContent = async (
  vaultRoot: string,
  q: string,
  options: { readonly limit?: number } = {},
): Promise<readonly ContentSearchHit[]> => {
  const trimmed = q.trim();
  if (trimmed.length === 0) return [];
  const index = await ensurePageContentLexicalIndex(vaultRoot);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  // MiniSearch returns results sorted by its internal score. We keep
  // those raw scores for downstream RRF (rank-based, score-scale
  // irrelevant) and emit hits in MiniSearch's order — never re-sort
  // by raw score across sources.
  const results = index.mini.search(trimmed);
  const out: ContentSearchHit[] = [];
  for (let i = 0; i < results.length && out.length < limit; i += 1) {
    const result = results[i]!;
    const entry = index.idToEntry.get(result.id as string);
    if (entry === undefined) continue;
    const { chunk, coverage, recordTitle } = entry;
    out.push({
      id: chunk.id,
      sourceKind: 'page-content',
      anchorNodeId: `timeline-visit:${coverage.canonicalUrl}`,
      canonicalUrl: coverage.canonicalUrl,
      title: chunk.title ?? recordTitle ?? coverage.canonicalUrl,
      snippet: snippetFor(chunk.text, trimmed),
      score: result.score,
      capturedAt: chunk.extractedAt,
      coverageState: coverage.state,
      ...(coverage.quality === undefined ? {} : { quality: coverage.quality }),
    });
  }
  return out;
};

/** Total on-disk bytes the store occupies: the db file plus its
 *  WAL/SHM sidecars (WAL-mode writes land in `-wal` between
 *  checkpoints). Replaces the old recursive directory walk. */
const pageContentDbBytes = async (vaultRoot: string): Promise<number> => {
  const base = pageContentDbPath(vaultRoot);
  const sizes = await Promise.all(
    [base, `${base}-wal`, `${base}-shm`].map(async (path) => {
      const info = await stat(path).catch(() => null);
      return info?.size ?? 0;
    }),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
};

export const pageContentStorageStats = async (
  vaultRoot: string,
): Promise<{ readonly bytes: number; readonly records: number; readonly indexed: number }> => {
  const db = await getPageContentDb(vaultRoot);
  const total = (db.query('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n;
  const indexed = (
    db.query("SELECT COUNT(*) AS n FROM records WHERE state = 'indexed'").get() as { n: number }
  ).n;
  return {
    bytes: await pageContentDbBytes(vaultRoot),
    records: total,
    indexed,
  };
};

export interface PageContentCoverageCounts {
  readonly producedAt: string; // ISO
  readonly byState: Record<string /*PageContentCoverageState*/, number>;
  readonly total: number;
  readonly indexed: number; // indexed + indexed_low_quality
  readonly bytes: number; // reuse pageContentStorageStats bytes if cheap
}

export const pageContentCoverageCounts = async (
  vaultRoot: string,
): Promise<PageContentCoverageCounts> => {
  // Explicit zero for every known state: absent states read as 0, not missing.
  const byState: Record<PageContentCoverageState, number> = Object.fromEntries(
    PAGE_CONTENT_COVERAGE_STATES.map((state) => [state, 0]),
  ) as Record<PageContentCoverageState, number>;
  const db = await getPageContentDb(vaultRoot);
  const rows = db.query('SELECT state, COUNT(*) AS n FROM records GROUP BY state').all() as {
    state: string;
    n: number;
  }[];
  let total = 0;
  for (const row of rows) {
    if ((PAGE_CONTENT_COVERAGE_STATES as readonly string[]).includes(row.state)) {
      byState[row.state as PageContentCoverageState] = row.n;
    }
    total += row.n;
  }
  const bytes = await pageContentDbBytes(vaultRoot);
  return {
    producedAt: new Date().toISOString(),
    byState,
    total,
    indexed: byState.indexed + byState.indexed_low_quality,
    bytes,
  };
};
