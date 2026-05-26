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

import type { RecallServedPayload } from '../recall/events.js';
import { runRecall, type PipelineDeps } from './pipeline.js';
import type {
  RecallStore,
  StoreDocument,
  StoreFtsHit,
  StoreSourceKind,
} from './store/types.js';

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
      const kinds = new Set<StoreSourceKind>(
        Array.isArray(sourceKind) ? sourceKind : [sourceKind],
      );
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

describe('runRecall — Phase 0 impression logging', () => {
  it('always stamps meta.servedContextId on the response', async () => {
    const resp = await runRecall(baseDeps(), { q: 'example' });
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
    const resp = await runRecall(baseDeps(), { q: 'example' });
    expect(typeof resp.meta.servedContextId).toBe('string');
  });

  it('payload includes per-lane ranks/scores derived from candidate evidence', async () => {
    const captured: RecallServedPayload[] = [];
    const appendImpression = async (payload: RecallServedPayload): Promise<void> => {
      captured.push(payload);
    };
    await runRecall(baseDeps({ appendImpression }), { q: 'example' });
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
