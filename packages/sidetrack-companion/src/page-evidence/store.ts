import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { mapInChunks } from '../domain/asyncChunks.js';
import { createRevision } from '../domain/ids.js';
import { classifyPageContentQuality } from '../page-content/quality.js';
import { readPageContentExtractedPayloadForEvidence } from '../page-content/store.js';
import type { TimelineEntry } from '../timeline/projection.js';
import { sanitizeTimelineUrl } from '../timeline/sanitize.js';
import {
  isCurrentPageEvidenceVectorRef,
  readPageEvidenceDocVector,
  writePageEvidenceDocEmbedding,
  type PageEvidenceEmbedder,
} from './embedding.js';
import {
  buildExtractedPageEvidence,
  buildMetadataOnlyEvidence,
  evidenceCorpusForRecord,
} from './extract.js';
import {
  PAGE_EVIDENCE_EXTRACTION_CODE_VERSION,
  PAGE_EVIDENCE_FEATURE_SCHEMA_VERSION,
  PAGE_EVIDENCE_SCHEMA_VERSION,
  PAGE_EVIDENCE_TOKENIZER_VERSION,
  type PageEvidenceExtractedRequest,
  type PageEvidenceMetadataInput,
  type PageEvidenceRecord,
  type PageEvidenceTier,
  type ReadPageEvidenceResult,
  type VectorRef,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────
// F5 — single SQLite store (2026-08-16)
//
// Replaces the by-url/*.json + manifest.json small-file layout (~3,741
// files on the test vault — see docs/plans/2026-08-15-foundation-
// program.md F5 design note). One `records` table, keyed by canonical
// URL, carrying the full PageEvidenceRecord as JSON plus a `seq`
// column: a strictly-increasing per-write counter (backed by
// `seq_ticker`, an AUTOINCREMENT ticker table — the standard bun:sqlite
// monotonic-counter idiom) that stands in for the old by-url file's
// mtime as a cheap "did this record change" fingerprint. `file_name`
// preserves the OLD by-url file name identity
// (`${pageEvidenceHash(canonicalUrl)}.json`) so external delta-diffing
// consumers (recall-v2's backfill, this module's own background-
// embedding discovery) keep working against the SAME (name, changed?)
// shape they always have — `listPageEvidenceRecordFiles` now returns
// `{name: file_name, mtimeMs: seq, size: 0}`; `size` is a constant
// because it was always opaque to callers (concatenated into a
// fingerprint string, never compared to a real byte length — verified
// against every consumer before this migration).
//
// The manifest.json this module used to maintain (recordCount, byTier,
// avgTopTermCount) had zero runtime readers (unlike page-content's,
// which IS part of the served read model) — the #356/#357 incremental-
// manifest-upsert machinery (applyPageEvidenceManifestUpsert,
// rebuildManifest) is deleted outright, no SQL-aggregate replacement
// needed. `ensurePageEvidenceForTimelineEntries` keeps a
// `rebuildManifestAfterWrite` option in its TYPE ONLY because
// sync/contract/connectionsMaterializer.ts (off-limits for this PR)
// still passes it as an object literal; it is inert.
//
// The `embed-lane-discovery.json` / `embed-lane-progress.json`
// artifacts and the `body-evidence-queue/` directory are NOT part of
// this migration — they are already O(delta) or bounded-queue files,
// not a per-capture O(records) small-file store, so they stay on disk
// as-is.
//
// ONE-TIME PORT (binding, no back-compat layer): same discipline as
// page-content/store.ts — import legacy by-url/*.json into a temp db,
// verify the row count, atomically rename over the final path. See
// that module's header comment for the full crash-safety argument
// (mirrored here verbatim).

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
  CREATE TABLE IF NOT EXISTS seq_ticker (
    id INTEGER PRIMARY KEY AUTOINCREMENT
  );
  CREATE TABLE IF NOT EXISTS records (
    canonical_url TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    evidence_tier TEXT NOT NULL,
    seq INTEGER NOT NULL,
    record_json TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS records_file_name ON records(file_name);
  CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
`;

export const pageEvidenceRoot = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'page-evidence');
export const pageEvidenceDbPath = (vaultRoot: string): string =>
  join(pageEvidenceRoot(vaultRoot), 'page-evidence.db');

// Legacy file-layout path — port source ONLY.
const legacyByUrlDir = (vaultRoot: string): string => join(pageEvidenceRoot(vaultRoot), 'by-url');

export const pageEvidenceHash = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

const readJsonLegacy = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTier = (value: unknown): value is PageEvidenceTier =>
  value === 'metadata_only' || value === 'content_features_only' || value === 'indexed_chunks';

const safePageEvidenceRecord = (value: unknown): PageEvidenceRecord | null => {
  if (!isRecord(value)) return null;
  if (
    value['schemaVersion'] !== PAGE_EVIDENCE_SCHEMA_VERSION ||
    typeof value['canonicalUrl'] !== 'string' ||
    typeof value['evidenceRevision'] !== 'string' ||
    typeof value['updatedAt'] !== 'string' ||
    !isTier(value['evidenceTier']) ||
    !isRecord(value['versions']) ||
    !isRecord(value['metadata'])
  ) {
    return null;
  }
  const record = value as unknown as PageEvidenceRecord;
  if (
    typeof value['semanticFeatureRevision'] === 'string' &&
    typeof value['behaviorMetadataRevision'] === 'string'
  ) {
    return record;
  }
  return {
    ...record,
    semanticFeatureRevision: record.evidenceRevision,
    behaviorMetadataRevision: record.evidenceRevision,
  };
};

const rmQuiet = async (path: string): Promise<void> => {
  await rm(path, { force: true });
};

const nextSeq = (db: SqliteDatabase): number => {
  const result = db.query('INSERT INTO seq_ticker DEFAULT VALUES').run();
  return Number(result.lastInsertRowid);
};

/** Imports the legacy by-url/*.json layout into a fresh temp db,
 *  verifies the row count, then atomically publishes it over
 *  `finalPath`. Mirrors page-content/store.ts's port — see that
 *  module's header for the full crash-safety argument. Never called
 *  when `finalPath` already exists. */
const portLegacyPageEvidence = async (
  vaultRoot: string,
  finalPath: string,
  legacyNames: readonly string[],
  Database: SqliteModule['Database'],
): Promise<void> => {
  const tmpPath = `${finalPath}.porting.tmp`;
  await rmQuiet(tmpPath);
  await rmQuiet(`${tmpPath}-wal`);
  await rmQuiet(`${tmpPath}-shm`);

  const db = new Database(tmpPath, { create: true, readwrite: true });
  let recordCount = 0;
  try {
    db.exec(SCHEMA);
    const insertRecord = db.query(
      'INSERT OR REPLACE INTO records (canonical_url, file_name, evidence_tier, seq, record_json) VALUES (?,?,?,?,?)',
    );
    db.exec('BEGIN');
    try {
      for (const name of legacyNames) {
        const record = safePageEvidenceRecord(
          await readJsonLegacy(join(legacyByUrlDir(vaultRoot), name)),
        );
        if (record === null) continue;
        const fileName = `${pageEvidenceHash(record.canonicalUrl)}.json`;
        const seq = nextSeq(db);
        insertRecord.run(record.canonicalUrl, fileName, record.evidenceTier, seq, JSON.stringify(record));
        recordCount += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const verifiedRecords = (db.query('SELECT COUNT(*) AS n FROM records').get() as { n: number })
      .n;
    if (verifiedRecords !== recordCount) {
      throw new Error(
        `page-evidence port count mismatch: records ${String(verifiedRecords)}/${String(recordCount)}`,
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

  await rename(tmpPath, finalPath);
  await rmQuiet(`${tmpPath}-wal`);
  await rmQuiet(`${tmpPath}-shm`);
  console.warn(
    `[page-evidence] ported legacy file layout to SQLite: ${String(recordCount)} records. ` +
      `Old layout preserved at ${legacyByUrlDir(vaultRoot)} — safe to delete.`,
  );
};

const ensurePageEvidenceDbFile = async (vaultRoot: string): Promise<void> => {
  const finalPath = pageEvidenceDbPath(vaultRoot);
  if (existsSync(finalPath)) return;
  await mkdir(pageEvidenceRoot(vaultRoot), { recursive: true });
  const legacyNames = (
    await readdir(legacyByUrlDir(vaultRoot)).catch(() => [] as string[])
  ).filter((name) => name.endsWith('.json'));
  const { Database } = await loadSqlite();
  if (legacyNames.length === 0) {
    const db = new Database(finalPath, { create: true, readwrite: true });
    db.exec(SCHEMA);
    db.close?.();
    return;
  }
  await portLegacyPageEvidence(vaultRoot, finalPath, legacyNames, Database);
};

const dbCache = new Map<string, Promise<SqliteDatabase>>();

const getPageEvidenceDb = (vaultRoot: string): Promise<SqliteDatabase> => {
  const cached = dbCache.get(vaultRoot);
  if (cached !== undefined) return cached;
  const promise = (async (): Promise<SqliteDatabase> => {
    await ensurePageEvidenceDbFile(vaultRoot);
    const { Database } = await loadSqlite();
    const db = new Database(pageEvidenceDbPath(vaultRoot), { create: true, readwrite: true });
    db.exec(SCHEMA);
    return db;
  })();
  dbCache.set(vaultRoot, promise);
  promise.catch(() => {
    if (dbCache.get(vaultRoot) === promise) dbCache.delete(vaultRoot);
  });
  return promise;
};

/** Boot hook — see page-content/store.ts's twin for rationale. */
export const ensurePageEvidenceStoreReady = async (vaultRoot: string): Promise<void> => {
  await getPageEvidenceDb(vaultRoot);
};

/** Test-only: drop the in-process db-handle cache. */
export const __resetPageEvidenceDbCacheForTests = (vaultRoot?: string): void => {
  if (vaultRoot === undefined) {
    dbCache.clear();
    return;
  }
  dbCache.delete(vaultRoot);
};

// ─────────────────────────────────────────────────────────────────────
// Small standalone JSON artifacts (NOT part of the F5 migration — see
// module header). Unchanged fs-based atomic read/write.
// ─────────────────────────────────────────────────────────────────────

const atomicWriteJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${createRevision()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
};

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const canonicalizeEvidenceUrl = (raw: string): string => {
  // Align with the URL projection's canonicalization
  // (sanitizeTimelineUrl: strips the fragment + sensitive/marketing
  // params but PRESERVES content-distinguishing params like Hacker
  // News `?id=` or `?p=`). A blanket `search=''` collapsed every
  // news.ycombinator.com/item?id=* into ONE evidence record (item X's
  // text served for item Y) and disagreed with the URL projection key.
  const sanitized = sanitizeTimelineUrl(raw);
  const trimmed = sanitized.replace(/\/$/u, '');
  return trimmed.length > 0 ? trimmed : sanitized;
};

const staleReasonFor = (record: PageEvidenceRecord): 'version' | 'vector' | null => {
  if (
    record.versions.extractionCodeVersion !== PAGE_EVIDENCE_EXTRACTION_CODE_VERSION ||
    record.versions.tokenizerVersion !== PAGE_EVIDENCE_TOKENIZER_VERSION ||
    record.versions.featureSchemaVersion !== PAGE_EVIDENCE_FEATURE_SCHEMA_VERSION
  ) {
    return 'version';
  }
  if (
    record.content?.docEmbeddingRef !== undefined &&
    !isCurrentPageEvidenceVectorRef(record.content.docEmbeddingRef)
  ) {
    return 'vector';
  }
  return null;
};

const readRawPageEvidence = async (
  vaultRoot: string,
  canonicalUrl: string,
): Promise<PageEvidenceRecord | null> => {
  const db = await getPageEvidenceDb(vaultRoot);
  const row = db
    .query('SELECT record_json FROM records WHERE canonical_url = ?')
    .get(canonicalUrl) as { record_json: string } | null | undefined;
  return row === null || row === undefined
    ? null
    : safePageEvidenceRecord(JSON.parse(row.record_json));
};

export const readPageEvidence = async (
  vaultRoot: string,
  rawCanonicalUrl: string,
): Promise<ReadPageEvidenceResult> => {
  const canonicalUrl = canonicalizeEvidenceUrl(rawCanonicalUrl);
  const record = await readRawPageEvidence(vaultRoot, canonicalUrl);
  if (record === null) return { record: null, stale: false };
  const staleReason = staleReasonFor(record);
  if (staleReason === null) return { record, stale: false };
  return { record, stale: true, staleReason };
};

export const readPageEvidenceMap = async (
  vaultRoot: string,
  rawCanonicalUrls: readonly string[],
): Promise<ReadonlyMap<string, PageEvidenceRecord>> => {
  const out = new Map<string, PageEvidenceRecord>();
  for (const raw of rawCanonicalUrls) {
    const result = await readPageEvidence(vaultRoot, raw);
    if (result.record !== null) out.set(result.record.canonicalUrl, result.record);
  }
  return out;
};

/** File-level listing for incremental consumers (recall-v2 backfill
 *  delta, the background-embedding discovery below): SQL-backed now,
 *  but the SAME `{name, mtimeMs, size}` fingerprint shape the fs
 *  readdir+stat pass used to return. `mtimeMs` is each record's `seq`
 *  (bumped on every write); `size` is a constant `0` — every consumer
 *  treats both fields as opaque change-detection inputs, never a real
 *  timestamp/byte-length (verified against every caller before this
 *  migration), so this is a drop-in, and a strict improvement: no
 *  filesystem clock-tick aliasing, exact per-write granularity. */
export interface PageEvidenceRecordFileStat {
  readonly name: string;
  readonly mtimeMs: number;
  readonly size: number;
}

export const listPageEvidenceRecordFiles = async (
  vaultRoot: string,
): Promise<readonly PageEvidenceRecordFileStat[]> => {
  const db = await getPageEvidenceDb(vaultRoot);
  const rows = db.query('SELECT file_name, seq FROM records').all() as {
    file_name: string;
    seq: number;
  }[];
  return rows
    .map((row) => ({ name: row.file_name, mtimeMs: row.seq, size: 0 }))
    .sort((left, right) => compareText(left.name, right.name));
};

/** Read + validate one record by its file-name identity (same as the
 *  legacy by-url/ file name: `${pageEvidenceHash(canonicalUrl)}.json`).
 *  Null when absent or fails the schema check. */
export const readPageEvidenceRecordByFileName = async (
  vaultRoot: string,
  name: string,
): Promise<PageEvidenceRecord | null> => {
  const db = await getPageEvidenceDb(vaultRoot);
  const row = db.query('SELECT record_json FROM records WHERE file_name = ?').get(name) as
    | { record_json: string }
    | null
    | undefined;
  return row === null || row === undefined
    ? null
    : safePageEvidenceRecord(JSON.parse(row.record_json));
};

export const listPageEvidenceRecords = async (
  vaultRoot: string,
): Promise<readonly PageEvidenceRecord[]> => {
  const db = await getPageEvidenceDb(vaultRoot);
  const rows = db.query('SELECT record_json FROM records ORDER BY canonical_url').all() as {
    record_json: string;
  }[];
  const records: PageEvidenceRecord[] = [];
  for (const row of rows) {
    const record = safePageEvidenceRecord(JSON.parse(row.record_json));
    if (record !== null) records.push(record);
  }
  return records;
};

const writeRecord = async (vaultRoot: string, record: PageEvidenceRecord): Promise<void> => {
  const db = await getPageEvidenceDb(vaultRoot);
  const fileName = `${pageEvidenceHash(record.canonicalUrl)}.json`;
  const seq = nextSeq(db);
  db.query(
    `INSERT INTO records (canonical_url, file_name, evidence_tier, seq, record_json)
     VALUES (?,?,?,?,?)
     ON CONFLICT(canonical_url) DO UPDATE SET
       file_name = excluded.file_name,
       evidence_tier = excluded.evidence_tier,
       seq = excluded.seq,
       record_json = excluded.record_json`,
  ).run(record.canonicalUrl, fileName, record.evidenceTier, seq, JSON.stringify(record));
};

/** Test-only: write an arbitrary raw JSON string into one record's row,
 *  bypassing every build/validate step (`buildExtractedPageEvidence`,
 *  `buildMetadataOnlyEvidence`, `safePageEvidenceRecord`). Bumps `seq`
 *  like any real write, so delta-discovery consumers (recall-v2's
 *  backfill) see it as changed. Exists so tests can exercise the SQLite
 *  read path (listPageEvidenceRecordFiles / readPageEvidenceRecordByFileName
 *  / listPageEvidenceRecords) against minimal or deliberately-corrupt
 *  fixtures — e.g. a schema-invalid row — without running the full
 *  extraction pipeline. Same `__`-prefixed test-hook convention as
 *  __deletePageEvidenceRecordForTests. */
export const __writeRawPageEvidenceRowForTests = async (
  vaultRoot: string,
  canonicalUrl: string,
  rawJson: string,
): Promise<void> => {
  const db = await getPageEvidenceDb(vaultRoot);
  const fileName = `${pageEvidenceHash(canonicalUrl)}.json`;
  const seq = nextSeq(db);
  db.query(
    `INSERT INTO records (canonical_url, file_name, evidence_tier, seq, record_json)
     VALUES (?,?,?,?,?)
     ON CONFLICT(canonical_url) DO UPDATE SET
       file_name = excluded.file_name,
       evidence_tier = excluded.evidence_tier,
       seq = excluded.seq,
       record_json = excluded.record_json`,
    // evidence_tier is write-only today (no query filters on it) — a
    // placeholder is fine for a raw/possibly-corrupt fixture.
  ).run(canonicalUrl, fileName, 'metadata_only', seq, rawJson);
};

/** Test-only: delete one record outright. No production caller deletes
 *  individual page-evidence rows today (tombstoning happens via
 *  page-content's writePageContentTombstoned + a query-time tombstone
 *  filter) — this exists purely so recall-v2's backfill-delta test can
 *  exercise its "a record's source disappeared" sweep path without
 *  reaching into SQLite internals, matching the existing `__`-prefixed
 *  test-hook convention (see __resetPageContentLexicalIndexCacheForTests). */
export const __deletePageEvidenceRecordForTests = async (
  vaultRoot: string,
  canonicalUrl: string,
): Promise<void> => {
  const db = await getPageEvidenceDb(vaultRoot);
  db.query('DELETE FROM records WHERE canonical_url = ?').run(
    canonicalizeEvidenceUrl(canonicalUrl),
  );
};

const shouldWriteRecord = (
  previous: PageEvidenceRecord | null,
  record: PageEvidenceRecord,
): boolean =>
  previous?.evidenceRevision !== record.evidenceRevision ||
  previous?.behaviorMetadataRevision !== record.behaviorMetadataRevision ||
  previous?.content?.embeddingState !== record.content?.embeddingState;

const writeRecordIfChanged = async (
  vaultRoot: string,
  previous: PageEvidenceRecord | null,
  record: PageEvidenceRecord,
): Promise<boolean> => {
  if (!shouldWriteRecord(previous, record)) return false;
  await writeRecord(vaultRoot, record);
  return true;
};

export const writeMetadataOnlyPageEvidence = async (
  vaultRoot: string,
  input: PageEvidenceMetadataInput,
): Promise<PageEvidenceRecord> => {
  const canonicalUrl = canonicalizeEvidenceUrl(input.canonicalUrl);
  const previous = await readRawPageEvidence(vaultRoot, canonicalUrl);
  const record = buildMetadataOnlyEvidence({ ...input, canonicalUrl }, previous ?? undefined);
  if (
    previous?.evidenceRevision !== record.evidenceRevision ||
    previous?.behaviorMetadataRevision !== record.behaviorMetadataRevision
  ) {
    await writeRecord(vaultRoot, record);
  }
  return record;
};

type TimelineEvidenceEntry = TimelineEntry & { readonly dimensions?: unknown };

const focusedWindowMsForTimelineEntry = (entry: TimelineEvidenceEntry): number | undefined => {
  const dimensions = entry.dimensions;
  if (!isRecord(dimensions)) return undefined;
  const engagement = dimensions['engagement'];
  if (!isRecord(engagement)) return undefined;
  const focused = engagement['focusedWindowMs'];
  return typeof focused === 'number' && Number.isFinite(focused) && focused >= 0
    ? focused
    : undefined;
};

export const ensurePageEvidenceForTimelineEntries = async (
  vaultRoot: string,
  entries: readonly TimelineEvidenceEntry[],
  // `rebuildManifestAfterWrite` is accepted ONLY for call-site
  // compatibility with sync/contract/connectionsMaterializer.ts
  // (off-limits for this PR), which still passes `{
  // rebuildManifestAfterWrite: false }` as an object literal. Rows are
  // the manifest now — this flag is inert. See module header.
  options: { readonly rebuildManifestAfterWrite?: boolean } = {},
): Promise<ReadonlyMap<string, PageEvidenceRecord>> => {
  void options;
  const byCanonical = new Map<string, PageEvidenceMetadataInput>();
  for (const entry of entries) {
    const canonicalUrl = canonicalizeEvidenceUrl(entry.canonicalUrl ?? entry.url);
    const existing = byCanonical.get(canonicalUrl);
    const focusedWindowMs = focusedWindowMsForTimelineEntry(entry);
    const next: PageEvidenceMetadataInput = {
      canonicalUrl,
      url: entry.url,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.provider === undefined ? {} : { provider: entry.provider }),
      firstSeenAt:
        existing?.firstSeenAt === undefined || entry.firstSeenAt < existing.firstSeenAt
          ? entry.firstSeenAt
          : existing.firstSeenAt,
      lastSeenAt:
        existing?.lastSeenAt === undefined || entry.lastSeenAt > existing.lastSeenAt
          ? entry.lastSeenAt
          : existing.lastSeenAt,
      visitCount: Math.max(existing?.visitCount ?? 0, entry.visitCount ?? 0),
      focusedWindowMs: Math.max(existing?.focusedWindowMs ?? 0, focusedWindowMs ?? 0),
    };
    byCanonical.set(canonicalUrl, next);
  }
  const out = new Map<string, PageEvidenceRecord>();
  // PROGRESS IS PART OF THE CONTRACT for a big ensure. The 2026-07-29 vault
  // freeze: the widened full-rebuild fallback handed this loop ~2.7k entries
  // (it used to see the event window, single digits), each one paying an
  // unconditional metadata write + an indexed-payload read — ~100% CPU inside
  // sqlite for over ten minutes with ZERO output. The reconcile child's
  // no-progress watchdog SIGKILLed it every time (seq=1..11+, 18 hours, not
  // one successful drain), and it died HERE, before the similarity embed's
  // own progress lines could ever start.
  //
  // A plain console line every ENSURE_PROGRESS_EVERY records keeps the phase
  // observably alive: child stdout provably reaches the parent and provably
  // bumps the watchdog. Threshold-gated so an ordinary window-sized ensure
  // (single digits) stays silent. The per-record writes are already durable,
  // so a killed run resumes at full speed — this line is what stops it being
  // killed at all.
  const ENSURE_PROGRESS_EVERY = 200;
  const ensureTotal = byCanonical.size;
  let ensured = 0;
  for (const input of [...byCanonical.values()].sort((left, right) =>
    compareText(left.canonicalUrl, right.canonicalUrl),
  )) {
    ensured += 1;
    if (ensureTotal > ENSURE_PROGRESS_EVERY && ensured % ENSURE_PROGRESS_EVERY === 0) {
      console.log(`[page-evidence] ensure ${String(ensured)}/${String(ensureTotal)}`);
    }
    let record = await writeMetadataOnlyPageEvidence(vaultRoot, input);
    const indexedPayload = await readPageContentExtractedPayloadForEvidence(
      vaultRoot,
      input.canonicalUrl,
    );
    if (
      indexedPayload !== null &&
      (staleReasonFor(record) !== null ||
        record.evidenceTier !== 'indexed_chunks' ||
        record.content?.contentHash !== indexedPayload.content.contentHash)
    ) {
      record = await writeExtractedPageEvidenceFast(vaultRoot, {
        ...indexedPayload,
        storageMode: 'indexed_chunks',
      });
    }
    out.set(record.canonicalUrl, record);
  }
  return out;
};

export const writeExtractedPageEvidence = async (
  vaultRoot: string,
  payload: PageEvidenceExtractedRequest,
  options: {
    readonly embedder?: PageEvidenceEmbedder;
    readonly embeddingsEnabled?: boolean;
  } = {},
): Promise<PageEvidenceRecord> => {
  const fastState = await writeExtractedPageEvidenceFastState(vaultRoot, payload, {
    ...(options.embeddingsEnabled === undefined
      ? {}
      : { embeddingsEnabled: options.embeddingsEnabled }),
  });
  const fast = fastState.record;
  if (
    fast.evidenceTier === 'metadata_only' ||
    options.embeddingsEnabled === false ||
    fast.content?.embeddingState === 'ready'
  ) {
    return fast;
  }
  return await completeExtractedPageEvidenceEmbedding(vaultRoot, payload, options);
};

interface FastExtractedPageEvidenceWriteResult {
  readonly record: PageEvidenceRecord;
  readonly wrote: boolean;
}

const writeExtractedPageEvidenceFastState = async (
  vaultRoot: string,
  payload: PageEvidenceExtractedRequest,
  options: {
    readonly embeddingsEnabled?: boolean;
  } = {},
): Promise<FastExtractedPageEvidenceWriteResult> => {
  const canonicalUrl = canonicalizeEvidenceUrl(payload.canonicalUrl);
  const previous = await readRawPageEvidence(vaultRoot, canonicalUrl);
  const quality = classifyPageContentQuality(payload.qualitySignals);
  if (quality.state === 'metadata_only_error') {
    const record = buildMetadataOnlyEvidence(
      {
        canonicalUrl,
        url: payload.url,
        ...(payload.title === undefined ? {} : { title: payload.title }),
        ...(payload.provider === undefined ? {} : { provider: payload.provider }),
        lastSeenAt: payload.extractedAt,
      },
      previous ?? undefined,
    );
    const wrote = await writeRecordIfChanged(vaultRoot, previous, record);
    return { record, wrote };
  }
  const normalizedPayload = {
    ...payload,
    canonicalUrl,
    quality: quality.quality ?? payload.quality,
  };
  const previousDocEmbeddingRef = previous?.content?.docEmbeddingRef;
  const canCarryCurrentEmbedding =
    options.embeddingsEnabled !== false &&
    previous?.content?.contentHash === normalizedPayload.content.contentHash &&
    previousDocEmbeddingRef !== undefined &&
    isCurrentPageEvidenceVectorRef(previousDocEmbeddingRef);
  const record = buildExtractedPageEvidence(
    normalizedPayload,
    previous ?? undefined,
    options.embeddingsEnabled === false
      ? { embeddingState: 'disabled' }
      : canCarryCurrentEmbedding
        ? { docEmbeddingRef: previousDocEmbeddingRef, embeddingState: 'ready' }
        : { embeddingState: 'missing' },
  );
  const wrote = await writeRecordIfChanged(vaultRoot, previous, record);
  return { record, wrote };
};

export const writeExtractedPageEvidenceFast = async (
  vaultRoot: string,
  payload: PageEvidenceExtractedRequest,
  options: {
    readonly embeddingsEnabled?: boolean;
  } = {},
): Promise<PageEvidenceRecord> =>
  (await writeExtractedPageEvidenceFastState(vaultRoot, payload, options)).record;

const isCurrentEvidenceForEmbeddingCompletion = (
  record: PageEvidenceRecord | null,
  payload: PageEvidenceExtractedRequest,
): boolean => {
  if (record === null) return true;
  if (
    record.content?.contentHash !== undefined &&
    record.content.contentHash !== payload.content.contentHash
  ) {
    return false;
  }
  return record.updatedAt <= payload.extractedAt;
};

export const completeExtractedPageEvidenceEmbedding = async (
  vaultRoot: string,
  payload: PageEvidenceExtractedRequest,
  options: {
    readonly embedder?: PageEvidenceEmbedder;
    readonly embeddingsEnabled?: boolean;
  } = {},
): Promise<PageEvidenceRecord> => {
  if (options.embeddingsEnabled === false) {
    return await writeExtractedPageEvidenceFast(vaultRoot, payload, options);
  }
  const canonicalUrl = canonicalizeEvidenceUrl(payload.canonicalUrl);
  const initial = await readRawPageEvidence(vaultRoot, canonicalUrl);
  const quality = classifyPageContentQuality(payload.qualitySignals);
  if (quality.state === 'metadata_only_error') {
    return await writeExtractedPageEvidenceFast(vaultRoot, payload, options);
  }
  const normalizedPayload = {
    ...payload,
    canonicalUrl,
    quality: quality.quality ?? payload.quality,
  };
  if (initial !== null && !isCurrentEvidenceForEmbeddingCompletion(initial, normalizedPayload)) {
    return initial;
  }
  const initialDocEmbeddingRef = initial?.content?.docEmbeddingRef;
  if (
    initial !== null &&
    initial?.content?.contentHash === normalizedPayload.content.contentHash &&
    initialDocEmbeddingRef !== undefined &&
    isCurrentPageEvidenceVectorRef(initialDocEmbeddingRef)
  ) {
    const record = buildExtractedPageEvidence(normalizedPayload, initial, {
      docEmbeddingRef: initialDocEmbeddingRef,
      embeddingState: 'ready',
    });
    await writeRecordIfChanged(vaultRoot, initial, record);
    return record;
  }
  let docEmbeddingRef: VectorRef | undefined;
  let embeddingState: 'missing' | 'failed' | 'ready' = 'missing';
  try {
    docEmbeddingRef = await writePageEvidenceDocEmbedding(
      vaultRoot,
      normalizedPayload,
      options.embedder,
    );
    embeddingState = docEmbeddingRef === undefined ? 'missing' : 'ready';
  } catch {
    docEmbeddingRef = undefined;
    embeddingState = 'failed';
  }
  const latest = await readRawPageEvidence(vaultRoot, canonicalUrl);
  if (latest !== null && !isCurrentEvidenceForEmbeddingCompletion(latest, normalizedPayload)) {
    return latest;
  }
  const record = buildExtractedPageEvidence(
    normalizedPayload,
    latest ?? undefined,
    docEmbeddingRef === undefined ? { embeddingState } : { docEmbeddingRef, embeddingState },
  );
  await writeRecordIfChanged(vaultRoot, latest, record);
  return record;
};

export interface PageEvidenceStats {
  readonly bytes: number;
  readonly records: number;
  readonly metadataOnlyCount: number;
  readonly featuresOnlyCount: number;
  readonly indexedChunkCount: number;
  readonly contentVectorReadyCount: number;
  readonly contentVectorMissingCount: number;
  readonly contentVectorDisabledCount: number;
  readonly contentVectorFailedCount: number;
  readonly avgTopTermCount: number;
  readonly featureOnlyPages: number;
  readonly pageEvidenceRawTextPersistedBytes: 0;
}

/** Total on-disk bytes the store occupies: the db file plus its
 *  WAL/SHM sidecars. Replaces the old recursive directory walk. */
const pageEvidenceDbBytes = async (vaultRoot: string): Promise<number> => {
  const base = pageEvidenceDbPath(vaultRoot);
  const sizes = await Promise.all(
    [base, `${base}-wal`, `${base}-shm`].map(async (path) => {
      const info = await stat(path).catch(() => null);
      return info?.size ?? 0;
    }),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
};

export const pageEvidenceStorageStats = async (vaultRoot: string): Promise<PageEvidenceStats> => {
  const records = await listPageEvidenceRecords(vaultRoot);
  const metadataOnly = records.filter((record) => record.evidenceTier === 'metadata_only').length;
  const featuresOnly = records.filter(
    (record) => record.evidenceTier === 'content_features_only',
  ).length;
  const indexed = records.filter((record) => record.evidenceTier === 'indexed_chunks').length;
  const contentRecords = records.filter((record) => record.content !== undefined);
  return {
    bytes: await pageEvidenceDbBytes(vaultRoot),
    records: records.length,
    metadataOnlyCount: metadataOnly,
    featuresOnlyCount: featuresOnly,
    indexedChunkCount: indexed,
    contentVectorReadyCount: contentRecords.filter(
      (record) => record.content?.docEmbeddingRef !== undefined,
    ).length,
    contentVectorMissingCount: contentRecords.filter(
      (record) =>
        record.content?.docEmbeddingRef === undefined &&
        record.content?.embeddingState !== 'disabled' &&
        record.content?.embeddingState !== 'failed',
    ).length,
    contentVectorDisabledCount: contentRecords.filter(
      (record) => record.content?.embeddingState === 'disabled',
    ).length,
    contentVectorFailedCount: contentRecords.filter(
      (record) => record.content?.embeddingState === 'failed',
    ).length,
    avgTopTermCount:
      records.length === 0
        ? 0
        : Number(
            (
              records.reduce((sum, record) => sum + (record.content?.terms.length ?? 0), 0) /
              records.length
            ).toFixed(2),
          ),
    featureOnlyPages: featuresOnly,
    pageEvidenceRawTextPersistedBytes: 0,
  };
};

export const pageEvidenceCorpusFor = (
  evidenceByCanonicalUrl: ReadonlyMap<string, PageEvidenceRecord>,
  canonicalUrl: string,
): string | undefined => {
  const record = evidenceByCanonicalUrl.get(canonicalizeEvidenceUrl(canonicalUrl));
  return record === undefined ? undefined : evidenceCorpusForRecord(record);
};

export const readPageEvidenceVectorMap = async (
  vaultRoot: string,
  records: Iterable<PageEvidenceRecord>,
): Promise<ReadonlyMap<string, Float32Array>> => {
  const out = new Map<string, Float32Array>();
  for (const record of records) {
    const ref = record.content?.docEmbeddingRef;
    if (ref === undefined) continue;
    const vector = await readPageEvidenceDocVector(vaultRoot, ref);
    if (vector !== null) out.set(ref.vectorId, vector);
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────
// Background-embedding lane adapters
//
// These bind the abstract BackgroundEmbeddingLaneDeps
// (page-evidence/backgroundEmbeddingLane.ts) to concrete vault I/O. The
// lane owns cadence + batch-cap + drain-pause; these functions own the
// per-record vault reads/writes.
// ─────────────────────────────────────────────────────────────────────

/** List every record as a lane candidate via a full SQL scan.
 *  RETAINED for tests + one-shot callers; the LANE now uses
 *  `createIncrementalBackgroundEmbeddingCandidateSource` (below) so it
 *  never re-derives the whole backlog every 4 s. The lane classifies
 *  backlog membership itself (isBackgroundEmbeddingBacklog); this just
 *  surfaces the structural fields it needs. */
export const listBackgroundEmbeddingCandidates = async (
  vaultRoot: string,
): Promise<
  readonly {
    readonly canonicalUrl: string;
    readonly url: string;
    readonly title?: string;
    readonly evidenceTier: PageEvidenceTier;
    readonly content?: {
      readonly embeddingState?: 'disabled' | 'missing' | 'failed' | 'ready';
      readonly docEmbeddingRef?: VectorRef;
    };
  }[]
> => {
  const records = await listPageEvidenceRecords(vaultRoot);
  return records.map((record) => ({
    canonicalUrl: record.canonicalUrl,
    // The record stores only the canonical URL (no raw URL); it is a
    // fully-formed https URL, so it satisfies the tombstone matcher's
    // registrableDomainFromUrl. `metadata.host` is the bare host only.
    url: record.canonicalUrl,
    ...(record.metadata.title === undefined ? {} : { title: record.metadata.title }),
    evidenceTier: record.evidenceTier,
    ...(record.content === undefined
      ? {}
      : {
          content: {
            ...(record.content.embeddingState === undefined
              ? {}
              : { embeddingState: record.content.embeddingState }),
            ...(record.content.docEmbeddingRef === undefined
              ? {}
              : { docEmbeddingRef: record.content.docEmbeddingRef }),
          },
        }),
  }));
};

// ─────────────────────────────────────────────────────────────────────
// Incremental backlog discovery
//
// UNCHANGED since before F5: this delta-diffing algorithm (compare
// (mtimeMs, size) fingerprints against a persisted index, re-derive
// only what changed) is storage-agnostic. Only its two low-level
// primitives — `listPageEvidenceRecordFiles` and
// `readPageEvidenceRecordByFileName` above — moved from fs readdir+stat
// to SQL. `mtimeMs` (now `seq`) still changes on every real write and
// stays fixed otherwise, so "read only the delta" holds exactly as
// before.
// ─────────────────────────────────────────────────────────────────────

const BACKGROUND_EMBEDDING_DISCOVERY_FILENAME = 'embed-lane-discovery.json';

const backgroundEmbeddingDiscoveryPath = (vaultRoot: string): string =>
  join(pageEvidenceRoot(vaultRoot), BACKGROUND_EMBEDDING_DISCOVERY_FILENAME);

/** One remembered file: its fingerprint + the last derived candidate
 *  fields. `canonicalUrl` is null when the file did not parse (kept so a
 *  broken file isn't re-read every cycle until it actually changes). */
interface DiscoveryIndexEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly canonicalUrl: string | null;
  readonly url: string;
  readonly title?: string;
  readonly evidenceTier: PageEvidenceTier;
  readonly embeddingState?: 'disabled' | 'missing' | 'failed' | 'ready';
  readonly hasDocEmbeddingRef: boolean;
}

interface BackgroundEmbeddingDiscoveryIndex {
  readonly schemaVersion: 1;
  /** fileName -> remembered fingerprint + verdict. */
  readonly byFileName: Record<string, DiscoveryIndexEntry>;
}

const emptyDiscoveryIndex = (): BackgroundEmbeddingDiscoveryIndex => ({
  schemaVersion: 1,
  byFileName: {},
});

export const readBackgroundEmbeddingDiscoveryIndex = async (
  vaultRoot: string,
): Promise<BackgroundEmbeddingDiscoveryIndex | null> => {
  const parsed = await readJson<BackgroundEmbeddingDiscoveryIndex>(
    backgroundEmbeddingDiscoveryPath(vaultRoot),
  );
  if (parsed === null || parsed.schemaVersion !== 1 || !isRecord(parsed.byFileName)) return null;
  return parsed;
};

export const writeBackgroundEmbeddingDiscoveryIndex = async (
  vaultRoot: string,
  index: BackgroundEmbeddingDiscoveryIndex,
): Promise<void> => {
  await atomicWriteJson(backgroundEmbeddingDiscoveryPath(vaultRoot), index);
};

export interface BackgroundEmbeddingDiscovery {
  readonly candidates: readonly {
    readonly canonicalUrl: string;
    readonly url: string;
    readonly title?: string;
    readonly evidenceTier: PageEvidenceTier;
    readonly content?: {
      readonly embeddingState?: 'disabled' | 'missing' | 'failed' | 'ready';
      readonly docEmbeddingRef?: VectorRef;
    };
  }[];
  /** The refreshed index to persist. */
  readonly index: BackgroundEmbeddingDiscoveryIndex;
  /** Bookkeeping so the lane can log/health-report scan cost. */
  readonly totalFiles: number;
  /** How many files were actually JSON-read this cycle (the delta). */
  readonly filesRead: number;
}

const entryToCandidate = (
  entry: DiscoveryIndexEntry,
): BackgroundEmbeddingDiscovery['candidates'][number] | null => {
  if (entry.canonicalUrl === null) return null;
  return {
    canonicalUrl: entry.canonicalUrl,
    url: entry.url,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    evidenceTier: entry.evidenceTier,
    content: {
      ...(entry.embeddingState === undefined ? {} : { embeddingState: entry.embeddingState }),
      // The lane only needs to know a ref EXISTS (isBackgroundEmbeddingBacklog
      // gates on `docEmbeddingRef !== undefined`); we don't persist the whole
      // ref in the index, so surface a sentinel presence marker. Records with
      // a ready ref are not backlog and never re-embedded, so the sentinel is
      // never dereferenced.
      ...(entry.hasDocEmbeddingRef
        ? { docEmbeddingRef: { present: true } as unknown as VectorRef }
        : {}),
    },
  };
};

const entryFromRecord = (
  record: PageEvidenceRecord,
  fingerprint: PageEvidenceRecordFileStat,
): DiscoveryIndexEntry => ({
  mtimeMs: fingerprint.mtimeMs,
  size: fingerprint.size,
  canonicalUrl: record.canonicalUrl,
  url: record.canonicalUrl,
  ...(record.metadata.title === undefined ? {} : { title: record.metadata.title }),
  evidenceTier: record.evidenceTier,
  ...(record.content?.embeddingState === undefined
    ? {}
    : { embeddingState: record.content.embeddingState }),
  hasDocEmbeddingRef: record.content?.docEmbeddingRef !== undefined,
});

/**
 * Discover the current backlog candidate set using the mtime-bucketed
 * delta discipline. Reads+parses JSON only for record files whose
 * (mtimeMs, size) fingerprint changed since `priorIndex` (or are new);
 * carries forward the remembered verdict for every unchanged file.
 * Returns the candidate list plus the refreshed index (persist it via
 * writeBackgroundEmbeddingDiscoveryIndex) and scan bookkeeping.
 */
export const discoverBackgroundEmbeddingBacklog = async (
  vaultRoot: string,
  priorIndex: BackgroundEmbeddingDiscoveryIndex | null,
): Promise<BackgroundEmbeddingDiscovery> => {
  const prior = priorIndex ?? emptyDiscoveryIndex();
  const fingerprints = await listPageEvidenceRecordFiles(vaultRoot);
  const nextByFileName: Record<string, DiscoveryIndexEntry> = {};
  let filesRead = 0;
  // Read only the changed/new files. `mapInChunks` bounds concurrency the
  // same way listPageEvidenceRecordFiles does.
  const toRead = fingerprints.filter((fp) => {
    const remembered = prior.byFileName[fp.name];
    return (
      remembered === undefined ||
      remembered.mtimeMs !== fp.mtimeMs ||
      remembered.size !== fp.size
    );
  });
  const readEntries = await mapInChunks(toRead, 100, async (fp) => {
    const record = await readPageEvidenceRecordByFileName(vaultRoot, fp.name);
    if (record === null) {
      // Unparseable — remember the fingerprint so we don't re-read it
      // until the file changes, but produce no candidate.
      return [
        fp.name,
        {
          mtimeMs: fp.mtimeMs,
          size: fp.size,
          canonicalUrl: null,
          url: '',
          evidenceTier: 'metadata_only' as PageEvidenceTier,
          hasDocEmbeddingRef: false,
        } satisfies DiscoveryIndexEntry,
      ] as const;
    }
    return [fp.name, entryFromRecord(record, fp)] as const;
  });
  const readByName = new Map<string, DiscoveryIndexEntry>(readEntries);
  filesRead = readEntries.length;
  for (const fp of fingerprints) {
    const fresh = readByName.get(fp.name);
    if (fresh !== undefined) {
      nextByFileName[fp.name] = fresh;
      continue;
    }
    // Unchanged file — carry the remembered verdict forward (its
    // fingerprint is guaranteed to match, or it would have been re-read).
    const remembered = prior.byFileName[fp.name];
    if (remembered !== undefined) nextByFileName[fp.name] = remembered;
  }
  const candidates: BackgroundEmbeddingDiscovery['candidates'][number][] = [];
  for (const entry of Object.values(nextByFileName)) {
    const candidate = entryToCandidate(entry);
    if (candidate !== null) candidates.push(candidate);
  }
  candidates.sort((left, right) => compareText(left.canonicalUrl, right.canonicalUrl));
  return {
    candidates,
    index: { schemaVersion: 1, byFileName: nextByFileName },
    totalFiles: fingerprints.length,
    filesRead,
  };
};

export interface IncrementalCandidateSource {
  /** Discover the current backlog candidate set (bounded to the delta)
   *  and persist the refreshed cursor. Safe to call every cycle. */
  readonly listCandidates: () => Promise<
    readonly {
      readonly canonicalUrl: string;
      readonly url: string;
      readonly title?: string;
      readonly evidenceTier: PageEvidenceTier;
      readonly content?: {
        readonly embeddingState?: 'disabled' | 'missing' | 'failed' | 'ready';
        readonly docEmbeddingRef?: VectorRef;
      };
    }[]
  >;
  /** Last cycle's scan cost (files listed vs files JSON-read). */
  readonly lastScan: () => { readonly totalFiles: number; readonly filesRead: number };
}

/**
 * Build the LANE's candidate source: an incremental, cursor-backed
 * discovery that reads+parses ONLY the files that changed since last
 * cycle (mtime-bucketed delta). The cursor is loaded lazily on first
 * call and persisted after each discovery, so a restart resumes from
 * the on-disk index instead of a cold full scan.
 */
export const createIncrementalBackgroundEmbeddingCandidateSource = (
  vaultRoot: string,
): IncrementalCandidateSource => {
  let index: BackgroundEmbeddingDiscoveryIndex | null = null;
  let loaded = false;
  let lastTotalFiles = 0;
  let lastFilesRead = 0;
  return {
    listCandidates: async () => {
      if (!loaded) {
        loaded = true;
        index = await readBackgroundEmbeddingDiscoveryIndex(vaultRoot).catch(() => null);
      }
      const discovery = await discoverBackgroundEmbeddingBacklog(vaultRoot, index);
      index = discovery.index;
      lastTotalFiles = discovery.totalFiles;
      lastFilesRead = discovery.filesRead;
      // Best-effort persist — a failure only costs a re-read of the
      // delta next cycle, never correctness.
      await writeBackgroundEmbeddingDiscoveryIndex(vaultRoot, discovery.index).catch(() => undefined);
      return discovery.candidates;
    },
    lastScan: () => ({ totalFiles: lastTotalFiles, filesRead: lastFilesRead }),
  };
};

/**
 * Embed one backlog canonical URL by reconstructing the extraction
 * payload (with raw text) from the page-content store, then routing it
 * through the SAME `completeExtractedPageEvidenceEmbedding` path the
 * request handler uses. The embedder is the process-global override
 * (recall/embedder.js) — off-main when the runtime installed the
 * embedder child.
 *
 * Returns:
 *   - 'skipped'  — no indexed content payload on disk (content-features-
 *                  only page, or raw text absent). Not a failure.
 *   - 'embedded' — a ready vector now backs the record.
 *   - 'failed'   — the record still has no ready vector after the pass
 *                  (embed threw, or produced no vector).
 */
export const embedBacklogCanonicalUrl = async (
  vaultRoot: string,
): Promise<(canonicalUrl: string) => Promise<'embedded' | 'skipped' | 'failed'>> => {
  return async (rawCanonicalUrl) => {
    const payload = await readPageContentExtractedPayloadForEvidence(vaultRoot, rawCanonicalUrl);
    if (payload === null) return 'skipped';
    // ONE KEY, END TO END. The page-content read canonicalizes with the
    // page-content rules (sorted query params, tracking params stripped),
    // which for multi-param URLs is a DIFFERENT string than the evidence
    // key the lane's backlog is filed under. Writing under the payload's
    // key as-is created a ready TWIN record and left the backlog record
    // untouched — the lane then re-"embedded" the same head slots forever
    // (676,537 phantom successes against a frozen backlog of ~453 on the
    // live vault). Pin the write to the evidence key that was requested.
    const requestedKey = canonicalizeEvidenceUrl(rawCanonicalUrl);
    const record = await completeExtractedPageEvidenceEmbedding(vaultRoot, {
      ...payload,
      canonicalUrl: requestedKey,
      storageMode: 'indexed_chunks',
    });
    if (record.content?.embeddingState !== 'ready' || record.content.docEmbeddingRef === undefined) {
      return 'failed';
    }
    // Completion is what is ON DISK at the requested key, not what the
    // in-memory return claims (same read-back discipline as the body
    // evidence worker): a silent no-write or a write under another key
    // must count as failure so the lane burns an attempt instead of
    // celebrating forever.
    const persisted = await readRawPageEvidence(vaultRoot, requestedKey);
    if (
      persisted?.content?.embeddingState === 'ready' &&
      persisted.content.docEmbeddingRef !== undefined
    ) {
      return 'embedded';
    }
    return 'failed';
  };
};

const BACKGROUND_EMBEDDING_PROGRESS_FILENAME = 'embed-lane-progress.json';

const backgroundEmbeddingProgressPath = (vaultRoot: string): string =>
  join(pageEvidenceRoot(vaultRoot), BACKGROUND_EMBEDDING_PROGRESS_FILENAME);

export interface BackgroundEmbeddingProgressArtifact {
  readonly schemaVersion: 1;
  readonly attemptsByCanonicalUrl: Record<string, number>;
  readonly embeddedTotal: number;
  readonly lastRunAtMs: number | null;
}

export const readBackgroundEmbeddingProgress = async (
  vaultRoot: string,
): Promise<BackgroundEmbeddingProgressArtifact | null> => {
  const parsed = await readJson<BackgroundEmbeddingProgressArtifact>(
    backgroundEmbeddingProgressPath(vaultRoot),
  );
  if (parsed === null || parsed.schemaVersion !== 1) return null;
  return parsed;
};

export const writeBackgroundEmbeddingProgress = async (
  vaultRoot: string,
  progress: BackgroundEmbeddingProgressArtifact,
): Promise<void> => {
  await atomicWriteJson(backgroundEmbeddingProgressPath(vaultRoot), progress);
};
