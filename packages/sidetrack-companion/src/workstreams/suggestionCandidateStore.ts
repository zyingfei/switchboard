// Persisted candidate state for split / new-category suggestions —
// docs/plans/2026-08-16-category-flexibility-hyde.md §4.
//
// This is DERIVED STATS state, not event-sourced from user actions (unlike
// `workstreamMembershipStore.ts`): it exists purely to make two properties
// possible across process restarts and drains —
//
//   1. STABILITY GATING. A candidate cluster must appear across multiple
//      CONSECUTIVE recomputations before it is allowed to emit as a
//      suggestion ("unstable clusters never emit; stable ones emit once,
//      not repeatedly"). That requires remembering, per candidate, how many
//      times in a row it has been seen and whether it has already emitted.
//   2. DIRTY-MARKING. Recomputation only runs when a scope's evidence
//      actually changed (`lastComputedRevision` != the caller-supplied
//      revision id) — "incremental recompute only when the workstream's
//      evidence changed ... no sweeps".
//
// `scopeId` is a workstreamId for a split-suggestion candidate, or the
// fixed `NEW_CATEGORY_SCOPE_ID` sentinel for a new-category candidate (the
// design's "same machinery applied to" the vault-wide unaffiliated-evidence
// pool instead of one workstream's own evidence).

import { join } from 'node:path';

export const NEW_CATEGORY_SCOPE_ID = '__unfiled__';

export const SUGGESTION_CANDIDATE_KINDS = ['split', 'new-category'] as const;
export type SuggestionCandidateKind = (typeof SUGGESTION_CANDIDATE_KINDS)[number];

export interface SuggestionCandidateRecord {
  readonly scopeId: string;
  readonly kind: SuggestionCandidateKind;
  readonly fingerprint: string;
  readonly memberIds: readonly string[];
  readonly consecutiveStableCount: number;
  readonly emitted: boolean;
  readonly structuralName: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  // UI-visibility phase (docs/plans/2026-08-16-category-flexibility-hyde.md)
  // — the per-scope decline memory the panel's suggestion cards need: once
  // a user declines a split/new-category suggestion, that exact cluster
  // must never resurface, even across future recomputations. The engine
  // (splitSuggestionEngine.ts) carries these two fields forward on its
  // Jaccard-overlap match the same way it already carries
  // `consecutiveStableCount`/`createdAtMs` forward — dismissing is sticky,
  // not reset by recompute.
  readonly dismissed: boolean;
  readonly dismissedAtMs: number | null;
}

export interface SuggestionCandidateStore {
  /** Every persisted candidate for one (scopeId, kind) — most recent computation only. */
  readonly candidatesFor: (
    scopeId: string,
    kind: SuggestionCandidateKind,
  ) => readonly SuggestionCandidateRecord[];
  /** The revision id this scope was last computed against, or undefined if never computed. */
  readonly lastComputedRevision: (scopeId: string, kind: SuggestionCandidateKind) => string | undefined;
  /**
   * Atomically replace every candidate for (scopeId, kind) with `candidates`
   * and record `revisionId` as the last-computed watermark. Candidates from
   * a PRIOR computation that don't appear in `candidates` are dropped (a
   * cluster that dissolved between recomputations loses its stability
   * streak — restarting the streak on reappearance is the conservative
   * choice, matching "cold-start = no suggestions").
   */
  readonly replaceScope: (
    scopeId: string,
    kind: SuggestionCandidateKind,
    revisionId: string,
    candidates: readonly SuggestionCandidateRecord[],
  ) => void;
  /**
   * Mark ONE candidate (matched by its exact fingerprint) dismissed —
   * "declined, never resurface." A no-op (returns false) when no candidate
   * with that fingerprint currently exists for (scopeId, kind); the caller
   * decides whether that's worth surfacing as an error (it usually means
   * the candidate was already superseded by a recompute between the read
   * that served the suggestion and the decline click).
   */
  readonly dismissCandidate: (
    scopeId: string,
    kind: SuggestionCandidateKind,
    fingerprint: string,
    dismissedAtMs: number,
  ) => boolean;
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
  CREATE TABLE IF NOT EXISTS suggestion_candidate_scope (
    scope_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    last_computed_revision TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (scope_id, kind)
  );
  CREATE TABLE IF NOT EXISTS suggestion_candidate (
    scope_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    member_ids_json TEXT NOT NULL,
    consecutive_stable_count INTEGER NOT NULL,
    emitted INTEGER NOT NULL,
    structural_name TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (scope_id, kind, fingerprint)
  );
`;

interface CandidateRow {
  readonly fingerprint: string;
  readonly member_ids_json: string;
  readonly consecutive_stable_count: number;
  readonly emitted: number;
  readonly structural_name: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly dismissed: number;
  readonly dismissed_at_ms: number | null;
}

const toRecord = (
  scopeId: string,
  kind: SuggestionCandidateKind,
  row: CandidateRow,
): SuggestionCandidateRecord => {
  let memberIds: unknown;
  try {
    memberIds = JSON.parse(row.member_ids_json);
  } catch {
    memberIds = [];
  }
  return {
    scopeId,
    kind,
    fingerprint: row.fingerprint,
    memberIds: Array.isArray(memberIds) ? (memberIds as string[]) : [],
    consecutiveStableCount: row.consecutive_stable_count,
    emitted: row.emitted === 1,
    structuralName: row.structural_name,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    dismissed: row.dismissed === 1,
    dismissedAtMs: row.dismissed_at_ms,
  };
};

export const createSuggestionCandidateStore = async (
  vaultRoot: string,
): Promise<SuggestionCandidateStore> => {
  const { Database } = await loadSqlite();
  const dbPath = join(vaultRoot, '_BAC', 'connections', 'suggestion-candidates.db');
  const db = new Database(dbPath, { create: true, readwrite: true });
  db.exec(SCHEMA);
  // Additive migration for a vault whose suggestion-candidates.db predates
  // the decline-memory columns — same guarded ADD COLUMN idiom
  // sync/eventStore.ts uses for `resolver_url` (PRAGMA table_info check,
  // one-time ALTER, no-op once the column exists).
  const candidateColumns = db.query("PRAGMA table_info('suggestion_candidate')").all() as readonly {
    readonly name: string;
  }[];
  if (!candidateColumns.some((column) => column.name === 'dismissed')) {
    db.exec('ALTER TABLE suggestion_candidate ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0');
  }
  if (!candidateColumns.some((column) => column.name === 'dismissed_at_ms')) {
    db.exec('ALTER TABLE suggestion_candidate ADD COLUMN dismissed_at_ms INTEGER');
  }

  const selectCandidates = db.query(
    `SELECT fingerprint, member_ids_json, consecutive_stable_count, emitted, structural_name,
            created_at_ms, updated_at_ms, dismissed, dismissed_at_ms
     FROM suggestion_candidate WHERE scope_id = ? AND kind = ?
     ORDER BY fingerprint`,
  );
  const selectRevision = db.query(
    'SELECT last_computed_revision FROM suggestion_candidate_scope WHERE scope_id = ? AND kind = ?',
  );
  const upsertScope = db.query(
    `INSERT INTO suggestion_candidate_scope (scope_id, kind, last_computed_revision, updated_at_ms)
     VALUES (?,?,?,?)
     ON CONFLICT(scope_id, kind) DO UPDATE SET
       last_computed_revision = excluded.last_computed_revision,
       updated_at_ms = excluded.updated_at_ms`,
  );
  const deleteScopeCandidates = db.query(
    'DELETE FROM suggestion_candidate WHERE scope_id = ? AND kind = ?',
  );
  const insertCandidate = db.query(
    `INSERT INTO suggestion_candidate
       (scope_id, kind, fingerprint, member_ids_json, consecutive_stable_count, emitted,
        structural_name, created_at_ms, updated_at_ms, dismissed, dismissed_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const updateDismissed = db.query(
    `UPDATE suggestion_candidate SET dismissed = 1, dismissed_at_ms = ?
     WHERE scope_id = ? AND kind = ? AND fingerprint = ?`,
  );

  const candidatesFor = (
    scopeId: string,
    kind: SuggestionCandidateKind,
  ): readonly SuggestionCandidateRecord[] => {
    const rows = selectCandidates.all(scopeId, kind) as readonly CandidateRow[];
    return rows.map((row) => toRecord(scopeId, kind, row));
  };

  const lastComputedRevision = (
    scopeId: string,
    kind: SuggestionCandidateKind,
  ): string | undefined => {
    const row = selectRevision.get(scopeId, kind) as
      | { readonly last_computed_revision: string }
      | undefined;
    return row?.last_computed_revision;
  };

  const replaceScope = (
    scopeId: string,
    kind: SuggestionCandidateKind,
    revisionId: string,
    candidates: readonly SuggestionCandidateRecord[],
  ): void => {
    db.exec('BEGIN');
    try {
      deleteScopeCandidates.run(scopeId, kind);
      for (const candidate of candidates) {
        insertCandidate.run(
          scopeId,
          kind,
          candidate.fingerprint,
          JSON.stringify(candidate.memberIds),
          candidate.consecutiveStableCount,
          candidate.emitted ? 1 : 0,
          candidate.structuralName,
          candidate.createdAtMs,
          candidate.updatedAtMs,
          candidate.dismissed ? 1 : 0,
          candidate.dismissedAtMs,
        );
      }
      upsertScope.run(scopeId, kind, revisionId, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  const dismissCandidate = (
    scopeId: string,
    kind: SuggestionCandidateKind,
    fingerprint: string,
    dismissedAtMs: number,
  ): boolean => {
    const result = updateDismissed.run(dismissedAtMs, scopeId, kind, fingerprint) as
      | { readonly changes?: number }
      | undefined;
    return (result?.changes ?? 0) > 0;
  };

  return {
    candidatesFor,
    lastComputedRevision,
    replaceScope,
    dismissCandidate,
    close: () => {
      db.close?.();
    },
  };
};
