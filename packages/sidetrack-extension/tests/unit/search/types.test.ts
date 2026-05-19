import { describe, expect, it } from 'vitest';

import {
  filterByFacets,
  fromRankedItem,
  fromRecallHit,
  searchFacetOf,
  type SearchHitFacet,
  type UnifiedSearchHit,
} from '../../../src/sidepanel/search/types';

describe('searchFacetOf', () => {
  it('maps sourceKind directly', () => {
    expect(searchFacetOf({ sourceKind: 'page-content' })).toBe('page');
    expect(searchFacetOf({ sourceKind: 'chat-turn' })).toBe('chat');
  });
  it('semantic-recall-pool is its own "similar" facet (even with a thread/url id)', () => {
    expect(searchFacetOf({ sourceKind: 'semantic-recall-pool', threadId: 't1' })).toBe('similar');
    expect(
      searchFacetOf({ sourceKind: 'semantic-recall-pool', canonicalUrl: 'https://a.test/x' }),
    ).toBe('similar');
  });
  it('buckets untyped rows by the identity they carry', () => {
    expect(searchFacetOf({ canonicalUrl: 'https://a.test/x' })).toBe('page');
    expect(searchFacetOf({})).toBe('thread');
  });
});

describe('fromRecallHit', () => {
  it('projects a page-content hit', () => {
    const u = fromRecallHit({
      id: 'h1',
      sourceKind: 'page-content',
      canonicalUrl: 'https://news.ycombinator.com/item?id=1',
      capturedAt: '2026-05-18T00:00:00Z',
      score: 0.9,
      title: 'Show HN: Files.md',
      snippet: 's',
    });
    expect(u).toMatchObject({
      id: 'h1',
      facet: 'page',
      title: 'Show HN: Files.md',
      score: 0.9,
      canonicalUrl: 'https://news.ycombinator.com/item?id=1',
    });
  });
  it('falls back to host then a generic when title is blank', () => {
    expect(fromRecallHit({ id: 'a', sourceKind: 'page-content', canonicalUrl: 'https://www.example.com/p', score: 1 }).title).toBe('example.com');
    expect(fromRecallHit({ id: 'b', sourceKind: 'chat-turn', score: 1 }).title).toBe('Untitled conversation');
  });
  it('semantic hit: facet "similar", similarity from sourceEvidence, NO snippet', () => {
    const u = fromRecallHit({
      id: 's1',
      sourceKind: 'semantic-recall-pool',
      canonicalUrl: 'https://a.test/topic',
      score: 0.4,
      title: 'A related deep-dive',
      snippet: 'should be dropped',
      sourceEvidence: { source: 'semantic_recall_pool', similarity: 0.82, via: 'neighbor' },
    });
    expect(u.facet).toBe('similar');
    expect(u.similarity).toBe(0.82);
    expect(u.snippet).toBeUndefined();
    expect(u.title).toBe('A related deep-dive');
  });
});

describe('fromRankedItem', () => {
  it('is always a thread facet and preserves thread identity', () => {
    const u = fromRankedItem({
      id: 'r1',
      threadId: 'bac_1',
      capturedAt: '2026-05-18T00:00:00Z',
      score: 2.1,
      title: 'Embedding latency chat',
      threadUrl: 'https://chatgpt.com/c/abc',
    });
    expect(u.facet).toBe('thread');
    expect(u.threadId).toBe('bac_1');
    expect(u.title).toBe('Embedding latency chat');
  });
});

describe('filterByFacets', () => {
  const hits: readonly UnifiedSearchHit[] = [
    { id: '1', facet: 'page', title: 'p', score: 1 },
    { id: '2', facet: 'chat', title: 'c', score: 1 },
    { id: '3', facet: 'thread', title: 't', score: 1 },
  ];
  it('returns all when the selection is empty/undefined', () => {
    expect(filterByFacets(hits, undefined)).toBe(hits);
    expect(filterByFacets(hits, new Set<SearchHitFacet>())).toBe(hits);
  });
  it('keeps only the selected facets', () => {
    expect(filterByFacets(hits, new Set<SearchHitFacet>(['chat', 'thread'])).map((h) => h.id)).toEqual(['2', '3']);
  });
});
