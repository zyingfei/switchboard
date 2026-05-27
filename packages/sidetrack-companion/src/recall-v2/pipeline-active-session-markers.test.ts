import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runRecall, type PipelineDeps } from './pipeline.js';
import type {
  RecallStore,
  StoreDocument,
  StoreFtsHit,
  StoreSourceKind,
} from './store/types.js';
import type { RecallRequest } from './types.js';

const ACTIVE_BAC_ID = 'active-chat-bac';
const ACTIVE_ENTITY_ID = 'chat:active-session';
const NOW_MS = Date.parse('2026-05-25T00:00:00.000Z');
const OLD_SEEN_MS = Date.parse('2026-05-24T10:00:00.000Z');

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
    ...(doc.lastSeenAtMs === undefined ? {} : { capturedAtMs: doc.lastSeenAtMs }),
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
    entityId: ACTIVE_ENTITY_ID,
    sourceKind: 'chat_turn',
    canonicalUrl: 'https://chat.example/active',
    title: 'Active marker discussion',
    body: 'marker topic active chat',
    threadId: ACTIVE_BAC_ID,
    lastSeenAtMs: OLD_SEEN_MS,
    bodyIndexed: 1,
  });
  store.upsertDocument({
    entityId: 'url:older-marker-page',
    sourceKind: 'page_content',
    canonicalUrl: 'https://example.com/marker-topic',
    title: 'Older marker page',
    body: 'marker topic reference',
    urlTokens: 'example com marker topic',
    host: 'example.com',
    lastSeenAtMs: OLD_SEEN_MS,
    bodyIndexed: 1,
  });
  return store;
};

const deps = (): PipelineDeps => ({
  vaultRoot: mkdtempSync(join(tmpdir(), 'recall-v2-active-marker-')),
  embed: stubEmbed,
  now: () => NOW_MS,
  store: seededStore(),
});

const request = (suppression?: RecallRequest['suppression']): RecallRequest => ({
  q: 'marker topic',
  intent: 'search',
  sources: ['page_content', 'chat_turn'],
  limit: 10,
  perSourceLimit: 10,
  ...(suppression === undefined ? {} : { suppression }),
  strategy: { debug: true, rerankTopK: 0 },
});

describe('runRecall — active session markers', () => {
  it('emits activeSessionMarkers by default for active chat bacIds', async () => {
    const resp = await runRecall(
      deps(),
      request({ suppressActiveChatBacIds: [ACTIVE_BAC_ID] }),
    );

    expect(resp.results.map((r) => r.entityId)).toContain(ACTIVE_ENTITY_ID);
    expect(resp.meta.activeSessionMarkers).toEqual([
      { entityId: ACTIVE_ENTITY_ID, reason: 'recently_created' },
    ]);
  });

  it('does not suppress active-session matches in default marker mode', async () => {
    const withoutActivePolicy = await runRecall(deps(), request());
    const withActivePolicy = await runRecall(
      deps(),
      request({ suppressActiveChatBacIds: [ACTIVE_BAC_ID] }),
    );

    expect(withActivePolicy.results.length).toBe(withoutActivePolicy.results.length);
    expect(withActivePolicy.results.map((r) => r.entityId)).toContain(ACTIVE_ENTITY_ID);
  });

  it('suppresses active-session matches when legacy filtering is explicitly requested', async () => {
    const resp = await runRecall(
      deps(),
      request({
        suppressActiveChatBacIds: [ACTIVE_BAC_ID],
        markActiveSessionsInsteadOfSuppress: false,
      }),
    );

    expect(resp.results.map((r) => r.entityId)).not.toContain(ACTIVE_ENTITY_ID);
    expect(resp.results.length).toBe(1);
    expect(resp.meta.activeSessionMarkers ?? []).toEqual([]);
    expect(
      resp.meta.debug?.droppedExplanations?.some(
        (c) =>
          c.entityId === ACTIVE_ENTITY_ID &&
          c.suppressedReasons?.includes('active-chat') === true,
      ),
    ).toBe(true);
  });
});
