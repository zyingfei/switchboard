// Recall v2 — SQLite backfill from JSON sources of truth.
//
// On first /v2/recall (or test-harness) call, populate the SQLite
// docs table from the existing JSON files. The JSON files remain the
// source of truth (sync contract, replication, materializers all
// consume them). SQLite is a derived projection — rebuildable from
// JSON at any time. This is the same pattern as today's in-memory
// MiniSearch indexes, just durable.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { listPageEvidenceRecords } from '../../page-evidence/store.js';
import { readIndex } from '../../recall/indexFile.js';
import { readSemanticRecallVectorStore } from '../../recall/semanticRecallPool.js';
import { embed as defaultEmbed, MODEL_ID } from '../../recall/embedder.js';
import type { PageEvidenceEmbedder } from '../../page-evidence/embedding.js';
import type { PageContentChunk } from '../../page-content/types.js';
import type { RecallStore, StoreDocument, StoreDocumentChunk } from './types.js';

// Local readJson — page-content/store.ts has the same shape internally
// but doesn't export it. Inlined here to keep the SQLite backfill
// independent of that module's internals.
const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

// Mirrors page-content/store.ts:recordPathForCanonicalUrl + chunksDir.
// Inlined so we don't import store internals (and to keep backfill
// resilient to refactors in page-content/store.ts).
const sha256Hex = (input: string): string => createHash('sha256').update(input).digest('hex');
const pageContentRecordPath = (vaultRoot: string, canonicalUrl: string): string =>
  join(vaultRoot, '_BAC', 'page-content', 'by-url', `${sha256Hex(canonicalUrl)}.json`);
const pageContentChunksPath = (vaultRoot: string, contentHash: string): string =>
  join(vaultRoot, '_BAC', 'page-content', 'chunks', `${contentHash}.json`);

const entityIdForUrl = (url: string): string =>
  `url:${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
const entityIdForThread = (threadId: string): string => `thread:${threadId}`;

const slugTokensOf = (url: string): string => {
  try {
    return new URL(url).pathname.replace(/[/_-]+/g, ' ').trim();
  } catch {
    return url;
  }
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

const tsMs = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

/** Yield to the event loop so /v1/status, /v1/events, and other HTTP
 *  handlers can run between chunks of sync SQLite work. `setImmediate`
 *  is a real macrotask boundary (microtask flushes alone don't give
 *  timers / I/O a chance — see Codex review 2026-05-25). */
const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** Target slice budget — bun:sqlite upserts measure ~0.3-0.6ms each
 *  on hot path; 500 upserts inside a single BEGIN IMMEDIATE/COMMIT
 *  amortizes WAL fsync cost across the chunk. The transaction is
 *  short enough to keep readers from waiting more than ~100ms and
 *  stays well under the runtime's 250ms `[api.stall]` threshold. */
const DEFAULT_CHUNK_SIZE = 500;

/** Run a chunked write loop. Each chunk runs INSIDE a single
 *  transaction (BEGIN IMMEDIATE / COMMIT) on `store`, then yields to
 *  the event loop BETWEEN chunks. Per-row autocommit would fsync per
 *  row; chunking into ~500-row commits cuts write overhead by an
 *  order of magnitude while keeping each transaction short enough
 *  that /status and other handlers can run between them.
 *
 *  Codex review 2026-05-25: "Prefer BEGIN IMMEDIATE / COMMIT per
 *  chunk, rollback on chunk failure, then setImmediate after commit.
 *  That gives amortized writes without yielding inside a
 *  transaction." */
const runInChunks = async <T>(
  store: RecallStore,
  items: Iterable<T>,
  apply: (item: T) => void,
  chunkSize = DEFAULT_CHUNK_SIZE,
): Promise<number> => {
  const arr = Array.from(items);
  let n = 0;
  for (let start = 0; start < arr.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, arr.length);
    store.runTransaction(() => {
      for (let i = start; i < end; i += 1) {
        apply(arr[i]!);
        n += 1;
      }
    });
    if (end < arr.length) {
      // Yield BETWEEN chunks, never inside the transaction (would
      // hold the write lock across event-loop turns).
      await yieldToEventLoop();
    }
  }
  return n;
};

/** Backfill timeline-visit + page-content rows from page-evidence
 *  records. Every visited URL becomes a row; body_indexed=1 when the
 *  record carries content (Readability succeeded), else body-only row
 *  surfaces as a timeline-visit hit. Sweeps stale rows whose source
 *  JSON disappeared (Codex re-review F1 partial / F10). */
export const backfillFromPageEvidence = async (
  vaultRoot: string,
  store: RecallStore,
): Promise<{
  pageContent: number;
  timelineVisit: number;
  deleted: number;
  timingMs: Record<string, number>;
}> => {
  // Snapshot existing IDs for these two source kinds so we can sweep
  // rows whose page-evidence record was deleted between backfills.
  const t0 = Date.now();
  const existing = new Set<string>([
    ...store.allEntityIdsByKind('page_content'),
    ...store.allEntityIdsByKind('timeline_visit'),
  ]);
  const tSnapshot = Date.now() - t0;
  const upserted = new Set<string>();
  const tListStart = Date.now();
  const records = await listPageEvidenceRecords(vaultRoot);
  const tList = Date.now() - tListStart;
  let pageContent = 0;
  let timelineVisit = 0;
  const root = join(vaultRoot, '_BAC', 'page-content', 'by-url');
  const tIngestStart = Date.now();
  // FU2 — chunked PARALLEL reads. Was: sequential await readJson()
  // per record (2 reads per record = N×2 serial filesystem ops).
  // For 1000 URLs on SSD that's ~2-4s of I/O wall-clock; on slower
  // disks it's much worse. Now each chunk fires all its readJson()
  // calls concurrently via Promise.all, then upsertDocument runs
  // synchronously over the resolved data. Yields still happen
  // per-chunk so the event loop stays responsive.
  //
  // Chunk size kept small (50) for the parallel-reads pass because
  // ~100 concurrent file descriptors is plenty to saturate the OS
  // page cache without thrashing.
  const READ_CHUNK_SIZE = 50;
  for (let start = 0; start < records.length; start += READ_CHUNK_SIZE) {
    const chunk = records.slice(start, start + READ_CHUNK_SIZE);
    type Enriched = {
      readonly record: (typeof records)[number];
      readonly contentHash: string | undefined;
      readonly body: string | undefined;
    };
    const enriched = await Promise.all(
      chunk.map(async (r): Promise<Enriched> => {
        let body: string | undefined;
        let contentHash: string | undefined = r.content?.contentHash;
        if (contentHash === undefined) {
          // Fallback: read the page-content row directly to get the hash.
          const rec = await readJson<{ readonly coverage?: { readonly contentHash?: string } }>(
            pageContentRecordPath(vaultRoot, r.canonicalUrl),
          );
          contentHash = rec?.coverage?.contentHash;
        }
        if (contentHash !== undefined) {
          const raw = await readJson<{ readonly chunks?: readonly { readonly text: string }[] }>(
            pageContentChunksPath(vaultRoot, contentHash),
          );
          const chunks = raw?.chunks;
          if (chunks !== undefined && chunks.length > 0) {
            body = chunks.map((c) => c.text).join('\n\n');
          }
        }
        return { record: r, contentHash, body };
      }),
    );
    for (const { record: r, contentHash, body } of enriched) {
      const url = r.canonicalUrl;
      const first = tsMs(r.metadata.firstSeenAt);
      const last = tsMs(r.metadata.lastSeenAt);
      const baseDoc: Omit<StoreDocument, 'bodyIndexed' | 'sourceKind' | 'entityId'> = {
        canonicalUrl: url,
        ...(r.metadata.title === undefined ? {} : { title: r.metadata.title }),
        urlTokens: slugTokensOf(url),
        host: hostOf(url),
        ...(first === undefined ? {} : { firstSeenAtMs: first }),
        ...(last === undefined ? {} : { lastSeenAtMs: last }),
      };
      const entityId = entityIdForUrl(url);
      if (body !== undefined) {
        store.upsertDocument({
          ...baseDoc,
          entityId,
          sourceKind: 'page_content',
          body,
          ...(contentHash === undefined ? {} : { contentHash }),
          bodyIndexed: 1,
        });
        pageContent += 1;
      } else {
        store.upsertDocument({
          ...baseDoc,
          entityId,
          sourceKind: 'timeline_visit',
          bodyIndexed: 0,
        });
        timelineVisit += 1;
      }
      upserted.add(entityId);
    }
    await yieldToEventLoop();
  }
  const tIngest = Date.now() - tIngestStart;
  // Sweep stale rows — entity_ids in `existing` but not `upserted`
  // had their JSON source disappear (file removed, tombstoned, etc.).
  const tSweepStart = Date.now();
  let deleted = 0;
  await runInChunks(store, existing, (id) => {
    if (!upserted.has(id)) {
      store.deleteDocument(id);
      deleted += 1;
    }
  });
  const tSweep = Date.now() - tSweepStart;
  // Mark unused `root` var so the linter is happy (kept the join for
  // future expansion when we read chunks lazily).
  void root;
  return {
    pageContent,
    timelineVisit,
    deleted,
    timingMs: {
      snapshot: tSnapshot,
      list: tList,
      ingest: tIngest,
      sweep: tSweep,
    },
  };
};

/** Backfill chat-turn rows from the recall index. Each turn becomes
 *  one document; body is the turn text. Sweeps stale chat rows whose
 *  recall index entries were tombstoned / removed. */
export const backfillFromRecallIndex = async (
  vaultRoot: string,
  store: RecallStore,
): Promise<{ chatTurn: number; deleted: number; timingMs: Record<string, number> }> => {
  const t0 = Date.now();
  const existing = new Set<string>(store.allEntityIdsByKind('chat_turn'));
  const tSnapshot = Date.now() - t0;
  const upserted = new Set<string>();
  const indexPath = join(vaultRoot, '_BAC', 'recall', 'index.bin');
  const tReadStart = Date.now();
  const index = await readIndex(indexPath);
  const tRead = Date.now() - tReadStart;
  if (index === null || index.items.length === 0) {
    // No chat-turn data at all → sweep everything previously stored.
    const tSweepStart = Date.now();
    const deleted = await runInChunks(store, existing, (id) => store.deleteDocument(id));
    return {
      chatTurn: 0,
      deleted,
      timingMs: { snapshot: tSnapshot, read: tRead, sweep: Date.now() - tSweepStart },
    };
  }
  const tUpsertStart = Date.now();
  // Pre-materialize the items we'll touch so the per-chunk loop is
  // pure sync work — no metadata-extraction overhead inside the tick.
  const toUpsert: { entityId: string; doc: StoreDocument }[] = [];
  for (const item of index.items) {
    if (item.tombstoned === true) continue;
    const meta = item.metadata;
    if (meta === undefined) continue;
    const text = meta.text;
    if (text === undefined || text.length === 0) continue;
    const capturedMs = tsMs(item.capturedAt);
    const entityId = `chat:${item.id}`;
    toUpsert.push({
      entityId,
      doc: {
        entityId,
        sourceKind: 'chat_turn',
        ...(meta.threadUrl === undefined ? {} : { canonicalUrl: meta.threadUrl }),
        ...(meta.title === undefined ? {} : { title: meta.title }),
        body: text,
        threadId: item.threadId,
        ...(capturedMs === undefined
          ? {}
          : { firstSeenAtMs: capturedMs, lastSeenAtMs: capturedMs }),
        bodyIndexed: 1,
      },
    });
  }
  const count = await runInChunks(store, toUpsert, ({ entityId, doc }) => {
    store.upsertDocument(doc);
    upserted.add(entityId);
  });
  const tUpsert = Date.now() - tUpsertStart;
  const tSweepStart = Date.now();
  let deleted = 0;
  await runInChunks(store, existing, (id) => {
    if (!upserted.has(id)) {
      store.deleteDocument(id);
      deleted += 1;
    }
  });
  const tSweep = Date.now() - tSweepStart;
  return {
    chatTurn: count,
    deleted,
    timingMs: { snapshot: tSnapshot, read: tRead, upsert: tUpsert, sweep: tSweep },
  };
};

/** Backfill vectors from the existing JSON sidecar into docs_vec.
 *  Sweeps docs_vec rows whose source vectors were removed from the
 *  JSON sidecar (Codex re-review N2). Only runs when sqlite-vec is
 *  available; otherwise a no-op. */
export const backfillVectors = async (
  vaultRoot: string,
  store: RecallStore,
): Promise<{ vectors: number; deleted: number; timingMs: Record<string, number> }> => {
  if (!store.vectorBackendAvailable) {
    return { vectors: 0, deleted: 0, timingMs: {} };
  }
  const t0 = Date.now();
  const existing = store.allVectorEntityIds();
  const tSnapshot = Date.now() - t0;
  const upserted = new Set<string>();
  const tReadStart = Date.now();
  const vectors = await readSemanticRecallVectorStore(vaultRoot, MODEL_ID);
  const tRead = Date.now() - tReadStart;
  let n = 0;
  let tUpsert = 0;
  if (vectors !== null) {
    const tUpsertStart = Date.now();
    n = await runInChunks(store, vectors, ([url, vec]) => {
      const entityId = entityIdForUrl(url);
      store.upsertVector(entityId, vec);
      upserted.add(entityId);
    });
    tUpsert = Date.now() - tUpsertStart;
  }
  const tSweepStart = Date.now();
  let deleted = 0;
  await runInChunks(store, existing, (id) => {
    if (!upserted.has(id)) {
      store.deleteVector(id);
      deleted += 1;
    }
  });
  const tSweep = Date.now() - tSweepStart;
  return {
    vectors: n,
    deleted,
    timingMs: { snapshot: tSnapshot, read: tRead, upsert: tUpsert, sweep: tSweep },
  };
};

interface ChunkBackfillRow {
  readonly chunk: PageContentChunk;
  readonly documentEntityId: string;
  readonly embedText: string;
}

const chunkRowForStore = (item: ChunkBackfillRow): StoreDocumentChunk => ({
  chunkId: item.chunk.id,
  documentEntityId: item.documentEntityId,
  chunkIndex: item.chunk.chunkIndex,
  charStart: item.chunk.charStart,
  charEnd: item.chunk.charEnd,
  text: item.chunk.text,
  evidenceTermsJson: JSON.stringify(item.chunk.terms ?? []),
  quality: item.chunk.quality,
});

const chunkEmbedText = (chunk: PageContentChunk): string => {
  const title = chunk.title?.trim();
  return `passage: ${title === undefined || title.length === 0 ? chunk.text : `${title}\n\n${chunk.text}`}`;
};

/** Backfill canonical page-content chunk rows and per-chunk vectors.
 *  This is idempotent: chunk rows are replaced per document, existing
 *  chunk vectors are skipped, and stale chunk rows/vectors are swept at
 *  the end. A killed process can resume without re-embedding chunks
 *  already persisted in documents_chunks_vec. */
export const backfillChunkVectors = async (
  vaultRoot: string,
  store: RecallStore,
  embedder: PageEvidenceEmbedder = defaultEmbed,
): Promise<{
  chunks: number;
  vectors: number;
  deleted: number;
  timingMs: Record<string, number>;
}> => {
  const t0 = Date.now();
  const existingChunks = store.allDocumentChunkIds();
  const existingVectors = store.allChunkVectorIds();
  const tSnapshot = Date.now() - t0;
  const upsertedChunkIds = new Set<string>();
  const tReadStart = Date.now();
  const records = await listPageEvidenceRecords(vaultRoot);
  const items: ChunkBackfillRow[] = [];
  for (const record of records) {
    const contentHash = record.content?.contentHash;
    if (contentHash === undefined) continue;
    const raw = await readJson<{ readonly chunks?: readonly PageContentChunk[] }>(
      pageContentChunksPath(vaultRoot, contentHash),
    );
    const chunks = raw?.chunks ?? [];
    const documentEntityId = entityIdForUrl(record.canonicalUrl);
    for (const chunk of chunks) {
      items.push({
        chunk,
        documentEntityId,
        embedText: chunkEmbedText(chunk),
      });
      upsertedChunkIds.add(chunk.id);
    }
  }
  const tRead = Date.now() - tReadStart;

  const tRowsStart = Date.now();
  const rowsByDocument = new Map<string, StoreDocumentChunk[]>();
  for (const item of items) {
    const rows = rowsByDocument.get(item.documentEntityId) ?? [];
    rows.push(chunkRowForStore(item));
    rowsByDocument.set(item.documentEntityId, rows);
  }
  store.runTransaction(() => {
    for (const [documentEntityId, rows] of rowsByDocument) {
      store.upsertDocumentChunks(
        documentEntityId,
        [...rows].sort((left, right) => left.chunkIndex - right.chunkIndex),
      );
    }
  });
  const tRows = Date.now() - tRowsStart;

  let vectors = 0;
  let tEmbed = 0;
  if (store.vectorBackendAvailable) {
    const tEmbedStart = Date.now();
    const missing = items.filter((item) => !existingVectors.has(item.chunk.id));
    const EMBED_BATCH_SIZE = 32;
    for (let start = 0; start < missing.length; start += EMBED_BATCH_SIZE) {
      const batch = missing.slice(start, start + EMBED_BATCH_SIZE);
      const embedded = await embedder(batch.map((item) => item.embedText));
      store.runTransaction(() => {
        for (let index = 0; index < batch.length; index += 1) {
          const item = batch[index];
          const vector = embedded[index];
          if (item === undefined || vector === undefined || vector.length === 0) continue;
          store.upsertChunkVector(item.chunk.id, vector);
          vectors += 1;
        }
      });
      if (start + EMBED_BATCH_SIZE < missing.length) await yieldToEventLoop();
    }
    tEmbed = Date.now() - tEmbedStart;
  }

  const tSweepStart = Date.now();
  let deleted = 0;
  await runInChunks(store, existingChunks, (chunkId) => {
    if (!upsertedChunkIds.has(chunkId)) {
      store.deleteDocumentChunk(chunkId);
      deleted += 1;
    }
  });
  await runInChunks(store, existingVectors, (chunkId) => {
    if (!upsertedChunkIds.has(chunkId)) {
      store.deleteChunkVector(chunkId);
    }
  });
  const tSweep = Date.now() - tSweepStart;
  return {
    chunks: items.length,
    vectors,
    deleted,
    timingMs: { snapshot: tSnapshot, read: tRead, rows: tRows, embed: tEmbed, sweep: tSweep },
  };
};

/** Result type for backfillRecallStore. */
export interface BackfillStats {
  readonly pageContent: number;
  readonly timelineVisit: number;
  readonly chatTurn: number;
  readonly vectors: number;
  readonly chunkVectors: number;
  readonly deleted: number;
  /** Per-phase wall-clock ms. Surfaced via the [recall-v2] log line so
   *  /v1/status starvation regressions can be triaged without
   *  guessing which phase blocked the loop. */
  readonly timingMs: Record<string, number>;
}

/** Run all three backfill phases unconditionally. For per-source
 *  freshness logic that only runs the phase whose source moved, see
 *  the caller in pipeline.ts:ensureFreshBackfill. */
export const backfillRecallStore = async (
  vaultRoot: string,
  store: RecallStore,
): Promise<BackfillStats> => {
  const evidence = await backfillFromPageEvidence(vaultRoot, store);
  const chat = await backfillFromRecallIndex(vaultRoot, store);
  const vec = await backfillVectors(vaultRoot, store);
  const chunkVec = await backfillChunkVectors(vaultRoot, store);
  return {
    pageContent: evidence.pageContent,
    timelineVisit: evidence.timelineVisit,
    chatTurn: chat.chatTurn,
    vectors: vec.vectors,
    chunkVectors: chunkVec.vectors,
    deleted: evidence.deleted + chat.deleted + vec.deleted + chunkVec.deleted,
    timingMs: {
      ...Object.fromEntries(Object.entries(chat.timingMs).map(([k, v]) => [`chat.${k}`, v])),
      ...Object.fromEntries(Object.entries(vec.timingMs).map(([k, v]) => [`vec.${k}`, v])),
      ...Object.fromEntries(
        Object.entries(chunkVec.timingMs).map(([k, v]) => [`chunkVec.${k}`, v]),
      ),
    },
  };
};

/** Quick check: does the store have ANY rows? Used to skip backfill on
 *  warm starts. */
export const recallStoreIsEmpty = (store: RecallStore): boolean => store.documentCount() === 0;

/** Per-source freshness signatures.
 *
 *  Split into three keys so a fresh page-evidence write doesn't force
 *  the chat-turn (7k+ items) or vector (1k+ items) backfill to re-run.
 *  Each phase compares its own signature and only re-runs when ITS
 *  source files moved.
 *
 *  Why split (Codex review 2026-05-25):
 *    Before this, any new page visit bumped the combined signature
 *    and forced backfillFromRecallIndex + backfillVectors. Each runs
 *    a tight sync upsert loop (7791 / 1275 rows) — together a 5-6 s
 *    single-tick event-loop block. Under SW reload + concurrent
 *    /v2/recall calls + connections-drain, this compounded into the
 *    41.6 s `/v1/status` timeout the user hit. */
export interface SourceSignatures {
  readonly pageEvidence: string;
  readonly chatTurn: string;
  readonly vectors: string;
}

const sigForPaths = async (paths: readonly string[]): Promise<string> => {
  const parts: string[] = [];
  for (const path of paths) {
    try {
      const s = await stat(path);
      // mtimeMs has ~ms precision on macOS/Linux — sufficient for the
      // staleness check at /v2/recall granularity (typed-into-query
      // gaps are seconds at minimum).
      parts.push(`${path}:${String(Math.trunc(s.mtimeMs))}:${String(s.size)}`);
    } catch {
      parts.push(`${path}:absent`);
    }
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
};

export const computeSourceSignatures = async (vaultRoot: string): Promise<SourceSignatures> => ({
  pageEvidence: await sigForPaths([
    join(vaultRoot, '_BAC', 'page-evidence', 'by-url'),
    join(vaultRoot, '_BAC', 'page-content', 'by-url'),
    join(vaultRoot, '_BAC', 'page-content', 'chunks'),
  ]),
  chatTurn: await sigForPaths([join(vaultRoot, '_BAC', 'recall')]),
  vectors: await sigForPaths([join(vaultRoot, '_BAC', 'recall', 'semantic-pool', 'vectors.json')]),
});

/** @deprecated kept for backward compat; prefer computeSourceSignatures.
 *  Combined hash of all three for callers that only need a coarse "any
 *  source moved" signal. */
export const computeSourceSignature = async (vaultRoot: string): Promise<string> => {
  const s = await computeSourceSignatures(vaultRoot);
  return createHash('sha256')
    .update(`${s.pageEvidence}|${s.chatTurn}|${s.vectors}`)
    .digest('hex')
    .slice(0, 32);
};

export const SOURCE_SIGNATURE_KEY = 'source_signature_v1';
