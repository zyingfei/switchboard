// Manifest-diffed page-evidence backfill (backfillPageEvidenceDelta).
//
// Contract under test: the first run on a store with no manifest does
// the full reconcile + seeds the manifest; later runs read ONLY the
// records whose (mtime, size) moved, and removed files delete their
// docs via the urls the manifest carries. Uses a Map-backed store stub
// (the real SQLite store is bun-only under vitest-node) and a real tmp
// vault directory.

import { mkdirSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { backfillPageEvidenceDelta, PAGE_EVIDENCE_MANIFEST_KEY } from './backfill.js';
import type { RecallStore, StoreDocument, StoreSourceKind } from './types.js';

const stubEmbed = async (texts: readonly string[]): Promise<readonly Float32Array[]> =>
  texts.map(() => new Float32Array(8).fill(0.5));

interface StubStore extends RecallStore {
  readonly docs: Map<string, StoreDocument>;
  readonly metadata: Map<string, string>;
  readonly upsertLog: string[];
  readonly deleteLog: string[];
}

const makeStubStore = (): StubStore => {
  const docs = new Map<string, StoreDocument>();
  const metadata = new Map<string, string>();
  const upsertLog: string[] = [];
  const deleteLog: string[] = [];
  return {
    docs,
    metadata,
    upsertLog,
    deleteLog,
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
      deleteLog.push(id);
    },
    allEntityIdsByKind: (kind: StoreSourceKind) =>
      new Set([...docs.values()].filter((d) => d.sourceKind === kind).map((d) => d.entityId)),
    deleteVector: () => {},
    allVectorEntityIds: () => new Set(),
    upsertDocumentChunks: () => {},
    deleteDocumentChunks: () => {},
    deleteDocumentChunk: () => {},
    allDocumentChunkIds: () => new Set(),
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
    close: () => {},
  };
};

const recordJson = (canonicalUrl: string, title: string): string =>
  JSON.stringify({
    schemaVersion: 1,
    canonicalUrl,
    evidenceRevision: 'rev-1',
    updatedAt: '2026-06-10T00:00:00.000Z',
    evidenceTier: 'metadata_only',
    versions: {},
    metadata: {
      firstSeenAt: '2026-06-09T00:00:00.000Z',
      lastSeenAt: '2026-06-10T00:00:00.000Z',
      title,
    },
  });

const vaults: string[] = [];
const makeVault = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'backfill-delta-'));
  vaults.push(root);
  mkdirSync(join(root, '_BAC', 'page-evidence', 'by-url'), { recursive: true });
  return root;
};
const recordPath = (root: string, name: string): string =>
  join(root, '_BAC', 'page-evidence', 'by-url', name);

afterEach(() => {
  for (const v of vaults.splice(0)) rmSync(v, { recursive: true, force: true });
});

describe('backfillPageEvidenceDelta', () => {
  it('first run is a full pass and seeds the manifest', async () => {
    const root = makeVault();
    writeFileSync(recordPath(root, 'a.json'), recordJson('https://a.example/page', 'A'));
    writeFileSync(recordPath(root, 'b.json'), recordJson('https://b.example/page', 'B'));
    const store = makeStubStore();
    const stats = await backfillPageEvidenceDelta(root, store, stubEmbed);
    expect(stats.mode).toBe('full');
    expect(stats.timelineVisit).toBe(2);
    expect(store.docs.size).toBe(2);
    const manifest = JSON.parse(store.metadata.get(PAGE_EVIDENCE_MANIFEST_KEY) ?? '{}') as Record<
      string,
      string
    >;
    expect(Object.keys(manifest).sort()).toEqual(['a.json', 'b.json']);
    expect(manifest['a.json']).toContain('https://a.example/page');
  });

  it('unchanged vault is a no-op delta (zero reads, zero upserts)', async () => {
    const root = makeVault();
    writeFileSync(recordPath(root, 'a.json'), recordJson('https://a.example/page', 'A'));
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
    writeFileSync(recordPath(root, 'a.json'), recordJson('https://a.example/page', 'A'));
    writeFileSync(recordPath(root, 'b.json'), recordJson('https://b.example/page', 'B'));
    const store = makeStubStore();
    await backfillPageEvidenceDelta(root, store, stubEmbed);
    store.upsertLog.length = 0;
    // Change b's content (size moves) + force a distinct mtime so the
    // stat diff can't alias on coarse timestamps.
    writeFileSync(
      recordPath(root, 'b.json'),
      recordJson('https://b.example/page', 'B with a longer title'),
    );
    utimesSync(recordPath(root, 'b.json'), new Date(), new Date(Date.now() + 5_000));
    const stats = await backfillPageEvidenceDelta(root, store, stubEmbed);
    expect(stats.mode).toBe('delta');
    expect(stats.changed).toBe(1);
    expect(store.upsertLog).toHaveLength(1);
    const upsertedDoc = store.docs.get(store.upsertLog[0] ?? '');
    expect(upsertedDoc?.canonicalUrl).toBe('https://b.example/page');
    expect(upsertedDoc?.title).toBe('B with a longer title');
  });

  it('removed file deletes its doc via the manifest url', async () => {
    const root = makeVault();
    writeFileSync(recordPath(root, 'a.json'), recordJson('https://a.example/page', 'A'));
    writeFileSync(recordPath(root, 'b.json'), recordJson('https://b.example/page', 'B'));
    const store = makeStubStore();
    await backfillPageEvidenceDelta(root, store, stubEmbed);
    const bId = [...store.docs.values()].find(
      (d) => d.canonicalUrl === 'https://b.example/page',
    )?.entityId;
    unlinkSync(recordPath(root, 'b.json'));
    const stats = await backfillPageEvidenceDelta(root, store, stubEmbed);
    expect(stats.mode).toBe('delta');
    expect(stats.removed).toBe(1);
    expect(store.deleteLog).toEqual([bId]);
    expect(store.docs.size).toBe(1);
    // Manifest no longer carries the removed file.
    const manifest = JSON.parse(store.metadata.get(PAGE_EVIDENCE_MANIFEST_KEY) ?? '{}') as Record<
      string,
      string
    >;
    expect(Object.keys(manifest)).toEqual(['a.json']);
  });
});
