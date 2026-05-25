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
import {
  readSemanticRecallVectorStore,
} from '../../recall/semanticRecallPool.js';
import { MODEL_ID } from '../../recall/embedder.js';
import type { RecallStore, StoreDocument } from './types.js';

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
const sha256Hex = (input: string): string =>
  createHash('sha256').update(input).digest('hex');
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

/** Backfill timeline-visit + page-content rows from page-evidence
 *  records. Every visited URL becomes a row; body_indexed=1 when the
 *  record carries content (Readability succeeded), else body-only row
 *  surfaces as a timeline-visit hit. */
const backfillFromPageEvidence = async (
  vaultRoot: string,
  store: RecallStore,
): Promise<{ pageContent: number; timelineVisit: number }> => {
  const records = await listPageEvidenceRecords(vaultRoot);
  let pageContent = 0;
  let timelineVisit = 0;
  const root = join(vaultRoot, '_BAC', 'page-content', 'by-url');
  for (const r of records) {
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
    // Try to read the body chunks if a page-content record exists for
    // this canonical URL. Two sources to check (in order):
    //   1. r.content.contentHash — populated by the slow page-evidence
    //      writer after content extraction completes.
    //   2. page-content/by-url/<sha>.json — written by
    //      writePageContentExtracted; lives independently of the
    //      page-evidence record. The harness exercises this path.
    let body: string | undefined;
    let contentHash: string | undefined = r.content?.contentHash;
    if (contentHash === undefined) {
      // Fallback: read the page-content row directly to get the hash.
      const rec = await readJson<{ readonly coverage?: { readonly contentHash?: string } }>(
        pageContentRecordPath(vaultRoot, url),
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
    if (body !== undefined) {
      store.upsertDocument({
        ...baseDoc,
        entityId: entityIdForUrl(url),
        sourceKind: 'page_content',
        body,
        ...(contentHash === undefined ? {} : { contentHash }),
        bodyIndexed: 1,
      });
      pageContent += 1;
    } else {
      store.upsertDocument({
        ...baseDoc,
        entityId: entityIdForUrl(url),
        sourceKind: 'timeline_visit',
        bodyIndexed: 0,
      });
      timelineVisit += 1;
    }
  }
  // Mark unused `root` var so the linter is happy (kept the join for
  // future expansion when we read chunks lazily).
  void root;
  return { pageContent, timelineVisit };
};

/** Backfill chat-turn rows from the recall index. Each turn becomes
 *  one document; body is the turn text. */
const backfillFromRecallIndex = async (
  vaultRoot: string,
  store: RecallStore,
): Promise<number> => {
  const indexPath = join(vaultRoot, '_BAC', 'recall', 'index.bin');
  const index = await readIndex(indexPath);
  if (index === null || index.items.length === 0) return 0;
  let count = 0;
  for (const item of index.items) {
    if (item.tombstoned === true) continue;
    const meta = item.metadata;
    if (meta === undefined) continue;
    const text = meta.text;
    if (text === undefined || text.length === 0) continue;
    const capturedMs = tsMs(item.capturedAt);
    store.upsertDocument({
      entityId: `chat:${item.id}`,
      sourceKind: 'chat_turn',
      ...(meta.threadUrl === undefined ? {} : { canonicalUrl: meta.threadUrl }),
      ...(meta.title === undefined ? {} : { title: meta.title }),
      body: text,
      threadId: item.threadId,
      ...(capturedMs === undefined ? {} : { firstSeenAtMs: capturedMs, lastSeenAtMs: capturedMs }),
      bodyIndexed: 1,
    });
    count += 1;
  }
  return count;
};

/** Backfill vectors from the existing JSON sidecar into docs_vec.
 *  Only writes when sqlite-vec is available; otherwise a no-op. */
const backfillVectors = async (
  vaultRoot: string,
  store: RecallStore,
): Promise<number> => {
  if (!store.vectorBackendAvailable) return 0;
  const vectors = await readSemanticRecallVectorStore(vaultRoot, MODEL_ID);
  if (vectors === null || vectors.size === 0) return 0;
  let n = 0;
  for (const [url, vec] of vectors) {
    store.upsertVector(entityIdForUrl(url), vec);
    n += 1;
  }
  return n;
};

export const backfillRecallStore = async (
  vaultRoot: string,
  store: RecallStore,
): Promise<{
  readonly pageContent: number;
  readonly timelineVisit: number;
  readonly chatTurn: number;
  readonly vectors: number;
}> => {
  const evidence = await backfillFromPageEvidence(vaultRoot, store);
  const chatTurn = await backfillFromRecallIndex(vaultRoot, store);
  const vectors = await backfillVectors(vaultRoot, store);
  return {
    pageContent: evidence.pageContent,
    timelineVisit: evidence.timelineVisit,
    chatTurn,
    vectors,
  };
};

/** Quick check: does the store have ANY rows? Used to skip backfill on
 *  warm starts. */
export const recallStoreIsEmpty = (store: RecallStore): boolean =>
  store.documentCount() === 0;

/** Source-of-truth freshness signature.
 *
 *  Returns a stable string derived from the mtimes + entry counts of
 *  the four JSON source directories that feed `backfillRecallStore`.
 *  When ANY of them changes (new file, removed file, content rewrite
 *  that bumps the parent dir mtime), the signature shifts and the
 *  caller re-runs backfill.
 *
 *  Cheaper than a full hash of every JSON file: 4 dir stats + an
 *  optional dirent count on the larger ones. Trade-off: same-file
 *  content edits that don't bump the parent mtime won't be detected;
 *  in practice the page-content + page-evidence writers atomic-write
 *  via rename, which DOES bump the parent dir mtime. */
export const computeSourceSignature = async (vaultRoot: string): Promise<string> => {
  const targets: readonly string[] = [
    join(vaultRoot, '_BAC', 'page-evidence', 'by-url'),
    join(vaultRoot, '_BAC', 'page-content', 'by-url'),
    join(vaultRoot, '_BAC', 'page-content', 'chunks'),
    join(vaultRoot, '_BAC', 'recall'),
    join(vaultRoot, '_BAC', 'recall', 'semantic-pool', 'vectors.json'),
  ];
  const parts: string[] = [];
  for (const path of targets) {
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

export const SOURCE_SIGNATURE_KEY = 'source_signature_v1';

