import { describe, expect, it } from 'vitest';

import {
  buildDejaVuHits,
  dejaVuCategoriesPresent,
  dejaVuCategoryLabel,
  dejaVuCategoryOf,
  dejaVuFacetChipLabel,
  dejaVuFacetLabel,
  filterDejaVu,
  type ContentHitLike,
} from '../../../src/contentOverlays/dejaVuModel';

const hit = (o: Partial<ContentHitLike> & { id: string; score: number }): ContentHitLike => o;

describe('buildDejaVuHits', () => {
  it('drops the page you are currently on (query/hash/trailing-slash insensitive)', () => {
    const built = buildDejaVuHits(
      [
        hit({ id: 'a', sourceKind: 'page-content', canonicalUrl: 'https://example.com/p', score: 1 }),
        hit({ id: 'b', sourceKind: 'chat-turn', threadId: 't1', score: 2 }),
      ],
      { currentUrl: 'https://www.example.com/p/?utm=x#frag' },
    );
    expect(built.hits.map((h) => h.id)).toEqual(['b']);
  });

  it('dedupes by location then preserves input rank (RRF order)', () => {
    // P2 (2026-05-24): buildDejaVuHits now uses Reciprocal Rank Fusion
    // instead of raw-score sort, because raw scores are not
    // comparable across rankers (BM25 5-30 vs cosine 0-0.49). Input
    // order is treated as the ranker's rank order. For a single
    // input array, that means the FIRST occurrence wins — the score
    // field on input rows is not consulted for ordering.
    const built = buildDejaVuHits(
      [
        hit({ id: 'low', sourceKind: 'page-content', canonicalUrl: 'https://a.test/x', score: 0.2 }),
        hit({ id: 'dup', sourceKind: 'page-content', canonicalUrl: 'https://a.test/x?q=1', score: 0.9 }),
        hit({ id: 'chat', sourceKind: 'chat-turn', threadId: 't9', score: 0.5 }),
      ],
      { currentUrl: 'https://here.test/now' },
    );
    // 'low' (rank 1) gets RRF 1/61; 'dup' (rank 2) dedupes into
    // 'low' adding 1/62; 'chat' (rank 3) gets 1/63. So 'low' wins
    // (because of double contribution) and 'chat' is second.
    expect(built.hits.map((h) => h.id)).toEqual(['low', 'chat']);
  });

  it('derives only the facets actually present, in page→chat→similar order', () => {
    const built = buildDejaVuHits(
      [
        hit({ id: 'c', sourceKind: 'chat-turn', threadId: 't1', score: 1 }),
        hit({
          id: 's',
          sourceKind: 'semantic-recall-pool',
          canonicalUrl: 'https://x.test/sim',
          score: 0.3,
          sourceEvidence: { source: 'semantic_recall_pool', similarity: 0.7, via: 'cluster' },
        }),
        hit({ id: 'p', sourceKind: 'page-content', canonicalUrl: 'https://x.test/a', score: 1 }),
      ],
      { currentUrl: 'https://here.test/now' },
    );
    expect(built.facets).toEqual(['page', 'chat', 'similar']);
  });
});

describe('filterDejaVu', () => {
  const built = buildDejaVuHits(
    [
      hit({ id: 'p', sourceKind: 'page-content', canonicalUrl: 'https://x.test/a', score: 1 }),
      hit({ id: 'c', sourceKind: 'chat-turn', threadId: 't1', score: 1 }),
    ],
    { currentUrl: 'https://here.test/now' },
  );
  it('"all" is identity', () => {
    expect(filterDejaVu(built.hits, 'all')).toBe(built.hits);
  });
  it('a facet filter narrows', () => {
    expect(filterDejaVu(built.hits, 'page').map((h) => h.id)).toEqual(['p']);
    expect(filterDejaVu(built.hits, 'chat').map((h) => h.id)).toEqual(['c']);
  });
});

describe('dejaVuFacetLabel', () => {
  it('labels facets singular (per-row tag)', () => {
    expect(dejaVuFacetLabel('page')).toBe('Page');
    expect(dejaVuFacetLabel('chat')).toBe('Chat');
    expect(dejaVuFacetLabel('similar')).toBe('Similar');
    expect(dejaVuFacetLabel('thread')).toBe('Thread');
  });
  it('labels facets plural for chips ("Similar" stays)', () => {
    expect(dejaVuFacetChipLabel('page')).toBe('Pages');
    expect(dejaVuFacetChipLabel('chat')).toBe('Chats');
    expect(dejaVuFacetChipLabel('similar')).toBe('Similar');
    expect(dejaVuFacetChipLabel('thread')).toBe('Threads');
  });
});

describe('dejaVuCategoryOf', () => {
  it('classifies AI chats (incl. Google-owned gemini/aistudio)', () => {
    expect(dejaVuCategoryOf('https://chatgpt.com/c/abc')).toBe('ai-chat');
    expect(dejaVuCategoryOf('https://claude.ai/chat/x')).toBe('ai-chat');
    expect(dejaVuCategoryOf('https://gemini.google.com/app/1')).toBe('ai-chat');
    expect(dejaVuCategoryOf('https://aistudio.google.com/prompts/2')).toBe('ai-chat');
  });
  it('classifies Google services (search / translate / docs) — AI-owned subdomains excluded', () => {
    expect(dejaVuCategoryOf('https://www.google.com/search?q=x')).toBe('google');
    expect(dejaVuCategoryOf('https://translate.google.com/?sl=en')).toBe('google');
    expect(dejaVuCategoryOf('https://docs.google.com/document/d/1')).toBe('google');
    expect(dejaVuCategoryOf('https://google.co.uk/search?q=y')).toBe('google');
  });
  it('everything else is web; bad/empty input is web', () => {
    expect(dejaVuCategoryOf('https://news.ycombinator.com/item?id=1')).toBe('web');
    expect(dejaVuCategoryOf('not a url')).toBe('web');
    expect(dejaVuCategoryOf(undefined)).toBe('web');
  });
});

describe('dejaVuCategoriesPresent', () => {
  it('returns present categories in ai-chat→google→web order', () => {
    expect(
      dejaVuCategoriesPresent([
        { canonicalUrl: 'https://news.ycombinator.com/a' },
        { canonicalUrl: 'https://chatgpt.com/c/1' },
        { threadUrl: 'https://translate.google.com/' },
      ]),
    ).toEqual(['ai-chat', 'google', 'web']);
    expect(dejaVuCategoriesPresent([{ canonicalUrl: 'https://x.test/a' }])).toEqual(['web']);
  });
});

describe('dejaVuCategoryLabel', () => {
  it('labels categories', () => {
    expect(dejaVuCategoryLabel('ai-chat')).toBe('AI Chats');
    expect(dejaVuCategoryLabel('google')).toBe('Google');
    expect(dejaVuCategoryLabel('web')).toBe('Web');
  });
});
