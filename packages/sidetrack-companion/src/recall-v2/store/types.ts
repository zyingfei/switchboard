// Recall v2 — RecallStore interface.
//
// Wraps the durable retrieval primitives (FTS5 lexical, sqlite-vec for
// vectors later) behind a single TS contract. The pipeline owns
// product policy (fusion, suppression, evidence); the store owns the
// retrieval mechanics.
//
// Phase P2 scope: page-content / timeline-visit / chat-turn lexical
// migrate from MiniSearch to SQLite FTS5. The semantic vector store
// stays as-is (existing sidecar JSON works); sqlite-vec adoption is a
// follow-up once the FTS5 side is proven.

export type StoreSourceKind = 'page_content' | 'timeline_visit' | 'chat_turn';

/** A document row as stored in the SQLite docs table. */
export interface StoreDocument {
  readonly entityId: string;
  readonly sourceKind: StoreSourceKind;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly body?: string;
  readonly urlTokens?: string;
  readonly host?: string;
  readonly firstSeenAtMs?: number;
  readonly lastSeenAtMs?: number;
  readonly threadId?: string;
  readonly contentHash?: string;
  /** 1 when body extracted; 0 when title+URL only (timeline-visit). */
  readonly bodyIndexed: 0 | 1;
}

/** A single FTS5 hit. Score is BM25 (negative is better in bun:sqlite's
 *  bm25() ranking column — we'll convert to higher-is-better). */
export interface StoreFtsHit {
  readonly entityId: string;
  readonly sourceKind: StoreSourceKind;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly threadId?: string;
  readonly bm25: number; // higher = better (we invert SQLite's bm25())
  readonly capturedAtMs?: number;
}

export interface RecallStore {
  /** Whether sqlite-vec loaded successfully on this store. When false,
   *  upsertVector is a no-op and queryVector returns []. */
  readonly vectorBackendAvailable: boolean;

  /** Upsert a document. Triggers the FTS5 index automatically. */
  upsertDocument(doc: StoreDocument): void;

  /** FTS5 lexical query. `q` is a free-text query (extension expressions
   *  composed by the pipeline's query-analysis layer go in as
   *  whitespace-joined tokens; FTS5 implicit AND/OR is column-default).
   *  Returns top-K by inverted BM25. */
  queryFts(opts: {
    readonly q: string;
    readonly sourceKind: StoreSourceKind | readonly StoreSourceKind[];
    readonly limit: number;
  }): readonly StoreFtsHit[];

  /** Total document count for a source kind — used by query-analysis
   *  for IDF estimation later. */
  documentCount(sourceKind?: StoreSourceKind): number;

  /** Delete by entityId. No-op if missing. */
  deleteDocument(entityId: string): void;

  /** Enumerate every entity_id currently stored for `sourceKind`. Used
   *  by the backfill deletion sweep — backfill snapshots this set,
   *  upserts every record in JSON, then deletes entityIds in the
   *  snapshot but not in the upsert set (rows whose source files
   *  disappeared). Returned as a Set so the diff is cheap. */
  allEntityIdsByKind(sourceKind: StoreSourceKind): ReadonlySet<string>;

  /** Delete the entity_id from docs_vec (no-op when vec disabled).
   *  Used by the deletion sweep for vectors. */
  deleteVector(entityId: string): void;

  /** Enumerate every entity_id currently in docs_vec. */
  allVectorEntityIds(): ReadonlySet<string>;

  /** Read a stored metadata value. Used by the freshness check —
   *  `getRecallMetadata('source_signature')` returns the signature of
   *  the JSON sources captured at last backfill. */
  getRecallMetadata(key: string): string | undefined;
  setRecallMetadata(key: string, value: string): void;

  /** Upsert a vector for an existing entity. No-op if the entity row
   *  doesn't exist (vectors are derived; the parent doc rules). */
  upsertVector(entityId: string, vec: Float32Array): void;

  /** Vector KNN — top-K nearest by cosine distance (lower = closer).
   *  Joins back to the docs table so callers receive canonical_url +
   *  title in one round-trip. */
  queryVector(opts: {
    readonly vec: Float32Array;
    readonly limit: number;
    readonly excludeEntityIds?: ReadonlySet<string>;
  }): readonly {
    readonly entityId: string;
    readonly canonicalUrl: string | undefined;
    readonly title: string | undefined;
    readonly cosineDistance: number;
  }[];

  close(): void;
}
