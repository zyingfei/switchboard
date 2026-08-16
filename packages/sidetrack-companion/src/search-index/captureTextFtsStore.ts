// W2 of the F8 IVM plan (docs/plans/2026-08-16-f8-ivm-designs.md) —
// standalone sidecar over capture/dispatch/annotation text. NOT WIRED
// into the materializer yet.
//
// The full build's `thread_text_mentions_search_query` edge (Pass 6,
// src/connections/snapshot.ts:3002-3106) walks EVERY CAPTURE_RECORDED
// turn / DISPATCH_RECORDED body / ANNOTATION_CREATED note on every
// drain, testing each against every eligible search-visit query with
// a compiled whole-word regex. This store persists one row per
// contributing event (idempotent by (replicaId, seq), matching
// timelineFactsStore.ts's discipline) and an FTS5 index over the text,
// so `matchWholeWord(query)` becomes an indexed lookup instead of a
// full corpus scan.
//
// Source fields, verified against src/connections/snapshot.ts:3063-3105:
//   CAPTURE_RECORDED  (src/recall/events.ts CaptureRecordedPayload)
//     — every turn's `text`, `markdown`, `formattedText` (non-empty
//       ones only), joined with '\n' (a non-word separator, so it
//       can't accidentally fuse two words across a join point into a
//       false whole-word match/non-match — see AMENDMENT 1 test
//       coverage). Same aggregation snapshot.ts Pass 5
//       (thread_quotes_thread, lines 2913-2920) uses for the same
//       fields. node id = thread:<threadId ?? bac_id>
//       (nodeIdFor('thread', ...), src/connections/types.ts:312).
//   DISPATCH_RECORDED (src/dispatches/events.ts DispatchRecordedPayload)
//     — `body`. node id = dispatch:<bac_id>.
//   ANNOTATION_CREATED (src/annotations/events.ts AnnotationCreatedPayload)
//     — `note`. node id = annotation:<bac_id>.
//
// AMENDMENT 1 (tokenizer parity): `matchWholeWord` is FTS5 MATCH as a
// recall-only prefilter, followed by the EXACT SAME JS whole-word
// predicate (`matchesWholeWordQuery`, extracted verbatim from
// snapshot.ts Pass 6 into ./searchTextMatch.ts) as the authoritative
// post-filter.
//
// Tokenizer choice: `unicode61` (word-segmenting) was tried first and
// REJECTED — it treats Unicode letters/digits (including CJK) as
// token-forming the same as ASCII, while JS's `\b` is ASCII-`\w`-only.
// That mismatch is not just a diacritics/casing nuance: a run of text
// with NO separator between an ASCII word and a non-ASCII one (e.g.
// "x东京y", or any language that doesn't put spaces between words)
// gets merged into ONE unicode61 token, so an exact-token MATCH for
// "东京" (or even the ASCII-only "go" against "go东京") can silently
// MISS a row the JS regex *does* match — an under-recall, which is
// exactly what AMENDMENT 1 forbids (verified empirically against
// bun:sqlite; see the parity suite below for the reproduction).
//
// This store instead uses FTS5's `trigram` tokenizer, which indexes
// overlapping 3-character windows with no word-segmentation model at
// all — SQLite's own docs describe it as built for "'contains' style
// queries... even if that substring does not start on a token
// boundary". MATCH-ing the ENTIRE normalized query as one quoted
// phrase against a trigram index is therefore a literal SUBSTRING
// test: if `\b<query>\b` matches some text, `query` occurs as a
// literal substring of that text (the `\b` anchors only constrain the
// two outer edges), and trigram is guaranteed to surface any literal
// substring occurrence — so it can only ever over-recall relative to
// the true positive set, never drop one. The one caveat (verified
// empirically) is that trigram silently under-recalls for search
// terms shorter than 3 characters, so `matchWholeWord` falls back to
// a full table scan below that length — see `TRIGRAM_MIN_LENGTH`.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ANNOTATION_CREATED, isAnnotationCreatedPayload } from '../annotations/events.js';
import { DISPATCH_RECORDED, isDispatchRecordedPayload } from '../dispatches/events.js';
import { nodeIdFor } from '../connections/types.js';
import { CAPTURE_RECORDED, isCaptureRecordedPayload } from '../recall/events.js';
import { matchesWholeWordQuery } from './searchTextMatch.js';
import type { AcceptedEvent, VersionVector } from '../sync/causal.js';

export type CaptureTextDocKind = 'capture' | 'dispatch' | 'annotation';

export interface CaptureTextMatch {
  readonly docKind: CaptureTextDocKind;
  readonly docId: string;
  /** thread:<id> / dispatch:<id> / annotation:<id> — nodeIdFor(kind, key). */
  readonly nodeId: string;
  readonly eventType: string;
  readonly replicaId: string;
  readonly seq: number;
  readonly observedAt: string;
}

export interface CaptureTextFtsStore {
  /** Idempotent by (replicaId, seq). Indexes capture/dispatch/
   *  annotation text; ignores all other event types and empty text. */
  readonly ingest: (event: AcceptedEvent) => boolean;
  /** Batch ingest in one transaction. Returns the count actually indexed. */
  readonly ingestMany: (events: readonly AcceptedEvent[]) => number;
  /** Ingest only events past the persisted per-replica watermark. */
  readonly catchUp: (events: readonly AcceptedEvent[]) => Promise<number>;
  /** FTS5 MATCH prefilter + exact JS whole-word postfilter. `query`
   *  is trimmed/lowercased internally, mirroring snapshot.ts Pass 6's
   *  `q.trim().toLowerCase()` treatment of `metadata.searchQuery`. */
  readonly matchWholeWord: (query: string) => readonly CaptureTextMatch[];
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

// External-content FTS5 + triggers is "the docs_fts idiom" the plan
// doc names for this store (src/recall-v2/store/sqlite.ts:108-129) —
// reused for the sync mechanism (AI/AD triggers keeping the index
// current). The tokenizer itself is `trigram`, not recall-v2's
// `unicode61 remove_diacritics 2` — see the module comment for why.
const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 2500;
  CREATE TABLE IF NOT EXISTS capture_text_doc (
    replica_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    doc_kind TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (replica_id, seq)
  );
  CREATE INDEX IF NOT EXISTS capture_text_doc_node ON capture_text_doc(node_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS capture_text_fts USING fts5(
    text,
    content='capture_text_doc',
    content_rowid='rowid',
    tokenize='trigram'
  );
  -- External-content FTS5 + triggers idiom (recall-v2/store/sqlite.ts
  -- docs_fts). Only AI/AD: rows are only ever inserted (idempotent, by
  -- PK) or bulk-deleted on rebuild — never updated in place.
  CREATE TRIGGER IF NOT EXISTS capture_text_doc_ai AFTER INSERT ON capture_text_doc BEGIN
    INSERT INTO capture_text_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS capture_text_doc_ad AFTER DELETE ON capture_text_doc BEGIN
    INSERT INTO capture_text_fts(capture_text_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  END;
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

interface DocRow {
  readonly replica_id: string;
  readonly seq: number;
  readonly doc_kind: string;
  readonly doc_id: string;
  readonly node_id: string;
  readonly event_type: string;
  readonly observed_at: string;
  readonly text: string;
}

const rowToMatch = (row: unknown): CaptureTextMatch => ({
  docKind: stringField(row, 'doc_kind') as CaptureTextDocKind,
  docId: stringField(row, 'doc_id'),
  nodeId: stringField(row, 'node_id'),
  eventType: stringField(row, 'event_type'),
  replicaId: stringField(row, 'replica_id'),
  seq: numberField(row, 'seq'),
  observedAt: stringField(row, 'observed_at'),
});

/** Non-empty turn text sources, joined with '\n' (a non-word
 *  character, so joining can't fuse the trailing word of one part
 *  with the leading word of the next into a spurious match/non-match).
 *  Mirrors src/connections/snapshot.ts:2913-2920 (Pass 5) and the
 *  per-field iteration order of Pass 6 (:3071-3083). */
const captureDocText = (turns: readonly { text: string; markdown?: string; formattedText?: string }[]): string => {
  const parts: string[] = [];
  for (const turn of turns) {
    if (typeof turn.text === 'string' && turn.text.length > 0) parts.push(turn.text);
    if (typeof turn.markdown === 'string' && turn.markdown.length > 0) parts.push(turn.markdown);
    if (typeof turn.formattedText === 'string' && turn.formattedText.length > 0)
      parts.push(turn.formattedText);
  }
  return parts.join('\n');
};

export const createCaptureTextFtsStore = async (
  vaultRoot: string,
): Promise<CaptureTextFtsStore> => {
  const { Database } = await loadSqlite();
  const dbPath = join(vaultRoot, '_BAC', 'connections', 'capture-text-fts.db');
  const db = new Database(dbPath, { create: true, readwrite: true });
  db.exec(SCHEMA);

  const insertDoc = db.query(
    `INSERT OR IGNORE INTO capture_text_doc
       (replica_id, seq, doc_kind, doc_id, node_id, event_type, observed_at, text)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const bumpWatermark = db.query(
    `INSERT INTO ingest_watermark (replica_id, max_seq) VALUES (?, ?)
     ON CONFLICT(replica_id) DO UPDATE SET max_seq = MAX(max_seq, excluded.max_seq)`,
  );

  const ingest = (event: AcceptedEvent): boolean => {
    if (
      typeof event?.dot?.replicaId !== 'string' ||
      typeof event.dot.seq !== 'number' ||
      typeof event.acceptedAtMs !== 'number'
    ) {
      return false;
    }
    const { replicaId, seq } = event.dot;
    const observedAt = new Date(event.acceptedAtMs).toISOString();
    let indexed = false;

    if (event.type === CAPTURE_RECORDED && isCaptureRecordedPayload(event.payload)) {
      const p = event.payload;
      const text = captureDocText(p.turns ?? []);
      if (text.length > 0) {
        const threadKey = p.threadId ?? p.bac_id;
        insertDoc.run(
          replicaId,
          seq,
          'capture' satisfies CaptureTextDocKind,
          p.bac_id,
          nodeIdFor('thread', threadKey),
          CAPTURE_RECORDED,
          observedAt,
          text,
        );
        indexed = true;
      }
    } else if (event.type === DISPATCH_RECORDED && isDispatchRecordedPayload(event.payload)) {
      const p = event.payload;
      if (typeof p.body === 'string' && p.body.length > 0) {
        insertDoc.run(
          replicaId,
          seq,
          'dispatch' satisfies CaptureTextDocKind,
          p.bac_id,
          nodeIdFor('dispatch', p.bac_id),
          DISPATCH_RECORDED,
          observedAt,
          p.body,
        );
        indexed = true;
      }
    } else if (event.type === ANNOTATION_CREATED && isAnnotationCreatedPayload(event.payload)) {
      const p = event.payload;
      if (typeof p.note === 'string' && p.note.length > 0) {
        insertDoc.run(
          replicaId,
          seq,
          'annotation' satisfies CaptureTextDocKind,
          p.bac_id,
          nodeIdFor('annotation', p.bac_id),
          ANNOTATION_CREATED,
          observedAt,
          p.note,
        );
        indexed = true;
      }
    }

    // Watermark advances for EVERY event so catchUp can skip the
    // whole log tail, not just text-bearing events.
    bumpWatermark.run(replicaId, seq);
    return indexed;
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
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return count;
  };

  const allDocRows = (): readonly DocRow[] =>
    db
      .query(
        `SELECT replica_id, seq, doc_kind, doc_id, node_id, event_type, observed_at, text
         FROM capture_text_doc`,
      )
      .all() as readonly DocRow[];

  // trigram MATCH silently under-recalls below this length (verified
  // empirically: a 1- or 2-character search term returns zero rows
  // even when the substring is present) — see module comment. Below
  // it, `matchWholeWord` falls back to a full scan. Counted by
  // codepoint (not UTF-16 code unit) so a surrogate-pair character
  // doesn't get double-counted into "long enough".
  const TRIGRAM_MIN_LENGTH = 3;

  const ftsSubstringCandidateRows = (normalizedQuery: string): readonly DocRow[] => {
    // The ENTIRE normalized query as one quoted phrase — a literal
    // substring test against the trigram index (see module comment
    // for why this is a safe, never-under-recalling superset).
    // Internal quotes are escaped by doubling per FTS5 string-literal
    // rules (same pattern as recall-v2/store/sqlite.ts's escapeFts5Query).
    const matchExpr = `"${normalizedQuery.replace(/"/g, '""')}"`;
    const rows = db
      .query(
        `SELECT d.replica_id, d.seq, d.doc_kind, d.doc_id, d.node_id, d.event_type, d.observed_at, d.text
         FROM capture_text_doc d
         JOIN capture_text_fts f ON d.rowid = f.rowid
         WHERE capture_text_fts MATCH ?`,
      )
      .all(matchExpr);
    return rows as readonly DocRow[];
  };

  const matchWholeWord = (query: string): readonly CaptureTextMatch[] => {
    // Mirrors snapshot.ts Pass 6's `q.trim().toLowerCase()` applied to
    // the (already trim/lowercased) `metadata.searchQuery` value.
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) return [];
    const candidates =
      Array.from(normalized).length < TRIGRAM_MIN_LENGTH
        ? allDocRows()
        : ftsSubstringCandidateRows(normalized);
    const out: CaptureTextMatch[] = [];
    for (const row of candidates) {
      if (matchesWholeWordQuery(row.text, normalized)) {
        out.push(rowToMatch(row));
      }
    }
    out.sort((a, b) => {
      if (a.docKind !== b.docKind) return a.docKind < b.docKind ? -1 : 1;
      if (a.docId !== b.docId) return a.docId < b.docId ? -1 : 1;
      return 0;
    });
    return out;
  };

  const rebuildFromJsonl = async (logRoot: string): Promise<void> => {
    // True rebuild/repair: clear derived facts + watermark so stale
    // rows from a prior state can't survive. JSONL stays authoritative.
    // Recovery-only — see plan doc "Binding rule".
    db.exec(`
      DELETE FROM capture_text_doc;
      DELETE FROM ingest_watermark;
    `);
    let replicaDirs: string[];
    try {
      replicaDirs = await readdir(logRoot);
    } catch {
      return;
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
    matchWholeWord,
    rebuildFromJsonl,
    watermark,
    close: () => {
      db.close?.();
    },
  };
};
