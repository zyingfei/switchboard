// Page-feature-driven retrieval arms — contract tests for runRecall.
//
// Two arms connect built-but-unserved retrieval to the semantic-query
// lane, gated under the P1 freeze (ADR-0011) and defaulting OFF by the
// eval verdict:
//   1. chunkVectors        — prefer doc-level max-chunk pooling over
//                            documents_chunks_vec (passage retrieval).
//   2. provenanceDownweight — down-weight title-only (body_indexed=0)
//                            KNN hits relative to content-derived ones.
//
// The arms are INJECTED via PipelineDeps.retrievalArms (not env) so the
// eval/replay harness can run arm-vs-arm. These tests inject a store
// stub whose queryVector / queryChunkVector return controlled hits, then
// assert the served order + evidence per arm state. No bun:sqlite needed.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runRecall, type PipelineDeps } from './pipeline.js';
import type { RetrievalArms } from './retrievalFlags.js';
import type {
  RecallStore,
  StoreDocument,
  StoreFtsHit,
  StoreSourceKind,
} from './store/types.js';

// A non-zero query embedding so `queryEmbedding !== undefined`. The
// store stub returns fixed hits regardless of vector geometry — the
// cosine each hit carries is what we control via cosineDistance below.
const stubEmbed = async (texts: readonly string[]): Promise<readonly Float32Array[]> =>
  texts.map(() => {
    const v = new Float32Array(384);
    v[0] = 1;
    return v;
  });

type DocVecHit = {
  entityId: string;
  canonicalUrl: string | undefined;
  title: string | undefined;
  cosineDistance: number;
  bodyIndexed: 0 | 1;
};
type ChunkVecHit = DocVecHit & { pooledChunkCount: number };

interface StubStoreSpec {
  readonly docVecHits: readonly DocVecHit[];
  readonly chunkVecHits: readonly ChunkVecHit[];
}

// Minimal RecallStore whose vector lanes return injected hits. Lexical
// lanes are empty so semantic_query is the sole contributor — keeps the
// served order a clean function of the vector arms.
const makeVectorStore = (spec: StubStoreSpec): RecallStore => {
  const docs = new Map<string, StoreDocument>();
  const hitFromDoc = (doc: StoreDocument): StoreFtsHit => ({
    entityId: doc.entityId,
    sourceKind: doc.sourceKind,
    ...(doc.canonicalUrl === undefined ? {} : { canonicalUrl: doc.canonicalUrl }),
    ...(doc.title === undefined ? {} : { title: doc.title }),
    bm25: 1,
  });
  return {
    vectorBackendAvailable: true,
    upsertDocument(doc) {
      docs.set(doc.entityId, doc);
    },
    queryFts: () => [],
    queryByCanonicalUrl({ canonicalUrl, limit }) {
      return [...docs.values()]
        .filter((d) => d.canonicalUrl === canonicalUrl)
        .slice(0, limit)
        .map(hitFromDoc);
    },
    documentCount: () => docs.size,
    deleteDocument(id) {
      docs.delete(id);
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
    getRecallMetadata: () => undefined,
    setRecallMetadata: () => {},
    upsertVector: () => {},
    upsertChunkVector: () => {},
    queryVector: ({ limit, excludeEntityIds }) =>
      spec.docVecHits
        .filter((h) => excludeEntityIds === undefined || !excludeEntityIds.has(h.entityId))
        .slice(0, limit),
    queryChunkVector: ({ limit, excludeEntityIds }) =>
      spec.chunkVecHits
        .filter((h) => excludeEntityIds === undefined || !excludeEntityIds.has(h.entityId))
        .slice(0, limit),
    close: () => {},
  };
};

const arms = (over: Partial<RetrievalArms>): RetrievalArms => ({
  chunkVectors: false,
  provenanceDownweight: false,
  ...over,
});

const baseDeps = (overrides?: Partial<PipelineDeps>): PipelineDeps => ({
  vaultRoot: mkdtempSync(join(tmpdir(), 'recall-v2-arms-')),
  embed: stubEmbed,
  now: () => Date.parse('2026-07-12T00:00:00.000Z'),
  ...overrides,
});

// semantic_query only: no lexical / graph noise so we read the arms.
const semanticOnly = {
  sources: ['semantic_query'] as const,
  strategy: { rerankTopK: 0, explain: true, debug: true } as const,
};

const urlsOf = (results: readonly { canonicalUrl?: string }[]): (string | undefined)[] =>
  results.map((r) => r.canonicalUrl);

const semanticEvidenceExplain = (result: {
  evidence: readonly { sourceKind: string; explain?: string }[];
}): string | undefined =>
  result.evidence.find((e) => e.sourceKind === 'semantic_query')?.explain;

describe('runRecall — chunk-vector pooling arm', () => {
  const docVecHits: DocVecHit[] = [
    {
      entityId: 'url:doc-a',
      canonicalUrl: 'https://example.test/doc-a',
      title: 'Doc A (whole-doc average)',
      cosineDistance: 0.5, // whole-doc cosine 0.5
      bodyIndexed: 1,
    },
  ];
  // The SAME doc has a strongly-matching passage → chunk pooling surfaces
  // it at a much higher cosine than the whole-doc average would.
  const chunkVecHits: ChunkVecHit[] = [
    {
      entityId: 'url:doc-a',
      canonicalUrl: 'https://example.test/doc-a',
      title: 'Doc A (best passage)',
      cosineDistance: 0.1, // pooled best-chunk cosine 0.9
      bodyIndexed: 1,
      pooledChunkCount: 3,
    },
  ];

  it('uses doc-vec (whole-doc) when the chunk arm is OFF', async () => {
    const store = makeVectorStore({ docVecHits, chunkVecHits });
    const resp = await runRecall(baseDeps({ store, retrievalArms: arms({ chunkVectors: false }) }), {
      q: 'query',
      ...semanticOnly,
    });
    expect(urlsOf(resp.results)).toContain('https://example.test/doc-a');
    const explain = semanticEvidenceExplain(resp.results[0]!);
    expect(explain).toContain('via doc_vec');
    expect(explain).not.toContain('pooled');
    expect(resp.meta.flags['recallChunkVectors']).toBe(false);
  });

  it('prefers chunk-vector pooling when the chunk arm is ON', async () => {
    const store = makeVectorStore({ docVecHits, chunkVecHits });
    const resp = await runRecall(baseDeps({ store, retrievalArms: arms({ chunkVectors: true }) }), {
      q: 'query',
      ...semanticOnly,
    });
    const explain = semanticEvidenceExplain(resp.results[0]!);
    expect(explain).toContain('via chunk_vec');
    expect(explain).toContain('pooled 3 chunks');
    // The pooled cosine (0.9) is the retrieved rawScore, not the
    // whole-doc average (0.5) — pooling took the best passage.
    const raw = resp.results[0]!.evidence.find((e) => e.sourceKind === 'semantic_query')?.rawScore;
    expect(raw).toBeCloseTo(0.9, 6);
    expect(resp.meta.flags['recallChunkVectors']).toBe(true);
  });

  it('falls through to doc-vec when the chunk lane is empty (no regression)', async () => {
    // Arm ON but no chunk vectors exist yet → doc-vec must still serve.
    const store = makeVectorStore({ docVecHits, chunkVecHits: [] });
    const resp = await runRecall(baseDeps({ store, retrievalArms: arms({ chunkVectors: true }) }), {
      q: 'query',
      ...semanticOnly,
    });
    expect(urlsOf(resp.results)).toContain('https://example.test/doc-a');
    expect(semanticEvidenceExplain(resp.results[0]!)).toContain('via doc_vec');
  });
});

describe('runRecall — provenance down-weight arm', () => {
  // A title-only hit at a SLIGHTLY higher cosine than a content hit. With
  // the down-weight OFF it ranks first; with it ON the 0.85 multiplier
  // (0.80 * 0.85 = 0.68) pushes it below the content hit (0.75).
  const docVecHits: DocVecHit[] = [
    {
      entityId: 'url:title-only',
      canonicalUrl: 'https://example.test/title-only',
      title: 'Title-only visit',
      cosineDistance: 0.2, // cosine 0.80
      bodyIndexed: 0,
    },
    {
      entityId: 'url:content',
      canonicalUrl: 'https://example.test/content',
      title: 'Content page',
      cosineDistance: 0.25, // cosine 0.75
      bodyIndexed: 1,
    },
  ];

  it('keeps the higher-cosine title-only hit first when the arm is OFF', async () => {
    const store = makeVectorStore({ docVecHits, chunkVecHits: [] });
    const resp = await runRecall(
      baseDeps({ store, retrievalArms: arms({ provenanceDownweight: false }) }),
      { q: 'query', ...semanticOnly },
    );
    expect(urlsOf(resp.results).slice(0, 2)).toEqual([
      'https://example.test/title-only',
      'https://example.test/content',
    ]);
    expect(resp.meta.flags['recallProvenanceDownweight']).toBe(false);
  });

  it('reorders the content hit above the title-only hit when the arm is ON', async () => {
    const store = makeVectorStore({ docVecHits, chunkVecHits: [] });
    const resp = await runRecall(
      baseDeps({ store, retrievalArms: arms({ provenanceDownweight: true }) }),
      { q: 'query', ...semanticOnly },
    );
    expect(urlsOf(resp.results).slice(0, 2)).toEqual([
      'https://example.test/content',
      'https://example.test/title-only',
    ]);
    // The title-only row's evidence still carries its RAW cosine (0.80)
    // for honesty; the penalty acted on ordering + gating only.
    const titleRow = resp.results.find(
      (r) => r.canonicalUrl === 'https://example.test/title-only',
    );
    const raw = titleRow?.evidence.find((e) => e.sourceKind === 'semantic_query')?.rawScore;
    expect(raw).toBeCloseTo(0.8, 6);
    expect(semanticEvidenceExplain(titleRow!)).toContain('title-only down-weight');
    expect(resp.meta.flags['recallProvenanceDownweight']).toBe(true);
  });

  it('does not penalize content hits (body_indexed=1) under the arm', async () => {
    const store = makeVectorStore({ docVecHits, chunkVecHits: [] });
    const resp = await runRecall(
      baseDeps({ store, retrievalArms: arms({ provenanceDownweight: true }) }),
      { q: 'query', ...semanticOnly },
    );
    const contentRow = resp.results.find(
      (r) => r.canonicalUrl === 'https://example.test/content',
    );
    expect(semanticEvidenceExplain(contentRow!)).not.toContain('title-only down-weight');
  });
});

describe('runRecall — arms compose', () => {
  it('applies the title-only down-weight to pooled chunk hits too', async () => {
    // Chunk pooling can return a title-only doc in principle (a doc whose
    // body was extracted then later re-classified). Assert the two arms
    // stack: pooled retrieval + provenance down-weight.
    const docVecHits: DocVecHit[] = [];
    const chunkVecHits: ChunkVecHit[] = [
      {
        entityId: 'url:pooled-title-only',
        canonicalUrl: 'https://example.test/pooled-title-only',
        title: 'Pooled title-only',
        cosineDistance: 0.15, // cosine 0.85
        bodyIndexed: 0,
        pooledChunkCount: 2,
      },
      {
        entityId: 'url:pooled-content',
        canonicalUrl: 'https://example.test/pooled-content',
        title: 'Pooled content',
        cosineDistance: 0.22, // cosine 0.78
        bodyIndexed: 1,
        pooledChunkCount: 4,
      },
    ];
    const store = makeVectorStore({ docVecHits, chunkVecHits });
    const resp = await runRecall(
      baseDeps({
        store,
        retrievalArms: arms({ chunkVectors: true, provenanceDownweight: true }),
      }),
      { q: 'query', ...semanticOnly },
    );
    // 0.85 * 0.85 = 0.72 < 0.78 → content pooled hit wins.
    expect(urlsOf(resp.results).slice(0, 2)).toEqual([
      'https://example.test/pooled-content',
      'https://example.test/pooled-title-only',
    ]);
    const titleRow = resp.results.find(
      (r) => r.canonicalUrl === 'https://example.test/pooled-title-only',
    );
    const explain = semanticEvidenceExplain(titleRow!);
    expect(explain).toContain('via chunk_vec');
    expect(explain).toContain('title-only down-weight');
  });
});
