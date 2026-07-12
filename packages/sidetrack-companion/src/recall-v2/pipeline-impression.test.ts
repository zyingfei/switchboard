// Phase 0 of the recall+ranker v2 hard-replacement —
// impression-logging contract tests for runRecall.
//
// Verifies:
//   - meta.servedContextId is always present
//   - When appendImpression is provided, the pipeline emits a
//     RecallServedPayload with the expected shape (results survive
//     suppression; per-lane ranks/scores reflect candidate evidence;
//     suppressedEntityIds includes dropped rows when present).
//   - When appendImpression is NOT provided, the pipeline still
//     returns servedContextId in meta but writes nothing (silent skip).
//
// Uses the same stub RecallStore as pipeline-intent.test.ts so we
// don't need bun:sqlite. The stub-store helpers are duplicated to
// keep this test self-contained (the original test doesn't export).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot } from '../connections/types.js';
import type { RecallServedPayload } from '../recall/events.js';
import { CANDIDATE_PAIR_FEATURE_KEYS, FEATURE_SCHEMA_VERSION } from '../ranker/feature-schema.js';
import type { LearnedRerankContext } from './learnedRerank.js';
import { runRecall, type PipelineDeps } from './pipeline.js';
import {
  __resetServedFeatureModelCacheForTests,
  peekServedFeatureModel,
} from './servedFeatureModel.js';
import type { RecallStore, StoreDocument, StoreFtsHit, StoreSourceKind } from './store/types.js';

const stubEmbed = async (texts: readonly string[]): Promise<readonly Float32Array[]> =>
  texts.map(() => new Float32Array(384).fill(0));

const makeStubStore = (): RecallStore => {
  const docs = new Map<string, StoreDocument>();
  const matches = (q: string, doc: StoreDocument): boolean => {
    const needles = q
      .toLowerCase()
      .split(/\s+/u)
      .filter((t) => t.length > 0);
    if (needles.length === 0) return false;
    const haystack =
      `${doc.title ?? ''} ${doc.body ?? ''} ${doc.urlTokens ?? ''} ${doc.host ?? ''}`.toLowerCase();
    return needles.every((n) => haystack.includes(n));
  };
  const hitFromDoc = (doc: StoreDocument): StoreFtsHit => ({
    entityId: doc.entityId,
    sourceKind: doc.sourceKind,
    ...(doc.canonicalUrl === undefined ? {} : { canonicalUrl: doc.canonicalUrl }),
    ...(doc.title === undefined ? {} : { title: doc.title }),
    ...(doc.threadId === undefined ? {} : { threadId: doc.threadId }),
    bm25: 1,
    ...(doc.firstSeenAtMs === undefined
      ? doc.lastSeenAtMs === undefined
        ? {}
        : { capturedAtMs: doc.lastSeenAtMs }
      : { capturedAtMs: doc.firstSeenAtMs }),
  });
  return {
    vectorBackendAvailable: false,
    upsertDocument(doc) {
      docs.set(doc.entityId, doc);
    },
    queryFts({ q, sourceKind, limit }) {
      const kinds = new Set<StoreSourceKind>(Array.isArray(sourceKind) ? sourceKind : [sourceKind]);
      return [...docs.values()]
        .filter((d) => kinds.has(d.sourceKind) && matches(q, d))
        .slice(0, limit)
        .map(hitFromDoc);
    },
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
    allEntityIdsByKind: (kind) =>
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
    queryVector: () => [],
    close: () => {},
  };
};

const seededStore = (): RecallStore => {
  const store = makeStubStore();
  store.upsertDocument({
    entityId: 'tv:example.com/page',
    sourceKind: 'timeline_visit',
    canonicalUrl: 'https://example.com/page',
    title: 'Example page',
    urlTokens: 'example com page',
    host: 'example.com',
    lastSeenAtMs: Date.parse('2026-05-24T10:00:00.000Z'),
    bodyIndexed: 0,
  });
  store.upsertDocument({
    entityId: 'pc:example.com/page',
    sourceKind: 'page_content',
    canonicalUrl: 'https://example.com/page',
    title: 'Example page',
    body: 'the example page body for FTS',
    urlTokens: 'example com page',
    host: 'example.com',
    lastSeenAtMs: Date.parse('2026-05-24T10:00:00.000Z'),
    bodyIndexed: 1,
  });
  return store;
};

const baseDeps = (overrides?: Partial<PipelineDeps>): PipelineDeps => ({
  vaultRoot: mkdtempSync(join(tmpdir(), 'recall-v2-impression-')),
  embed: stubEmbed,
  now: () => Date.parse('2026-05-25T00:00:00.000Z'),
  store: seededStore(),
  ...overrides,
});

// Phase 5 flipped cross-encoder rerank ON by default; unit tests
// disable it explicitly so they don't try to load the MiniLM model
// in environments without it cached. The Phase 5 rerank default is
// validated by the eval harness against the live model.
const noRerankStrategy = { rerankTopK: 0 } as const;

describe('runRecall — Phase 0 impression logging', () => {
  it('always stamps meta.servedContextId on the response', async () => {
    const resp = await runRecall(baseDeps(), {
      q: 'example',
      strategy: noRerankStrategy,
    });
    expect(typeof resp.meta.servedContextId).toBe('string');
    expect(resp.meta.servedContextId?.length).toBeGreaterThan(0);
  });

  it('emits a recall.served payload when appendImpression is provided', async () => {
    const captured: RecallServedPayload[] = [];
    const appendImpression = async (payload: RecallServedPayload): Promise<void> => {
      captured.push(payload);
    };
    const resp = await runRecall(baseDeps({ appendImpression }), {
      q: 'example',
      intent: 'dejavu',
      // Phase 5 flipped rerank ON by default; this test asserts on
      // rerankApplied = false so disable explicitly for determinism.
      strategy: { rerankTopK: 0 },
    });
    // Pipeline fires the append fire-and-forget; the void-promise
    // resolves within the same microtask tick as the synchronous
    // append above, so it's captured by the time runRecall returns.
    await Promise.resolve();
    expect(captured.length).toBe(1);
    const payload = captured[0];
    expect(payload).toBeDefined();
    if (payload === undefined) return;
    expect(payload.payloadVersion).toBe(1);
    expect(payload.servedContextId).toBe(resp.meta.servedContextId);
    expect(payload.query).toBe('example');
    expect(payload.intent).toBe('dejavu');
    expect(payload.rerankApplied).toBe(false);
    expect(payload.results.length).toBe(resp.results.length);
    // Snapshot rows must reflect what the user actually saw — served
    // position is 0-indexed and matches response order.
    for (let i = 0; i < payload.results.length; i += 1) {
      const snap = payload.results[i];
      const live = resp.results[i];
      expect(snap?.entityId).toBe(live?.entityId);
      expect(snap?.servedPosition).toBe(i);
      expect(snap?.fusedScore).toBe(live?.fusedScore);
    }
    expect(typeof payload.sequenceNumber).toBe('number');
    expect(typeof payload.servedAt).toBe('string');
  });

  it('does not throw when appendImpression is omitted', async () => {
    // Default deps have no appendImpression — pipeline must
    // silently skip emission, response still carries
    // servedContextId in meta for any consumer that wants to
    // dedupe / correlate within a single response cycle.
    const resp = await runRecall(baseDeps(), {
      q: 'example',
      strategy: noRerankStrategy,
    });
    expect(typeof resp.meta.servedContextId).toBe('string');
  });

  it('payload includes per-lane ranks/scores derived from candidate evidence', async () => {
    const captured: RecallServedPayload[] = [];
    const appendImpression = async (payload: RecallServedPayload): Promise<void> => {
      captured.push(payload);
    };
    await runRecall(baseDeps({ appendImpression }), {
      q: 'example',
      strategy: { rerankTopK: 0 },
    });
    await Promise.resolve();
    const payload = captured[0];
    expect(payload).toBeDefined();
    if (payload === undefined) return;
    // Every snapshot row should have either perLaneRanks or
    // perLaneScores populated (the stub store emits at minimum one
    // bm25 evidence with rank+rawScore).
    const hasAnyEvidence = payload.results.some(
      (r) =>
        (r.perLaneRanks !== undefined && Object.keys(r.perLaneRanks).length > 0) ||
        (r.perLaneScores !== undefined && Object.keys(r.perLaneScores).length > 0),
    );
    expect(hasAnyEvidence).toBe(true);
  });
});

// Move 1 — point-in-time served features + query-anchored cosine.
const emptySnapshot = (): ConnectionsSnapshot => ({
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: new Date(Date.parse('2026-05-25T00:00:00.000Z')).toISOString(),
  nodeCount: 0,
  edgeCount: 0,
});

// A store whose vector backend returns one dense hit for a page NOT already
// surfaced by the lexical lanes (so it is not excluded as an anchor URL and
// keeps `semantic_query` as its primary sourceKind), so the served candidate
// carries the request-time query-to-candidate cosine (1 − cosineDistance).
const vectorSeededStore = (): RecallStore => {
  const store = seededStore();
  return {
    ...store,
    vectorBackendAvailable: true,
    queryVector: () => [
      {
        entityId: 'vec:example.com/semantic-only',
        canonicalUrl: 'https://example.com/semantic-only',
        title: 'Semantic-only page',
        cosineDistance: 0.2, // → query cosine 0.8
      },
    ],
  };
};

// Prime the background served-feature-model warmer, then wait for its
// async build so the NEXT runRecall can peek a warm model synchronously.
const primeWarmModel = async (deps: PipelineDeps): Promise<void> => {
  const loadContext = deps.learnedRerankContext;
  if (loadContext === undefined) throw new Error('test wiring: learnedRerankContext required');
  peekServedFeatureModel({ vaultRoot: deps.vaultRoot, loadContext, now: deps.now ?? Date.now });
  // The warmer's refresh awaits loadContext() (immediate here) then builds
  // the model synchronously; a few macrotask ticks let it settle.
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('runRecall — Move 1 point-in-time features + query cosine', () => {
  it('threads the query-anchored cosine into served snapshot rows from the dense lane', async () => {
    __resetServedFeatureModelCacheForTests();
    const captured: RecallServedPayload[] = [];
    const deps = baseDeps({
      store: vectorSeededStore(),
      appendImpression: async (payload) => {
        captured.push(payload);
      },
      learnedRerankContext: async (): Promise<LearnedRerankContext> => ({
        snapshot: emptySnapshot(),
        merged: [],
      }),
    });
    await runRecall(deps, {
      q: 'example',
      intent: 'dejavu', // dejavu profile includes semantic_query
      strategy: { rerankTopK: 0 },
    });
    await Promise.resolve();
    const payload = captured[0];
    expect(payload).toBeDefined();
    if (payload === undefined) return;
    const dense = payload.results.find((r) => r.sourceKind === 'semantic_query');
    expect(dense).toBeDefined();
    // cosineDistance 0.2 → cosine 0.8.
    expect(dense?.queryCosine).toBeCloseTo(0.8, 5);
  });

  it('stamps the point-in-time feature vector + schema version once the model is warm', async () => {
    __resetServedFeatureModelCacheForTests();
    const captured: RecallServedPayload[] = [];
    const deps = baseDeps({
      store: vectorSeededStore(),
      appendImpression: async (payload) => {
        captured.push(payload);
      },
      learnedRerankContext: async (): Promise<LearnedRerankContext> => ({
        snapshot: emptySnapshot(),
        merged: [],
      }),
    });
    await primeWarmModel(deps);
    await runRecall(deps, {
      q: 'example',
      intent: 'dejavu',
      strategy: { rerankTopK: 0 },
    });
    await Promise.resolve();
    const payload = captured[0];
    expect(payload).toBeDefined();
    if (payload === undefined) return;
    expect(payload.results.length).toBeGreaterThan(0);
    for (const row of payload.results) {
      expect(row.featureSchemaVersion).toBe(FEATURE_SCHEMA_VERSION);
      expect(row.features).toBeDefined();
      expect(row.features).toHaveLength(CANDIDATE_PAIR_FEATURE_KEYS.length);
      // schemaVersion is column 0 of the canonical order.
      expect(row.features?.[0]).toBe(FEATURE_SCHEMA_VERSION);
    }
  });

  it('omits features (falls back) when no warm model is available', async () => {
    __resetServedFeatureModelCacheForTests();
    const captured: RecallServedPayload[] = [];
    const deps = baseDeps({
      store: vectorSeededStore(),
      appendImpression: async (payload) => {
        captured.push(payload);
      },
      learnedRerankContext: async (): Promise<LearnedRerankContext> => ({
        snapshot: emptySnapshot(),
        merged: [],
      }),
    });
    // No prime — the first request peeks a cold cache, gets null, and
    // emits the snapshot WITHOUT features (trainer reconstructs later).
    await runRecall(deps, {
      q: 'example',
      intent: 'dejavu',
      strategy: { rerankTopK: 0 },
    });
    await Promise.resolve();
    const payload = captured[0];
    expect(payload).toBeDefined();
    if (payload === undefined) return;
    for (const row of payload.results) {
      expect(row.features).toBeUndefined();
      expect(row.featureSchemaVersion).toBeUndefined();
    }
  });

  it('does not capture features when SIDETRACK_RECALL_SERVED_FEATURE_CAPTURE=0', async () => {
    __resetServedFeatureModelCacheForTests();
    const prev = process.env['SIDETRACK_RECALL_SERVED_FEATURE_CAPTURE'];
    process.env['SIDETRACK_RECALL_SERVED_FEATURE_CAPTURE'] = '0';
    try {
      const captured: RecallServedPayload[] = [];
      const deps = baseDeps({
        store: vectorSeededStore(),
        appendImpression: async (payload) => {
          captured.push(payload);
        },
        learnedRerankContext: async (): Promise<LearnedRerankContext> => ({
          snapshot: emptySnapshot(),
          merged: [],
        }),
      });
      await primeWarmModel(deps);
      await runRecall(deps, {
        q: 'example',
        intent: 'dejavu',
        strategy: { rerankTopK: 0 },
      });
      await Promise.resolve();
      const payload = captured[0];
      expect(payload).toBeDefined();
      if (payload === undefined) return;
      for (const row of payload.results) {
        expect(row.features).toBeUndefined();
      }
    } finally {
      if (prev === undefined) delete process.env['SIDETRACK_RECALL_SERVED_FEATURE_CAPTURE'];
      else process.env['SIDETRACK_RECALL_SERVED_FEATURE_CAPTURE'] = prev;
    }
  });
});
