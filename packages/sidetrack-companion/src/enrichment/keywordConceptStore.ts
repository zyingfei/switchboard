// Concept store — persistence for the keyword->concept assignment
// (keywordConcepts.ts's pure math) across restarts. Same SQLite scaffolding
// family as search-index/keywordIndexStore.ts and
// workstreams/suggestionCandidateStore.ts.
//
// SMALL VOCABULARY, DELIBERATELY NOT WATERMARK/CATCHUP-DRIVEN. Unlike
// keywordIndexStore.ts (one row per page, corpus-sized), this store has one
// row per DISTINCT KEYWORD — dozens to low thousands, not hundreds of
// thousands. A caller (the live ingest hook or the backfill lane) simply
// calls `assignKeyword` for each keyword it has not seen before
// (`hasKeyword` answers that in O(1)); there is no separate progress/cursor
// concept to get out of sync, because the store itself IS the "have I seen
// this keyword" record.

import { join } from 'node:path';

import {
  DEFAULT_CONCEPT_COSINE_THRESHOLD,
  assignConceptForKeyword,
  foldConceptMember,
  type ConceptCentroid,
} from './keywordConcepts.js';

export interface ConceptAssignmentOutcome {
  readonly conceptId: string;
  /** True when this call minted a brand-new concept rather than joining an
   *  existing one. */
  readonly created: boolean;
  readonly similarity: number;
}

export interface KeywordConceptStore {
  readonly conceptForKeyword: (keyword: string) => string | undefined;
  readonly hasKeyword: (keyword: string) => boolean;
  /** Every current centroid, ordered by conceptId — the stable iteration
   *  order `assignConceptForKeyword`'s tie-break assumes. */
  readonly allCentroids: () => readonly ConceptCentroid[];
  /**
   * Assign (or confirm) a concept for a keyword given its embedding.
   * Idempotent for an already-assigned keyword — re-embedding the SAME
   * keyword is never expected (embeddings are deterministic for a fixed
   * model revision), but a caller that does call this twice for the same
   * keyword gets back its EXISTING assignment unchanged rather than folding
   * the embedding into the centroid a second time (which would silently
   * double-weight that member).
   */
  readonly assignKeyword: (
    keyword: string,
    embedding: Float32Array,
    now: number,
    threshold?: number,
  ) => ConceptAssignmentOutcome;
  /** Concept ids for a page's keyword list, deduped, undefined entries
   *  (keywords never assigned yet) skipped. */
  readonly conceptIdsForKeywords: (keywords: readonly string[]) => readonly string[];
  readonly stats: () => { readonly distinctKeywords: number; readonly distinctConcepts: number };
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
  CREATE TABLE IF NOT EXISTS keyword_concept (
    keyword TEXT PRIMARY KEY,
    concept_id TEXT NOT NULL,
    assigned_at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS keyword_concept_concept ON keyword_concept(concept_id);
  CREATE TABLE IF NOT EXISTS concept_centroid (
    concept_id TEXT PRIMARY KEY,
    centroid_json TEXT NOT NULL,
    member_count INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS concept_seq (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    next_value INTEGER NOT NULL
  );
`;

interface ConceptRow {
  readonly concept_id: string;
  readonly centroid_json: string;
  readonly member_count: number;
}

const rowToCentroid = (row: ConceptRow): ConceptCentroid => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.centroid_json);
  } catch {
    parsed = [];
  }
  const values = Array.isArray(parsed) ? (parsed as number[]) : [];
  return {
    conceptId: row.concept_id,
    centroid: Float32Array.from(values),
    memberCount: row.member_count,
  };
};

export const createKeywordConceptStore = async (
  vaultRoot: string,
): Promise<KeywordConceptStore> => {
  const { Database } = await loadSqlite();
  const dbPath = join(vaultRoot, '_BAC', 'connections', 'keyword-concepts.db');
  const db = new Database(dbPath, { create: true, readwrite: true });
  db.exec(SCHEMA);
  db.query('INSERT OR IGNORE INTO concept_seq (id, next_value) VALUES (1, 1)').run();

  const selectConceptForKeyword = db.query(
    'SELECT concept_id FROM keyword_concept WHERE keyword = ?',
  );
  const insertKeyword = db.query(
    'INSERT INTO keyword_concept (keyword, concept_id, assigned_at_ms) VALUES (?,?,?)',
  );
  const selectAllCentroids = db.query(
    'SELECT concept_id, centroid_json, member_count FROM concept_centroid ORDER BY concept_id',
  );
  const upsertCentroid = db.query(
    `INSERT INTO concept_centroid (concept_id, centroid_json, member_count, updated_at_ms)
     VALUES (?,?,?,?)
     ON CONFLICT(concept_id) DO UPDATE SET
       centroid_json = excluded.centroid_json,
       member_count = excluded.member_count,
       updated_at_ms = excluded.updated_at_ms`,
  );
  const nextSeqValue = db.query('SELECT next_value FROM concept_seq WHERE id = 1');
  const bumpSeq = db.query('UPDATE concept_seq SET next_value = next_value + 1 WHERE id = 1');
  const countKeywords = db.query('SELECT COUNT(*) AS c FROM keyword_concept');
  const countConcepts = db.query('SELECT COUNT(*) AS c FROM concept_centroid');

  const conceptForKeyword = (keyword: string): string | undefined => {
    const row = selectConceptForKeyword.get(keyword) as { readonly concept_id: string } | null;
    return row == null ? undefined : row.concept_id;
  };

  const hasKeyword = (keyword: string): boolean => conceptForKeyword(keyword) !== undefined;

  const allCentroids = (): readonly ConceptCentroid[] => {
    const rows = selectAllCentroids.all() as readonly ConceptRow[];
    return rows.map(rowToCentroid);
  };

  const mintConceptId = (): string => {
    const row = nextSeqValue.get() as { readonly next_value: number } | null;
    const value = row?.next_value ?? 1;
    bumpSeq.run();
    return `concept-${String(value)}`;
  };

  const assignKeyword = (
    keyword: string,
    embedding: Float32Array,
    now: number,
    threshold: number = DEFAULT_CONCEPT_COSINE_THRESHOLD,
  ): ConceptAssignmentOutcome => {
    const existing = conceptForKeyword(keyword);
    if (existing !== undefined) {
      // Already assigned — idempotent no-op, never double-folds the member.
      return { conceptId: existing, created: false, similarity: 1 };
    }

    const centroids = allCentroids();
    const decision = assignConceptForKeyword(embedding, centroids, threshold);

    db.exec('BEGIN');
    try {
      if (decision.matchedConceptId !== null) {
        const priorCentroid = centroids.find((c) => c.conceptId === decision.matchedConceptId);
        const updated = foldConceptMember(
          decision.matchedConceptId,
          priorCentroid ?? null,
          embedding,
        );
        upsertCentroid.run(
          updated.conceptId,
          JSON.stringify(Array.from(updated.centroid)),
          updated.memberCount,
          now,
        );
        insertKeyword.run(keyword, updated.conceptId, now);
        db.exec('COMMIT');
        return { conceptId: updated.conceptId, created: false, similarity: decision.bestSimilarity };
      }

      const conceptId = mintConceptId();
      const seeded = foldConceptMember(conceptId, null, embedding);
      upsertCentroid.run(
        seeded.conceptId,
        JSON.stringify(Array.from(seeded.centroid)),
        seeded.memberCount,
        now,
      );
      insertKeyword.run(keyword, seeded.conceptId, now);
      db.exec('COMMIT');
      return { conceptId, created: true, similarity: decision.bestSimilarity };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const conceptIdsForKeywords = (keywords: readonly string[]): readonly string[] => {
    const ids = new Set<string>();
    for (const keyword of keywords) {
      const conceptId = conceptForKeyword(keyword);
      if (conceptId !== undefined) ids.add(conceptId);
    }
    return [...ids];
  };

  const stats = (): { readonly distinctKeywords: number; readonly distinctConcepts: number } => {
    const keywordsRow = countKeywords.get() as { readonly c: number } | null;
    const conceptsRow = countConcepts.get() as { readonly c: number } | null;
    return {
      distinctKeywords: keywordsRow?.c ?? 0,
      distinctConcepts: conceptsRow?.c ?? 0,
    };
  };

  return {
    conceptForKeyword,
    hasKeyword,
    allCentroids,
    assignKeyword,
    conceptIdsForKeywords,
    stats,
    close: () => {
      db.close?.();
    },
  };
};
