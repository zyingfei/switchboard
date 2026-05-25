// Extension OPFS local recall — Phase 10.
//
// SQLite WASM + FTS5 inside the extension, persisted via OPFS. Used as
// a fallback when the companion is offline or slow to respond. Index
// is populated from timeline visit events (navigation, tab activation)
// so a fresh visit lands in the local store before the companion sees
// it.
//
// Same shape as the companion's RecallStore so the popover/submode
// can consume both interchangeably; only difference is local store
// holds title+URL+host (no body extraction; that lives on the
// companion).

export interface LocalCandidate {
  readonly entityId: string;
  readonly canonicalUrl: string;
  readonly title?: string;
  readonly host?: string;
  readonly firstSeenAtMs?: number;
  readonly lastSeenAtMs?: number;
  readonly bm25: number;
}

export interface LocalRecallStore {
  /** Idempotent visit ingest — upsert on canonical URL. */
  recordVisit(input: {
    readonly canonicalUrl: string;
    readonly title?: string;
    readonly seenAtMs?: number;
  }): Promise<void>;

  /** Top-K lexical lookup via FTS5 BM25 over title+url+host. */
  query(input: { readonly q: string; readonly limit: number }): Promise<readonly LocalCandidate[]>;

  /** Lifecycle. close() flushes pending writes; useful on SW restart. */
  ready(): Promise<void>;
  close(): Promise<void>;
}
