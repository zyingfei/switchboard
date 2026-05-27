// Recall v2 — intent profile + focus source unit tests.
//
// Verifies the Scope A/B/C contract:
//   - `intent: 'dejavu' | 'search' | 'focus'` selects a source profile
//   - per-intent suppression defaults apply when caller omits suppression
//   - `focus` source generator does a direct canonical-URL lookup
//   - response.meta.intent echoes the resolved intent
//
// Uses a hand-rolled in-memory `RecallStore` stub so the test does NOT
// require the bun:sqlite driver — vitest runs under node here, and the
// real SQLite store is bun-only. The stub implements just enough of
// the interface for queryFts (substring match on title/body) and
// queryByCanonicalUrl (exact url match).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runRecall, type PipelineDeps } from './pipeline.js';
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
    body: 'this is the body extracted from the example page',
    urlTokens: 'example com page',
    host: 'example.com',
    lastSeenAtMs: Date.parse('2026-05-24T10:00:00.000Z'),
    bodyIndexed: 1,
  });
  store.upsertDocument({
    entityId: 'tv:other.com/foo',
    sourceKind: 'timeline_visit',
    canonicalUrl: 'https://other.com/foo',
    title: 'Unrelated other thing',
    urlTokens: 'other com foo',
    host: 'other.com',
    lastSeenAtMs: Date.parse('2026-05-24T10:00:00.000Z'),
    bodyIndexed: 0,
  });
  return store;
};

const deps = (overrides?: Partial<PipelineDeps>): PipelineDeps => ({
  vaultRoot: mkdtempSync(join(tmpdir(), 'recall-v2-intent-')),
  embed: stubEmbed,
  now: () => Date.parse('2026-05-25T00:00:00.000Z'),
  store: seededStore(),
  ...overrides,
});

describe('runRecall — intent profiles', () => {
  it('defaults to dejavu intent when none specified', async () => {
    const resp = await runRecall(deps(), { q: 'example' });
    expect(resp.meta.intent).toBe('dejavu');
  });

  it('echoes intent in response meta', async () => {
    const search = await runRecall(deps(), { q: 'example', intent: 'search' });
    expect(search.meta.intent).toBe('search');

    const focus = await runRecall(deps(), {
      q: '',
      intent: 'focus',
      session: { currentUrl: 'https://example.com/page' },
    });
    expect(focus.meta.intent).toBe('focus');
  });

  it('search intent does NOT suppress the current page by default', async () => {
    // dejavu intent — current page suppressed (default 'always')
    const dejavu = await runRecall(deps(), {
      q: 'example',
      intent: 'dejavu',
      session: { currentUrl: 'https://example.com/page' },
    });
    const dejavuUrls = dejavu.results.map((r) => r.canonicalUrl);
    expect(dejavuUrls).not.toContain('https://example.com/page');

    // search intent — current page surfaces (default 'never')
    const search = await runRecall(deps(), {
      q: 'example',
      intent: 'search',
      session: { currentUrl: 'https://example.com/page' },
    });
    const searchUrls = search.results.map((r) => r.canonicalUrl);
    expect(searchUrls).toContain('https://example.com/page');
  });

  it('search intent allows fresh hits (no minHitAgeMs default)', async () => {
    // Simulate a "just captured" doc with capturedAt < 5min from now.
    const fresh = makeStubStore();
    fresh.upsertDocument({
      entityId: 'tv:fresh.com/page',
      sourceKind: 'timeline_visit',
      canonicalUrl: 'https://fresh.com/page',
      title: 'fresh page',
      urlTokens: 'fresh com page',
      host: 'fresh.com',
      lastSeenAtMs: Date.parse('2026-05-25T00:00:00.000Z') - 60_000, // 1min old
      bodyIndexed: 0,
    });
    // Search — should surface (no min-age suppression)
    const search = await runRecall(deps({ store: fresh }), {
      q: 'fresh',
      intent: 'search',
    });
    const urls = search.results.map((r) => r.canonicalUrl);
    expect(urls).toContain('https://fresh.com/page');
  });

  it('focus intent includes the focus source generator', async () => {
    const resp = await runRecall(deps(), {
      q: '',
      intent: 'focus',
      session: { currentUrl: 'https://example.com/page' },
    });
    // perSourceCounts records what each source contributed; focus
    // should have surfaced the seeded example.com/page row.
    expect(resp.meta.fusion.perSourceCounts.focus).toBeGreaterThan(0);
    // The result list should include the active page
    const urls = resp.results.map((r) => r.canonicalUrl);
    expect(urls).toContain('https://example.com/page');
    // And at least one row should carry sourceKind: 'focus'
    const focusRows = resp.results.filter((r) => r.sourceKind === 'focus');
    expect(focusRows.length).toBeGreaterThan(0);
  });

  it('focus intent without a session.currentUrl yields zero focus candidates', async () => {
    const resp = await runRecall(deps(), { q: '', intent: 'focus' });
    expect(resp.meta.fusion.perSourceCounts.focus).toBe(0);
  });

  it('explicit suppression on the request overrides intent defaults', async () => {
    // Caller passes suppressCurrentPage='always' under the search intent
    // (which would normally be 'never'). The explicit policy wins.
    const resp = await runRecall(deps(), {
      q: 'example',
      intent: 'search',
      session: { currentUrl: 'https://example.com/page' },
      suppression: { suppressCurrentPage: 'always' },
    });
    const urls = resp.results.map((r) => r.canonicalUrl);
    expect(urls).not.toContain('https://example.com/page');
  });

  it('explicit sources on the request overrides intent defaults', async () => {
    // Caller asks for ONLY timeline_visit, with focus intent — the
    // focus source should NOT run even though focus is the default
    // for this intent. Pass a non-empty q so timeline_visit's FTS5
    // query has tokens to match against.
    const resp = await runRecall(deps(), {
      q: 'example',
      intent: 'focus',
      sources: ['timeline_visit'],
      session: { currentUrl: 'https://example.com/page' },
    });
    expect(resp.meta.fusion.perSourceCounts.focus).toBe(0);
    expect(resp.meta.fusion.perSourceCounts.timeline_visit).toBeGreaterThan(0);
  });
});
