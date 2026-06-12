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

import {
  listPageEvidenceRecordFiles,
  listPageEvidenceRecords,
  readPageEvidenceRecordByFileName,
} from '../../page-evidence/store.js';
import type { PageEvidenceRecord } from '../../page-evidence/types.js';
import { readIndex } from '../../recall/indexFile.js';
import { readSemanticRecallVectorStore } from '../../recall/semanticRecallPool.js';
import { RECALL_MODEL_ID as MODEL_ID } from '../../recall/modelManifest.js';
import type { PageEvidenceEmbedder } from '../../page-evidence/embedding.js';

// Lazy embedder: this module sits in http/server.ts's static import
// graph (server → recall-v2/pipeline → here), which must not pull
// recall/embedder.js (transformers/ONNX init) at import time per the
// /v1/status availability contract (statusContract.test.ts).
const defaultEmbed: PageEvidenceEmbedder = async (texts) =>
  (await import('../../recall/embedder.js')).embed(texts);
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
  const tListStart = Date.now();
  const records = await listPageEvidenceRecords(vaultRoot);
  const tList = Date.now() - tListStart;
  const tIngestStart = Date.now();
  const { pageContent, timelineVisit, upserted } = await ingestEvidenceRecords(
    vaultRoot,
    store,
    records,
  );
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

/** Upsert one batch of page-evidence records as docs rows. Shared by
 *  the full pass (all records) and the manifest-delta pass (changed
 *  records only). FU2 — chunked PARALLEL reads: each chunk fires its
 *  readJson() calls concurrently, then upsertDocument runs
 *  synchronously over the resolved data; yields per chunk keep the
 *  event loop responsive. Chunk size 50 ≈ 100 concurrent fds, plenty
 *  to saturate the page cache without thrashing. */
const ingestEvidenceRecords = async (
  vaultRoot: string,
  store: RecallStore,
  records: readonly PageEvidenceRecord[],
): Promise<{ pageContent: number; timelineVisit: number; upserted: Set<string> }> => {
  const upserted = new Set<string>();
  let pageContent = 0;
  let timelineVisit = 0;
  const READ_CHUNK_SIZE = 50;
  for (let start = 0; start < records.length; start += READ_CHUNK_SIZE) {
    const chunk = records.slice(start, start + READ_CHUNK_SIZE);
    type Enriched = {
      readonly record: PageEvidenceRecord;
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
  return { pageContent, timelineVisit, upserted };
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

// ── Record-level page-evidence delta ────────────────────────────
// The signature gate in pipeline.ts is all-or-nothing per phase: ONE
// changed page-evidence record re-ran the FULL pass — every record
// JSON re-read (observed live: pageEv.list 16.6 s) plus every chunk
// JSON re-read sequentially (chunkVec.read 10.7 s) on the main loop
// at boot. The manifest below makes the re-run O(changed): a
// readdir+stat pass diffs (name, mtimeMs, size) against the manifest
// persisted in the store, and only changed records are read/upserted;
// removed files delete their rows via the urls the manifest carries.
// The manifest lives in recall_metadata, so a recreated store has no
// manifest and self-heals with a full pass.

export const PAGE_EVIDENCE_MANIFEST_KEY = 'manifest_v1_page_evidence';

// name → `${mtimeMs}:${size}:${canonicalUrl}` (url may contain ':').
type EvidenceManifest = Record<string, string>;

const parseEvidenceManifest = (raw: string | undefined): EvidenceManifest | null => {
  if (raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'object' && value !== null ? (value as EvidenceManifest) : null;
  } catch {
    return null;
  }
};

const manifestUrlOf = (entry: string): string => entry.split(':').slice(2).join(':');

/** Scoped chunk + chunk-vector ingest for a set of changed records.
 *  Per-doc chunk rows are replaced; a record whose content was REMOVED
 *  (contentHash gone — e.g. re-extraction downgraded to metadata_only)
 *  has its chunk rows deleted, cascading their vectors. Orphaned
 *  vectors from replaced chunk sets are pruned by a global id diff —
 *  two SELECTs over ~1k ids, NOT a re-read of any JSON. */
const ingestChunksForRecords = async (
  vaultRoot: string,
  store: RecallStore,
  records: readonly PageEvidenceRecord[],
  embedder: PageEvidenceEmbedder,
): Promise<{ chunks: number; vectors: number }> => {
  if (records.length === 0) return { chunks: 0, vectors: 0 };
  // Content removed → the doc must stop serving body chunks.
  for (const record of records) {
    if (record.content?.contentHash === undefined) {
      store.deleteDocumentChunks(entityIdForUrl(record.canonicalUrl));
    }
  }
  const withHash = records.filter((r) => r.content?.contentHash !== undefined);
  if (withHash.length === 0) return { chunks: 0, vectors: 0 };
  // Snapshot BEFORE replacing rows: vectors for unchanged chunk ids
  // must survive (re-embedding them would waste the embedder budget).
  const existingVectors = store.vectorBackendAvailable
    ? store.allChunkVectorIds()
    : new Set<string>();
  const toEmbed: ChunkBackfillRow[] = [];
  let chunksN = 0;
  for (const record of withHash) {
    const contentHash = record.content?.contentHash;
    if (contentHash === undefined) continue;
    const documentEntityId = entityIdForUrl(record.canonicalUrl);
    // eslint-disable-next-line no-await-in-loop -- bounded by |changed records|
    const raw = await readJson<{ readonly chunks?: readonly PageContentChunk[] }>(
      pageContentChunksPath(vaultRoot, contentHash),
    );
    const chunks = raw?.chunks ?? [];
    const rows = chunks
      .map((chunk) => chunkRowForStore({ chunk, documentEntityId, embedText: chunkEmbedText(chunk) }))
      .sort((left, right) => left.chunkIndex - right.chunkIndex);
    store.runTransaction(() => {
      // upsertDocumentChunks replaces this doc's rows (vectors are
      // pruned by the orphan diff below, so unchanged ids keep theirs).
      store.upsertDocumentChunks(documentEntityId, rows);
    });
    chunksN += chunks.length;
    for (const chunk of chunks) {
      if (!existingVectors.has(chunk.id)) {
        toEmbed.push({ chunk, documentEntityId, embedText: chunkEmbedText(chunk) });
      }
    }
  }
  // Prune orphaned vectors: ids that had a vector but no longer have
  // a chunk row anywhere (their doc's chunk set changed).
  if (store.vectorBackendAvailable) {
    const liveChunkIds = store.allDocumentChunkIds();
    for (const id of existingVectors) {
      if (!liveChunkIds.has(id)) store.deleteChunkVector(id);
    }
  }
  let vectors = 0;
  if (store.vectorBackendAvailable && toEmbed.length > 0) {
    const EMBED_BATCH_SIZE = 32;
    for (let start = 0; start < toEmbed.length; start += EMBED_BATCH_SIZE) {
      const batch = toEmbed.slice(start, start + EMBED_BATCH_SIZE);
      // eslint-disable-next-line no-await-in-loop -- embedder is batched
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
      // eslint-disable-next-line no-await-in-loop -- yield between embed batches
      if (start + EMBED_BATCH_SIZE < toEmbed.length) await yieldToEventLoop();
    }
  }
  return { chunks: chunksN, vectors };
};

/** Stats for the manifest-delta pass. */
export interface PageEvidenceDeltaStats {
  readonly mode: 'full' | 'delta';
  readonly changed: number;
  readonly removed: number;
  readonly pageContent: number;
  readonly timelineVisit: number;
  readonly chunkVectors: number;
  readonly deleted: number;
  readonly timingMs: Record<string, number>;
}

/** Manifest-diffed page-evidence + chunk-vector backfill.
 *
 *  delta mode (manifest present): stat pass → read ONLY changed
 *  records → upsert docs + their chunks/vectors → delete docs of
 *  removed files. O(changed) JSON reads. When the caller's source
 *  signature moved but ZERO record files changed (the signature also
 *  spans page-content/by-url + chunks — body/chunk JSON can change
 *  without a record rewrite), `fullOnEmptyDelta` falls back to the
 *  full reconcile so that content is not silently skipped forever.
 *
 *  full mode (no manifest — fresh store or first run after this code
 *  lands): ONE listPageEvidenceRecords read feeds the doc ingest, the
 *  doc sweep, the chunk reconcile AND the manifest seed (record file
 *  names are sha256(canonicalUrl).json, so no re-read is needed —
 *  and the seed carries real urls, never '' placeholders that would
 *  leak rows on later deletion).
 *
 *  The manifest persists LAST: a crash mid-pass re-runs the same
 *  delta next time (all writes are idempotent upserts/deletes). */
export const backfillPageEvidenceDelta = async (
  vaultRoot: string,
  store: RecallStore,
  embedder: PageEvidenceEmbedder = defaultEmbed,
  options: { readonly fullOnEmptyDelta?: boolean } = {},
): Promise<PageEvidenceDeltaStats> => {
  const timingMs: Record<string, number> = {};
  let t = Date.now();
  const files = await listPageEvidenceRecordFiles(vaultRoot);
  timingMs['stat'] = Date.now() - t;
  const stored = parseEvidenceManifest(store.getRecallMetadata(PAGE_EVIDENCE_MANIFEST_KEY));

  const runFull = async (): Promise<PageEvidenceDeltaStats> => {
    // One records read shared by everything below.
    t = Date.now();
    const records = await listPageEvidenceRecords(vaultRoot);
    timingMs['list'] = Date.now() - t;
    t = Date.now();
    const existing = new Set<string>([
      ...store.allEntityIdsByKind('page_content'),
      ...store.allEntityIdsByKind('timeline_visit'),
    ]);
    const { pageContent, timelineVisit, upserted } = await ingestEvidenceRecords(
      vaultRoot,
      store,
      records,
    );
    timingMs['ingest'] = Date.now() - t;
    t = Date.now();
    let deleted = 0;
    await runInChunks(store, existing, (id) => {
      if (!upserted.has(id)) {
        // Cascades the doc's chunks + vectors.
        store.deleteDocument(id);
        deleted += 1;
      }
    });
    timingMs['sweep'] = Date.now() - t;
    t = Date.now();
    // ingestChunksForRecords over ALL records is the full chunk
    // reconcile: docs with content get their rows replaced, docs
    // without get their rows dropped, swept docs cascaded above, and
    // the orphan-vector diff prunes the rest.
    const chunkVec = await ingestChunksForRecords(vaultRoot, store, records, embedder);
    timingMs['chunks'] = Date.now() - t;
    t = Date.now();
    const statByName = new Map(files.map((f) => [f.name, f]));
    const seeded: EvidenceManifest = {};
    for (const record of records) {
      const name = `${sha256Hex(record.canonicalUrl)}.json`;
      const f = statByName.get(name);
      if (f === undefined) continue;
      seeded[name] = `${String(f.mtimeMs)}:${String(f.size)}:${record.canonicalUrl}`;
    }
    store.setRecallMetadata(PAGE_EVIDENCE_MANIFEST_KEY, JSON.stringify(seeded));
    timingMs['manifestSeed'] = Date.now() - t;
    return {
      mode: 'full',
      changed: files.length,
      removed: 0,
      pageContent,
      timelineVisit,
      chunkVectors: chunkVec.vectors,
      deleted,
      timingMs,
    };
  };

  if (stored === null) {
    return runFull();
  }

  // Delta mode.
  const next: EvidenceManifest = {};
  const changedNames: string[] = [];
  for (const f of files) {
    const prior = stored[f.name];
    const statKey = `${String(f.mtimeMs)}:${String(f.size)}:`;
    if (prior !== undefined && prior.startsWith(statKey)) {
      next[f.name] = prior;
    } else {
      changedNames.push(f.name);
    }
  }
  const liveNames = new Set(files.map((f) => f.name));
  const removedUrls: string[] = [];
  for (const [name, entry] of Object.entries(stored)) {
    if (liveNames.has(name)) continue;
    const url = manifestUrlOf(entry);
    if (url.length > 0) removedUrls.push(url);
  }

  if (changedNames.length === 0 && removedUrls.length === 0 && options.fullOnEmptyDelta === true) {
    // The caller only invokes this when the page-evidence source
    // signature moved — if no record file changed, the movement was in
    // page-content/by-url or chunks (body or chunk JSON written
    // without a record rewrite). Those aren't visible to the record
    // diff, so reconcile fully rather than mark the signature done
    // with the content silently unindexed.
    return runFull();
  }

  t = Date.now();
  const statByName = new Map(files.map((f) => [f.name, f]));
  const changedRecords: PageEvidenceRecord[] = [];
  const READ_CHUNK_SIZE = 50;
  for (let start = 0; start < changedNames.length; start += READ_CHUNK_SIZE) {
    const chunk = changedNames.slice(start, start + READ_CHUNK_SIZE);
    // eslint-disable-next-line no-await-in-loop -- chunked parallel reads
    const loaded = await Promise.all(
      chunk.map(async (name) => ({
        name,
        record: await readPageEvidenceRecordByFileName(vaultRoot, name),
      })),
    );
    for (const { name, record } of loaded) {
      const f = statByName.get(name);
      if (f === undefined) continue;
      if (record !== null) {
        next[name] = `${String(f.mtimeMs)}:${String(f.size)}:${record.canonicalUrl}`;
        changedRecords.push(record);
        continue;
      }
      // Read failed schema validation (corrupted rewrite) or raced
      // with a delete. The full pass drops such records and its sweep
      // removes their rows; mirror that — delete the doc via the url
      // the manifest knew, and CARRY that url forward so a later file
      // deletion can still resolve the entity. Recording '' here
      // would leak the row forever.
      const priorUrl = manifestUrlOf(stored[name] ?? '');
      if (priorUrl.length > 0) removedUrls.push(priorUrl);
      next[name] = `${String(f.mtimeMs)}:${String(f.size)}:${priorUrl}`;
    }
  }
  timingMs['read'] = Date.now() - t;

  t = Date.now();
  const { pageContent, timelineVisit } = await ingestEvidenceRecords(
    vaultRoot,
    store,
    changedRecords,
  );
  timingMs['ingest'] = Date.now() - t;

  t = Date.now();
  let deleted = 0;
  await runInChunks(store, removedUrls, (url) => {
    // deleteDocument cascades the doc's chunks + vectors.
    store.deleteDocument(entityIdForUrl(url));
    deleted += 1;
  });
  timingMs['remove'] = Date.now() - t;

  t = Date.now();
  const chunkVec = await ingestChunksForRecords(vaultRoot, store, changedRecords, embedder);
  timingMs['chunks'] = Date.now() - t;

  store.setRecallMetadata(PAGE_EVIDENCE_MANIFEST_KEY, JSON.stringify(next));
  return {
    mode: 'delta',
    changed: changedNames.length,
    removed: removedUrls.length,
    pageContent,
    timelineVisit,
    chunkVectors: chunkVec.vectors,
    deleted,
    timingMs,
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
