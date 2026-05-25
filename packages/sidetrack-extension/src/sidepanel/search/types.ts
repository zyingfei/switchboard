// Unified search hit model — the lingua franca the P3 search
// unification converges on.
//
// Today every surface carries its own result shape: `RecallHit`
// (useRecallSearch → /v1/content/query), `RankedItem` (recallClient →
// /v1/recall/query, the live Déjà-vu), plus the companion's
// `ContentSearchHit`. There is no shared type, so a type-filter
// ("pages vs chats vs threads") can't be applied consistently — the
// reason Déjà-vu can't filter like the Connections search.
//
// `UnifiedSearchHit` is the union projection; `searchFacetOf`
// classifies any source row into one of three user-facing facets;
// the adapters are pure and unit-tested so the (browser-only) UI
// migrations become thin mappers on top of this.

export type SearchHitFacet = 'page' | 'chat' | 'thread' | 'similar' | 'visited';

export interface UnifiedSearchHit {
  readonly id: string;
  readonly facet: SearchHitFacet;
  /** Never empty — falls back to a host/derived label then a generic. */
  readonly title: string;
  readonly snippet?: string;
  readonly score: number;
  readonly capturedAt?: string;
  readonly canonicalUrl?: string;
  readonly threadId?: string;
  readonly threadUrl?: string;
  readonly anchorNodeId?: string;
  readonly provider?: string;
  readonly sourceKind?:
    | 'page-content'
    | 'chat-turn'
    | 'semantic-recall-pool'
    | 'timeline-visit';
  /** Cosine similarity (0–1), only on 'similar' (semantic) hits. */
  readonly similarity?: number;
}

// --- the extension-side source shapes the adapters consume (kept
// structural so we don't couple to the companion package) ---

interface RecallHitLike {
  readonly id: string;
  readonly sourceKind?:
    | 'page-content'
    | 'chat-turn'
    | 'semantic-recall-pool'
    | 'timeline-visit';
  readonly anchorNodeId?: string;
  readonly threadId?: string;
  readonly canonicalUrl?: string;
  readonly capturedAt?: string;
  readonly score: number;
  readonly title?: string;
  readonly threadUrl?: string;
  readonly snippet?: string;
  readonly sourceEvidence?: {
    readonly source: 'semantic_recall_pool';
    readonly similarity: number;
    readonly via: 'cluster' | 'neighbor' | 'query-cosine';
  };
}

interface RankedItemLike {
  readonly id: string;
  readonly threadId: string;
  readonly capturedAt: string;
  readonly score: number;
  readonly title?: string;
  readonly snippet?: string;
  readonly threadUrl?: string;
  readonly provider?: string;
}

const hostOf = (url: string | undefined): string | undefined => {
  if (url === undefined || url.length === 0) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
};

const coalesceTitle = (
  title: string | undefined,
  url: string | undefined,
  fallback: string,
): string => {
  const t = title?.trim();
  if (t !== undefined && t.length > 0) return t;
  return hostOf(url) ?? fallback;
};

/**
 * Classify a content-recall row. `page-content` → page, `chat-turn` →
 * chat; the semantic-recall expansion and untyped rows are bucketed by
 * what identity they carry (a thread id ⇒ chat, a canonical URL ⇒
 * page) so the facet filter stays meaningful even for fuzzy hits.
 */
export const searchFacetOf = (hit: {
  readonly sourceKind?:
    | 'page-content'
    | 'chat-turn'
    | 'semantic-recall-pool'
    | 'timeline-visit';
  readonly threadId?: string;
  readonly canonicalUrl?: string;
}): SearchHitFacet => {
  // Semantic-recall-pool is a vector-similarity expansion, not an
  // exact text hit — its own facet so the user can see/filter it
  // apart from real page/chat matches.
  if (hit.sourceKind === 'semantic-recall-pool') return 'similar';
  // P1 (2026-05-24): timeline-visit is title+URL evidence only —
  // "we know you've been there". Own facet so it doesn't masquerade
  // as a body-indexed page hit AND so the user can filter to "just
  // things I visited" separately from full-text matches.
  if (hit.sourceKind === 'timeline-visit') return 'visited';
  if (hit.sourceKind === 'page-content') return 'page';
  if (hit.sourceKind === 'chat-turn') return 'chat';
  if (hit.threadId !== undefined && hit.threadId.length > 0) return 'chat';
  if (hit.canonicalUrl !== undefined && hit.canonicalUrl.length > 0) return 'page';
  return 'thread';
};

/** From a useRecallSearch `RecallHit` (/v1/content/query results). */
export const fromRecallHit = (h: RecallHitLike): UnifiedSearchHit => {
  const facet = searchFacetOf(h);
  const similarity = h.sourceEvidence?.similarity;
  // 'similar' (semantic) hits intentionally carry NO snippet — they
  // are a topical/vector match, not an exact-text hit, so we surface
  // only the title + similarity (per the user's spec).
  const keepSnippet = facet !== 'similar' && h.snippet !== undefined;
  return {
    id: h.id,
    facet,
    title: coalesceTitle(
      h.title,
      h.canonicalUrl ?? h.threadUrl,
      facet === 'page' ? 'Untitled page' : 'Untitled conversation',
    ),
    ...(keepSnippet ? { snippet: h.snippet } : {}),
    ...(similarity === undefined ? {} : { similarity }),
    score: h.score,
    ...(h.capturedAt === undefined ? {} : { capturedAt: h.capturedAt }),
    ...(h.canonicalUrl === undefined ? {} : { canonicalUrl: h.canonicalUrl }),
    ...(h.threadId === undefined ? {} : { threadId: h.threadId }),
    ...(h.threadUrl === undefined ? {} : { threadUrl: h.threadUrl }),
    ...(h.anchorNodeId === undefined ? {} : { anchorNodeId: h.anchorNodeId }),
    ...(h.sourceKind === undefined ? {} : { sourceKind: h.sourceKind }),
  };
};

/** From a recallClient `RankedItem` (/v1/recall/query — live Déjà-vu).
 *  These are always indexed-conversation thread chunks. */
export const fromRankedItem = (h: RankedItemLike): UnifiedSearchHit => ({
  id: h.id,
  facet: 'thread',
  title: coalesceTitle(h.title, h.threadUrl, 'Untitled conversation'),
  ...(h.snippet === undefined ? {} : { snippet: h.snippet }),
  score: h.score,
  capturedAt: h.capturedAt,
  threadId: h.threadId,
  ...(h.threadUrl === undefined ? {} : { threadUrl: h.threadUrl }),
  ...(h.provider === undefined ? {} : { provider: h.provider }),
});

/** Facet filter — an empty/undefined selection means "no filter". */
export const filterByFacets = (
  hits: readonly UnifiedSearchHit[],
  facets: ReadonlySet<SearchHitFacet> | undefined,
): readonly UnifiedSearchHit[] => {
  if (facets === undefined || facets.size === 0) return hits;
  return hits.filter((h) => facets.has(h.facet));
};
