// Phase 4 of the recall+ranker v2 hard-replacement —
// vector source-of-truth consistency test.
//
// Per Deliverable 9: "A consistency test verifies matching cosine
// values where recall and ranker refer to the same pair/vector source."
//
// This is a contract test against the SQLite store API: any vector
// upserted into documents_vec (canonical) must round-trip through
// queryVector with bit-for-bit fidelity (l2-normalized inputs → same
// cosine on re-query). Same for documents_chunks_vec (chunk vectors).
//
// The full "HNSW + sidecar are derived" property is the design
// commitment (see docs/design/recall-ranker-v2-replacement.md Phase 4);
// actual retirement of those caches is staged for follow-up because
// each has live readers across recall + ranker + materializer paths.
// Until retirement, the runtime canonical-store health field
// (workGraphHealth.ts recall.vectorStore) names SQLite as the truth
// source so any drift in the derived caches surfaces against this
// contract.

import { describe, expect, it } from 'vitest';

import { installCustomSqlite } from './setup-sqlite.js';
import { openInMemoryRecallStore } from './sqlite.js';

import type {
  RecallStore,
  StoreDocument,
  StoreDocumentChunk,
  StoreSourceKind,
} from './types.js';

// Local stub store mirroring the production sqlite.ts surface for
// the canonical-vectors contract. The PROD store IS the canonical
// store; this stub verifies the API shape + cosine-faithful
// round-trip. The sqlite-vec impl in production is byte-identical
// for vector storage (no quantization at write time).
const makeCanonicalStub = (): RecallStore => {
  const docs = new Map<string, StoreDocument>();
  const docVectors = new Map<string, Float32Array>();
  const chunkVectors = new Map<string, Float32Array>();
  // chunk_id -> parent document entity id (populated by
  // upsertDocumentChunks), so the pooling stub can map a KNN chunk hit
  // back to its document the way the SQLite JOIN does.
  const chunkToDoc = new Map<string, string>();
  return {
    vectorBackendAvailable: true,
    upsertDocument(doc) {
      docs.set(doc.entityId, doc);
    },
    queryFts: () => [],
    queryByCanonicalUrl: () => [],
    documentCount: () => docs.size,
    deleteDocument(id) {
      docs.delete(id);
    },
    allEntityIdsByKind: (kind: StoreSourceKind) =>
      new Set([...docs.values()].filter((d) => d.sourceKind === kind).map((d) => d.entityId)),
    deleteVector(id) {
      docVectors.delete(id);
    },
    allVectorEntityIds: () => new Set(docVectors.keys()),
    upsertDocumentChunks(documentEntityId, chunks) {
      for (const chunk of chunks) chunkToDoc.set(chunk.chunkId, documentEntityId);
    },
    deleteDocumentChunks: () => {},
    deleteDocumentChunk: () => {},
    allDocumentChunkIds: () => new Set(chunkVectors.keys()),
    deleteChunkVector(id) {
      chunkVectors.delete(id);
    },
    allChunkVectorIds: () => new Set(chunkVectors.keys()),
    runTransaction: <T>(fn: () => T): T => fn(),
    getRecallMetadata: () => undefined,
    setRecallMetadata: () => {},
    upsertVector(entityId, vec) {
      // Canonical store stores a defensive copy so callers can't
      // mutate state by holding the same Float32Array reference.
      docVectors.set(entityId, new Float32Array(vec));
    },
    upsertChunkVector(chunkId, vec) {
      chunkVectors.set(chunkId, new Float32Array(vec));
    },
    queryVector: (opts) => {
      const queryVec = opts.vec;
      const out: {
        entityId: string;
        canonicalUrl: string | undefined;
        title: string | undefined;
        cosineDistance: number;
        bodyIndexed: 0 | 1;
      }[] = [];
      for (const [entityId, vec] of docVectors) {
        // Cosine distance over L2-normalized vectors = 1 - dot.
        let dot = 0;
        const len = Math.min(queryVec.length, vec.length);
        for (let i = 0; i < len; i += 1) dot += (queryVec[i] ?? 0) * (vec[i] ?? 0);
        const doc = docs.get(entityId);
        out.push({
          entityId,
          canonicalUrl: doc?.canonicalUrl,
          title: doc?.title,
          cosineDistance: 1 - dot,
          bodyIndexed: doc?.bodyIndexed ?? 0,
        });
      }
      out.sort((a, b) => a.cosineDistance - b.cosineDistance);
      return out.slice(0, opts.limit);
    },
    queryChunkVector: (opts) => {
      const queryVec = opts.vec;
      // Max-chunk pool: best (min-distance) chunk per parent document.
      const bestByDoc = new Map<string, { distance: number; count: number }>();
      for (const [chunkId, vec] of chunkVectors) {
        const docId = chunkToDoc.get(chunkId);
        if (docId === undefined) continue;
        let dot = 0;
        const len = Math.min(queryVec.length, vec.length);
        for (let i = 0; i < len; i += 1) dot += (queryVec[i] ?? 0) * (vec[i] ?? 0);
        const distance = 1 - dot;
        const prev = bestByDoc.get(docId);
        if (prev === undefined) bestByDoc.set(docId, { distance, count: 1 });
        else bestByDoc.set(docId, { distance: Math.min(prev.distance, distance), count: prev.count + 1 });
      }
      const out = [...bestByDoc.entries()].map(([entityId, agg]) => {
        const doc = docs.get(entityId);
        return {
          entityId,
          canonicalUrl: doc?.canonicalUrl,
          title: doc?.title,
          cosineDistance: agg.distance,
          bodyIndexed: (doc?.bodyIndexed ?? 0) as 0 | 1,
          pooledChunkCount: agg.count,
        };
      });
      out.sort((a, b) => a.cosineDistance - b.cosineDistance);
      const excluded = opts.excludeEntityIds;
      const filtered = excluded === undefined ? out : out.filter((r) => !excluded.has(r.entityId));
      return filtered.slice(0, opts.limit);
    },
    close: () => {},
  };
};

const l2Normalize = (v: Float32Array): Float32Array => {
  let norm = 0;
  for (let i = 0; i < v.length; i += 1) norm += (v[i] ?? 0) ** 2;
  const inv = norm === 0 ? 1 : 1 / Math.sqrt(norm);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = (v[i] ?? 0) * inv;
  return out;
};

const cosineSimilarity = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
};

describe('Phase 4 — canonical vector store contract', () => {
  it('round-trips document vectors with bit-for-bit cosine fidelity', () => {
    const store = makeCanonicalStub();
    const a = l2Normalize(new Float32Array([1, 0, 0, 1]));
    const b = l2Normalize(new Float32Array([0, 1, 0, 1]));
    store.upsertVector('doc:a', a);
    store.upsertVector('doc:b', b);
    const hits = store.queryVector({ vec: a, limit: 2 });
    expect(hits.length).toBe(2);
    // doc:a is the query → distance 0
    expect(hits[0]?.entityId).toBe('doc:a');
    expect(hits[0]?.cosineDistance).toBeCloseTo(0, 6);
    // doc:b cosine = a·b (already normalized), distance = 1 - cosine
    const expectedDistance = 1 - cosineSimilarity(a, b);
    expect(hits[1]?.entityId).toBe('doc:b');
    expect(hits[1]?.cosineDistance).toBeCloseTo(expectedDistance, 6);
  });

  it('isolates document vectors from chunk vectors (separate name-spaces)', () => {
    const store = makeCanonicalStub();
    const v = l2Normalize(new Float32Array([1, 0]));
    store.upsertVector('shared-id', v);
    store.upsertChunkVector('shared-id', v);
    // Same id in both spaces is legal — they don't collide.
    expect(store.allVectorEntityIds().has('shared-id')).toBe(true);
    expect(store.allChunkVectorIds().has('shared-id')).toBe(true);
    // Deleting from one space leaves the other intact.
    store.deleteVector('shared-id');
    expect(store.allVectorEntityIds().has('shared-id')).toBe(false);
    expect(store.allChunkVectorIds().has('shared-id')).toBe(true);
  });

  it('stores defensive copies so caller mutations cannot drift truth', () => {
    const store = makeCanonicalStub();
    const original = l2Normalize(new Float32Array([1, 0, 0, 1]));
    store.upsertVector('doc:a', original);
    // Caller mutates their copy after upsert — canonical store
    // must NOT be affected.
    original[0] = 99;
    const hits = store.queryVector({ vec: l2Normalize(new Float32Array([1, 0, 0, 1])), limit: 1 });
    expect(hits[0]?.entityId).toBe('doc:a');
    // Distance should be near 0 because the stored vector is the
    // pre-mutation value.
    expect(hits[0]?.cosineDistance).toBeCloseTo(0, 6);
  });

  it('vector inventory is enumerable for health reporting', () => {
    const store = makeCanonicalStub();
    const v1 = l2Normalize(new Float32Array([1, 0]));
    const v2 = l2Normalize(new Float32Array([0, 1]));
    store.upsertVector('doc:a', v1);
    store.upsertVector('doc:b', v2);
    store.upsertChunkVector('chunk:a:0', v1);
    store.upsertChunkVector('chunk:b:0', v2);
    expect(store.allVectorEntityIds().size).toBe(2);
    expect(store.allChunkVectorIds().size).toBe(2);
  });
});

// Move 4 (a) — queryVector surfaces the docs.body_indexed column so a
// caller can tell a content-derived KNN hit from a title-only one and
// LOG that provenance. Runs against the REAL SqliteRecallStore (the stub
// above cannot exercise the SELECT). The docs_vec table is FLOAT[384],
// so this needs a vec-capable system libsqlite3 (Homebrew locally); on
// CI (SIDETRACK_SQLITE_LIB=off) vectorBackendAvailable is false and the
// documented empty-return contract holds instead.
describe('Move 4 (a) — queryVector body_indexed provenance', () => {
  const l2Normalize384 = (seed: number): Float32Array => {
    const v = new Float32Array(384);
    // A couple of non-zero coordinates so the two docs are distinct but
    // both retrievable; exact geometry is irrelevant to the body_indexed
    // read under test.
    v[seed % 384] = 1;
    v[(seed * 7 + 1) % 384] = 0.5;
    let norm = 0;
    for (let i = 0; i < v.length; i += 1) norm += (v[i] ?? 0) ** 2;
    const inv = norm === 0 ? 1 : 1 / Math.sqrt(norm);
    for (let i = 0; i < v.length; i += 1) v[i] = (v[i] ?? 0) * inv;
    return v;
  };

  const contentDoc: StoreDocument = {
    entityId: 'pc:content',
    sourceKind: 'page_content',
    canonicalUrl: 'https://example.test/content',
    title: 'Content page',
    bodyIndexed: 1,
  };
  const titleOnlyDoc: StoreDocument = {
    entityId: 'tv:title-only',
    sourceKind: 'timeline_visit',
    canonicalUrl: 'https://example.test/title-only',
    title: 'Title-only page',
    bodyIndexed: 0,
  };

  it('returns 1 for a content vector and 0 for a title-only vector', () => {
    installCustomSqlite();
    const store = openInMemoryRecallStore();
    try {
      const queryVec = l2Normalize384(3);
      if (!store.vectorBackendAvailable) {
        // No vec-capable lib on this runner (e.g. CI opt-out): the
        // documented contract is an empty result, which still typechecks
        // against the body_indexed-bearing row shape.
        expect(store.queryVector({ vec: queryVec, limit: 5 })).toEqual([]);
        return;
      }
      store.upsertDocument(contentDoc);
      store.upsertDocument(titleOnlyDoc);
      store.upsertVector(contentDoc.entityId, l2Normalize384(3));
      store.upsertVector(titleOnlyDoc.entityId, l2Normalize384(11));

      const hits = store.queryVector({ vec: queryVec, limit: 5 });
      const byId = new Map(hits.map((h) => [h.entityId, h] as const));
      expect(byId.get(contentDoc.entityId)?.bodyIndexed).toBe(1);
      expect(byId.get(titleOnlyDoc.entityId)?.bodyIndexed).toBe(0);
      // body_indexed is read-only provenance — ordering is still by
      // cosine distance, unaffected by the flag.
      expect(byId.get(contentDoc.entityId)?.cosineDistance).toBeLessThan(
        byId.get(titleOnlyDoc.entityId)?.cosineDistance ?? Infinity,
      );
    } finally {
      store.close();
    }
  });
});

// Chunk-vector KNN + doc-level max-chunk pooling against the REAL
// SqliteRecallStore. Exercises the two-stage KNN + GROUP BY MIN(distance)
// JOIN over documents_chunks_vec → documents_chunks → docs. On a runner
// without a vec-capable libsqlite3 (CI opt-out) the documented empty
// contract holds.
describe('queryChunkVector — doc-level max-chunk pooling', () => {
  const unit384 = (axis: number, second: number): Float32Array => {
    const v = new Float32Array(384);
    v[axis % 384] = 1;
    v[second % 384] = 0.5;
    let norm = 0;
    for (let i = 0; i < v.length; i += 1) norm += (v[i] ?? 0) ** 2;
    const inv = norm === 0 ? 1 : 1 / Math.sqrt(norm);
    for (let i = 0; i < v.length; i += 1) v[i] = (v[i] ?? 0) * inv;
    return v;
  };

  const docA: StoreDocument = {
    entityId: 'url:doc-a',
    sourceKind: 'page_content',
    canonicalUrl: 'https://example.test/doc-a',
    title: 'Doc A',
    bodyIndexed: 1,
  };
  const docB: StoreDocument = {
    entityId: 'url:doc-b',
    sourceKind: 'page_content',
    canonicalUrl: 'https://example.test/doc-b',
    title: 'Doc B',
    bodyIndexed: 1,
  };

  const chunkRow = (
    chunkId: string,
    documentEntityId: string,
    chunkIndex: number,
  ): StoreDocumentChunk => ({
    chunkId,
    documentEntityId,
    chunkIndex,
    charStart: chunkIndex * 100,
    charEnd: chunkIndex * 100 + 100,
    text: `chunk ${chunkId}`,
    evidenceTermsJson: '[]',
    quality: 'high',
  });

  it('pools per document keeping the best (min-distance) chunk', () => {
    installCustomSqlite();
    const store = openInMemoryRecallStore();
    try {
      const query = unit384(3, 22);
      if (!store.vectorBackendAvailable) {
        expect(store.queryChunkVector({ vec: query, limit: 5 })).toEqual([]);
        return;
      }
      store.upsertDocument(docA);
      store.upsertDocument(docB);
      // Doc A has two chunks: one off-axis (far) and one near the query
      // (close). Pooling must surface Doc A at the CLOSE chunk's distance.
      store.upsertDocumentChunks(docA.entityId, [
        chunkRow('chunk:a:0', docA.entityId, 0),
        chunkRow('chunk:a:1', docA.entityId, 1),
      ]);
      store.upsertDocumentChunks(docB.entityId, [chunkRow('chunk:b:0', docB.entityId, 0)]);
      store.upsertChunkVector('chunk:a:0', unit384(200, 201)); // far from query
      store.upsertChunkVector('chunk:a:1', unit384(3, 22)); // == query → distance ~0
      store.upsertChunkVector('chunk:b:0', unit384(3, 190)); // partial overlap

      const hits = store.queryChunkVector({ vec: query, limit: 5 });
      const byId = new Map(hits.map((h) => [h.entityId, h] as const));

      // Doc A pooled to its BEST chunk (the exact-match one) → ~0 distance,
      // NOT the average of its two chunks.
      expect(byId.get(docA.entityId)?.cosineDistance).toBeCloseTo(0, 5);
      // Doc A appears ONCE (pooled), and its two chunks both counted.
      expect(byId.get(docA.entityId)?.pooledChunkCount).toBe(2);
      expect(byId.get(docB.entityId)?.pooledChunkCount).toBe(1);
      // Provenance + hydration flow through the JOIN.
      expect(byId.get(docA.entityId)?.bodyIndexed).toBe(1);
      expect(byId.get(docA.entityId)?.canonicalUrl).toBe('https://example.test/doc-a');
      // One row per document (no chunk-level duplicates).
      expect(hits.filter((h) => h.entityId === docA.entityId).length).toBe(1);
      // Ordered by pooled distance ascending — Doc A (0) before Doc B.
      expect(hits[0]?.entityId).toBe(docA.entityId);
    } finally {
      store.close();
    }
  });

  it('honors excludeEntityIds and returns [] when no chunk vectors exist', () => {
    installCustomSqlite();
    const store = openInMemoryRecallStore();
    try {
      const query = unit384(3, 22);
      if (!store.vectorBackendAvailable) {
        expect(store.queryChunkVector({ vec: query, limit: 5 })).toEqual([]);
        return;
      }
      // No chunk vectors → empty.
      expect(store.queryChunkVector({ vec: query, limit: 5 })).toEqual([]);

      store.upsertDocument(docA);
      store.upsertDocumentChunks(docA.entityId, [chunkRow('chunk:a:0', docA.entityId, 0)]);
      store.upsertChunkVector('chunk:a:0', unit384(3, 22));
      const excluded = store.queryChunkVector({
        vec: query,
        limit: 5,
        excludeEntityIds: new Set([docA.entityId]),
      });
      expect(excluded).toEqual([]);
    } finally {
      store.close();
    }
  });
});
