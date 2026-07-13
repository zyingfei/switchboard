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

export interface StoreDocumentChunk {
  readonly chunkId: string;
  readonly documentEntityId: string;
  readonly chunkIndex: number;
  readonly charStart: number;
  readonly charEnd: number;
  readonly text: string;
  readonly evidenceTermsJson: string;
  readonly quality: string;
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

  /** Direct lookup by canonical_url — used by the `focus` source so
   *  the Now card can surface the active page's own row plus same-URL
   *  variants (e.g. the page_content extract + the timeline_visit it
   *  came from). Returns rows from every source kind whose
   *  canonical_url matches exactly; caller filters/picks. Bypasses
   *  FTS5 so URL punctuation doesn't trip the tokenizer. Returns []
   *  when no rows match. */
  queryByCanonicalUrl(opts: {
    readonly canonicalUrl: string;
    readonly limit: number;
  }): readonly StoreFtsHit[];

  /** Total document count for a source kind — used by query-analysis
   *  for IDF estimation later. */
  documentCount(sourceKind?: StoreSourceKind): number;

  /** Delete by entityId. No-op if missing. */
  deleteDocument(entityId: string): void;

  /** Privacy purge — delete every document (and its vectors + chunks)
   *  whose `host` belongs to the eTLD+1 family `domain` (host === domain
   *  OR host endsWith `.domain`). Used by the domain-tombstone purge so
   *  a blocked site's captured recall entries are hard-removed from the
   *  derived store, not just hidden at serve. Returns the number of
   *  document rows deleted. No-op returning 0 when nothing matches.
   *  Optional so lightweight test stubs don't have to implement it; the
   *  purge path treats absence as "no vector deletion available". */
  deleteDocumentsByHostFamily?(domain: string): number;

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

  /** Replace the canonical chunk rows for one document. */
  upsertDocumentChunks(documentEntityId: string, chunks: readonly StoreDocumentChunk[]): void;

  /** Delete chunk rows and chunk vectors for a document. */
  deleteDocumentChunks(documentEntityId: string): void;

  /** Delete one chunk row and its vector. */
  deleteDocumentChunk(chunkId: string): void;

  /** Enumerate chunk ids currently persisted in documents_chunks. */
  allDocumentChunkIds(): ReadonlySet<string>;

  /** Delete one chunk vector. No-op when vec is unavailable. */
  deleteChunkVector(chunkId: string): void;

  /** Enumerate every chunk_id currently in documents_chunks_vec. */
  allChunkVectorIds(): ReadonlySet<string>;

  /** Run `fn` inside a single SQLite transaction (BEGIN IMMEDIATE …
   *  COMMIT). Used by backfill to amortize per-row autocommit
   *  overhead — without this, 7000+ upserts in a chunk each fsync
   *  the WAL, dominating the backfill cost. Rolls back + rethrows
   *  if `fn` throws. */
  runTransaction<T>(fn: () => T): T;

  /** Read a stored metadata value. Used by the freshness check —
   *  `getRecallMetadata('source_signature')` returns the signature of
   *  the JSON sources captured at last backfill. */
  getRecallMetadata(key: string): string | undefined;
  setRecallMetadata(key: string, value: string): void;

  /** Upsert a vector for an existing entity. No-op if the entity row
   *  doesn't exist (vectors are derived; the parent doc rules). */
  upsertVector(entityId: string, vec: Float32Array): void;

  /** Upsert a per-page-content chunk vector. */
  upsertChunkVector(chunkId: string, vec: Float32Array): void;

  /** Vector KNN — top-K nearest by cosine distance (lower = closer).
   *  Joins back to the docs table so callers receive canonical_url +
   *  title in one round-trip. `bodyIndexed` mirrors the docs column
   *  (1 = content vector, 0 = title+URL only) so callers can tell a
   *  content-derived hit from a title-only one. This method does NOT
   *  influence ranking — ordering is always by cosine distance.
   *  Provenance down-weighting of title-only hits happens at the CALLER
   *  (`generateSemanticQuery`), behind `SIDETRACK_RECALL_PROVENANCE_
   *  DOWNWEIGHT` (default OFF by eval verdict; ADR-0011 amendment
   *  2026-07-12c). */
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
  }[];

  /** Chunk-vector KNN with doc-level max-chunk pooling. Runs the KNN
   *  over `documents_chunks_vec` (content passages), maps each hit chunk
   *  back to its parent document via `documents_chunks`, then pools per
   *  document keeping the BEST chunk (MIN cosine distance == MAX cosine
   *  similarity). Returns the same doc-level shape as `queryVector` plus
   *  `pooledChunkCount` (how many of this doc's chunks landed in the KNN
   *  frontier — a coarse density signal for diagnostics). `bodyIndexed`
   *  is ~always 1 here since only content docs have chunk vectors.
   *
   *  Preferred over `queryVector` (whole-doc average) where clean chunk
   *  vectors exist because passage-level retrieval finds the specific
   *  section that matches the query rather than the doc centroid. It is
   *  a NO-OP returning [] when the vec backend is unavailable, so callers
   *  can fall back to `queryVector` / the JSON sidecar. Gated at the
   *  caller behind `SIDETRACK_RECALL_CHUNK_VECTORS` (P1 freeze; default
   *  by eval verdict) — the store method itself is always available. */
  queryChunkVector(opts: {
    readonly vec: Float32Array;
    readonly limit: number;
    readonly excludeEntityIds?: ReadonlySet<string>;
  }): readonly {
    readonly entityId: string;
    readonly canonicalUrl: string | undefined;
    readonly title: string | undefined;
    readonly cosineDistance: number;
    readonly bodyIndexed: 0 | 1;
    readonly pooledChunkCount: number;
  }[];

  close(): void;
}
