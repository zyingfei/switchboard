// Manifest-diffed page-evidence backfill (backfillPageEvidenceDelta).
//
// Contract under test: the first run on a store with no manifest does
// the full reconcile + seeds the manifest; later runs read ONLY the
// records whose seq (F5: page-evidence's SQLite change-fingerprint —
// see page-evidence/store.ts) moved, and removed records delete their
// docs via the urls the manifest carries. Uses a Map-backed store stub
// for the DESTINATION (the real recall-v2 SQLite store is bun-only —
// see makeStubStore below) but the real page-evidence/page-content
// SQLite stores for the SOURCE data, via the `__`-prefixed raw-write
// test hooks (bypassing extraction/validation so fixtures stay minimal
// and deterministic, same as before F5's file-based fixtures did).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { __writeRawPageContentChunksForTests } from '../../page-content/store.js';
import {
  __deletePageEvidenceRecordForTests,
  __writeRawPageEvidenceRowForTests,
  pageEvidenceHash,
} from '../../page-evidence/store.js';
import { backfillPageEvidenceDelta, PAGE_EVIDENCE_MANIFEST_KEY } from './backfill.js';
import type { RecallStore, StoreDocument, StoreSourceKind } from './types.js';

const stubEmbed = async (texts: readonly string[]): Promise<readonly Float32Array[]> =>
  texts.map(() => new Float32Array(8).fill(0.5));

interface StubStore extends RecallStore {
  readonly docs: Map<string, StoreDocument>;
  readonly metadata: Map<string, string>;
  readonly upsertLog: string[];
  readonly deleteLog: string[];
  readonly chunksByDoc: Map<string, readonly string[]>;
}

const makeStubStore = (): StubStore => {
  const docs = new Map<string, StoreDocument>();
  const metadata = new Map<string, string>();
  const upsertLog: string[] = [];
  const deleteLog: string[] = [];
  const chunksByDoc = new Map<string, readonly string[]>();
  return {
    docs,
    metadata,
    upsertLog,
    deleteLog,
    chunksByDoc,
    vectorBackendAvailable: false,
    upsertDocument(doc) {
      docs.set(doc.entityId, doc);
      upsertLog.push(doc.entityId);
    },
    queryFts: () => [],
    queryByCanonicalUrl: () => [],
    documentCount: () => docs.size,
    deleteDocument(id) {
      docs.delete(id);
      chunksByDoc.delete(id);
      deleteLog.push(id);
    },
    allEntityIdsByKind: (kind: StoreSourceKind) =>
      new Set([...docs.values()].filter((d) => d.sourceKind === kind).map((d) => d.entityId)),
    deleteVector: () => {},
    allVectorEntityIds: () => new Set(),
    upsertDocumentChunks(documentEntityId, chunks) {
      chunksByDoc.set(
        documentEntityId,
        chunks.map((c) => c.chunkId),
      );
    },
    deleteDocumentChunks(documentEntityId) {
      chunksByDoc.delete(documentEntityId);
    },
    deleteDocumentChunk: () => {},
    allDocumentChunkIds: () => new Set([...chunksByDoc.values()].flat()),
    deleteChunkVector: () => {},
    allChunkVectorIds: () => new Set(),
    runTransaction: <T>(fn: () => T): T => fn(),
    getRecallMetadata: (key) => metadata.get(key),
    setRecallMetadata: (key, value) => {
      metadata.set(key, value);
    },
    upsertVector: () => {},
    upsertChunkVector: () => {},
    queryVector: () => [],
    queryChunkVector: () => [],
    close: () => {},
  };
};

const recordJson = (canonicalUrl: string, title: string, contentHash?: string): string =>
  JSON.stringify({
    schemaVersion: 1,
    canonicalUrl,
    evidenceRevision: 'rev-1',
    updatedAt: '2026-06-10T00:00:00.000Z',
    evidenceTier: contentHash === undefined ? 'metadata_only' : 'indexed_chunks',
    versions: {},
    metadata: {
      firstSeenAt: '2026-06-09T00:00:00.000Z',
      lastSeenAt: '2026-06-10T00:00:00.000Z',
      title,
    },
    ...(contentHash === undefined ? {} : { content: { contentHash } }),
  });

const chunksJson = (ids: readonly string[]): string =>
  JSON.stringify({
    chunks: ids.map((id, index) => ({
      id,
      chunkIndex: index,
      charStart: index * 10,
      charEnd: index * 10 + 9,
      text: `chunk text ${id}`,
      quality: 1,
    })),
  });

const vaults: string[] = [];
const makeVault = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'backfill-delta-'));
  vaults.push(root);
  return root;
};
// Production layout: record file name = sha256(canonicalUrl).json
// (page-evidence/store.ts pageEvidenceHash) — the manifest seed
// derives names the same way, so fixtures must match.
const recordName = (canonicalUrl: string): string => `${pageEvidenceHash(canonicalUrl)}.json`;
const A_URL = 'https://a.example/page';
const B_URL = 'https://b.example/page';
const A_NAME = recordName(A_URL);
const B_NAME = recordName(B_URL);

afterEach(() => {
  for (const v of vaults.splice(0)) rmSync(v, { recursive: true, force: true });
});

describe('backfillPageEvidenceDelta', () => {
  it('first run is a full pass and seeds the manifest', async () => {
    const root = makeVault();
    await __writeRawPageEvidenceRowForTests(root, A_URL, recordJson(A_URL, 'A'));
    await __writeRawPageEvidenceRowForTests(root, B_URL, recordJson(B_URL, 'B'));
    const store = makeStubStore();
    const stats = await backfillPageEvidenceDelta(root, store, stubEmbed);
    expect(stats.mode).toBe('full');
    expect(stats.timelineVisit).toBe(2);
    expect(store.docs.size).toBe(2);
    const manifest = JSON.parse(store.metadata.get(PAGE_EVIDENCE_MANIFEST_KEY) ?? '{}') as Record<
      string,
      string
    >;
    expect(Object.keys(manifest).sort()).toEqual([A_NAME, B_NAME].sort());
    expect(manifest[A_NAME]).toContain(A_URL);
  });

  it('unchanged vault is a no-op delta (zero reads, zero upserts)', async () => {
    const root = makeVault();
    await __writeRawPageEvidenceRowForTests(root, A_URL, recordJson(A_URL, 'A'));
    const store = makeStubStore();
    await backfillPageEvidenceDelta(root, store, stubEmbed);
    store.upsertLog.length = 0;
    const stats = await backfillPageEvidenceDelta(root, store, stubEmbed);
    expect(stats.mode).toBe('delta');
    expect(stats.changed).toBe(0);
    expect(stats.removed).toBe(0);
    expect(store.upsertLog).toEqual([]);
  });

  it('reads + upserts only the changed record', async () => {
    const root = makeVault();
    await __writeRawPageEvidenceRowForTests(root, A_URL, recordJson(A_URL, 'A'));
    await __writeRawPageEvidenceRowForTests(root, B_URL, recordJson(B_URL, 'B'));
    const store = makeStubStore();
    await backfillPageEvidenceDelta(root, store, stubEmbed);
    store.upsertLog.length = 0;
    // Change b's content. Every real write bumps page-evidence's `seq`
    // counter (F5), so the next delta pass detects it deterministically
    // — no filesystem mtime-forcing needed (the old utimesSync dance).
    await __writeRawPageEvidenceRowForTests(root, B_URL, recordJson(B_URL, 'B with a longer title'));
    const stats = await backfillPageEvidenceDelta(root, store, stubEmbed);
    expect(stats.mode).toBe('delta');
    expect(stats.changed).toBe(1);
    expect(store.upsertLog).toHaveLength(1);
    const upsertedDoc = store.docs.get(store.upsertLog[0] ?? '');
    expect(upsertedDoc?.canonicalUrl).toBe(B_URL);
    expect(upsertedDoc?.title).toBe('B with a longer title');
  });

  it('a record losing its contentHash drops the doc’s chunk rows', async () => {
    const root = makeVault();
    await __writeRawPageContentChunksForTests(root, 'hash-1', chunksJson(['c-1', 'c-2']));
    await __writeRawPageEvidenceRowForTests(root, A_URL, recordJson(A_URL, 'A', 'hash-1'));
    const store = makeStubStore();
    await backfillPageEvidenceDelta(root, store, stubEmbed);
    expect([...store.chunksByDoc.values()].flat().sort()).toEqual(['c-1', 'c-2']);
    // Re-extraction downgrades the record to metadata_only (content
    // block removed) — its chunks must stop being searchable.
    await __writeRawPageEvidenceRowForTests(root, A_URL, recordJson(A_URL, 'A'));
    const stats = await backfillPageEvidenceDelta(root, store, stubEmbed);
    expect(stats.mode).toBe('delta');
    expect(stats.changed).toBe(1);
    expect([...store.chunksByDoc.values()].flat()).toEqual([]);
  });

  it('fullOnEmptyDelta reconciles fully when the delta sees zero record changes', async () => {
    const root = makeVault();
    await __writeRawPageEvidenceRowForTests(root, A_URL, recordJson(A_URL, 'A'));
    const store = makeStubStore();
    await backfillPageEvidenceDelta(root, store, stubEmbed);
    // Without the flag an unchanged vault is a no-op delta…
    expect((await backfillPageEvidenceDelta(root, store, stubEmbed)).mode).toBe('delta');
    // …with it (the caller saw the signature move — e.g. a chunks-only
    // write) the pass reconciles fully instead of marking it done.
    const stats = await backfillPageEvidenceDelta(root, store, stubEmbed, {
      fullOnEmptyDelta: true,
    });
    expect(stats.mode).toBe('full');
  });

  it('a record turning schema-invalid deletes its doc and keeps the url in the manifest', async () => {
    const root = makeVault();
    await __writeRawPageEvidenceRowForTests(root, A_URL, recordJson(A_URL, 'A'));
    const store = makeStubStore();
    await backfillPageEvidenceDelta(root, store, stubEmbed);
    expect(store.docs.size).toBe(1);
    // Corrupt the record (fails safePageEvidenceRecord) — any real
    // write bumps seq, so the diff flags it changed.
    await __writeRawPageEvidenceRowForTests(root, A_URL, '{"not":"a record at all"}');
    const stats = await backfillPageEvidenceDelta(root, store, stubEmbed);
    expect(stats.mode).toBe('delta');
    // The row is swept (full-pass parity) instead of leaking stale.
    expect(store.docs.size).toBe(0);
    // The manifest carries the prior url forward, so deleting the
    // record later still resolves the entity (no '' tombstone).
    const manifest = JSON.parse(store.metadata.get(PAGE_EVIDENCE_MANIFEST_KEY) ?? '{}') as Record<
      string,
      string
    >;
    expect(manifest[A_NAME]).toContain(A_URL);
  });

  it('removed record deletes its doc via the manifest url', async () => {
    const root = makeVault();
    await __writeRawPageEvidenceRowForTests(root, A_URL, recordJson(A_URL, 'A'));
    await __writeRawPageEvidenceRowForTests(root, B_URL, recordJson(B_URL, 'B'));
    const store = makeStubStore();
    await backfillPageEvidenceDelta(root, store, stubEmbed);
    const bId = [...store.docs.values()].find((d) => d.canonicalUrl === B_URL)?.entityId;
    await __deletePageEvidenceRecordForTests(root, B_URL);
    const stats = await backfillPageEvidenceDelta(root, store, stubEmbed);
    expect(stats.mode).toBe('delta');
    expect(stats.removed).toBe(1);
    expect(store.deleteLog).toEqual([bId]);
    expect(store.docs.size).toBe(1);
    // Manifest no longer carries the removed record.
    const manifest = JSON.parse(store.metadata.get(PAGE_EVIDENCE_MANIFEST_KEY) ?? '{}') as Record<
      string,
      string
    >;
    expect(Object.keys(manifest)).toEqual([A_NAME]);
  });
});
