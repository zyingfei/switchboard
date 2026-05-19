// Déjà-vu model — pure transforms behind the on-page "Seen this
// before" popover. Phase 3 of the P3 search unification: Déjà-vu used
// to query threads-only (/v1/recall/query, RankedItem) so every
// result was one type and a Connections-style type filter was
// meaningless. It now feeds off the unified content backend
// (/v1/content/query → page-content + chat-turn) and projects through
// the shared UnifiedSearchHit model so the popover gets real
// page/chat facets to filter by.
//
// Kept separate from the raw-DOM mount so the dedupe / current-page
// drop / facet derivation is unit-tested (the DOM wiring stays thin).

import {
  filterByFacets,
  fromRecallHit,
  type SearchHitFacet,
  type UnifiedSearchHit,
} from '../sidepanel/search/types';

export type DejaVuFacetFilter = 'all' | SearchHitFacet;

export interface ContentHitLike {
  readonly id: string;
  readonly sourceKind?: 'page-content' | 'chat-turn' | 'semantic-recall-pool';
  readonly anchorNodeId?: string;
  readonly canonicalUrl?: string;
  readonly threadId?: string;
  readonly capturedAt?: string;
  readonly score: number;
  readonly title?: string;
  readonly threadUrl?: string;
  readonly snippet?: string;
  readonly sourceEvidence?: {
    readonly source: 'semantic_recall_pool';
    readonly similarity: number;
    readonly via: 'cluster' | 'neighbor';
  };
}

export interface BuiltDejaVu {
  /** Current-page-dropped, deduped, score-sorted. */
  readonly hits: readonly UnifiedSearchHit[];
  /** Facets actually present, in a stable page→chat→thread order. */
  readonly facets: readonly SearchHitFacet[];
}

// host + pathname, lowercased, trailing slash stripped, query/hash
// dropped. Provider SPAs append ?session=… / #… drift to the live URL
// that the captured canonicalUrl doesn't carry, so strict equality
// both fails to drop the page you're on and fails to dedupe stale
// duplicates — the same normalization the old recall handler used.
const locationKey = (url: string | undefined): string | undefined => {
  if (url === undefined || url.length === 0) return undefined;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname.replace(/^www\./, '')}${path}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};

const FACET_ORDER: readonly SearchHitFacet[] = ['page', 'chat', 'similar', 'thread'];

export const buildDejaVuHits = (
  raw: readonly ContentHitLike[],
  opts: { readonly currentUrl: string },
): BuiltDejaVu => {
  const current = locationKey(opts.currentUrl);
  const seen = new Set<string>();
  const hits: UnifiedSearchHit[] = [];
  for (const row of raw) {
    const hit = fromRecallHit(row);
    const loc = locationKey(hit.canonicalUrl ?? hit.threadUrl);
    if (loc !== undefined && loc === current) continue; // drop the page you're on
    const dedupeKey = loc ?? hit.threadId ?? hit.id;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score);
  const facets = FACET_ORDER.filter((f) => hits.some((h) => h.facet === f));
  return { hits, facets };
};

export const filterDejaVu = (
  hits: readonly UnifiedSearchHit[],
  filter: DejaVuFacetFilter,
): readonly UnifiedSearchHit[] =>
  filter === 'all' ? hits : filterByFacets(hits, new Set<SearchHitFacet>([filter]));

const FACET_LABEL: Record<SearchHitFacet, string> = {
  page: 'Page',
  chat: 'Chat',
  similar: 'Similar',
  thread: 'Thread',
};
/** Singular — used for the per-row facet tag. */
export const dejaVuFacetLabel = (facet: SearchHitFacet): string => FACET_LABEL[facet];
// Plural — used for the filter chips ("Pages"/"Chats"); "Similar"
// stays as-is (not a count noun).
const FACET_CHIP_LABEL: Record<SearchHitFacet, string> = {
  page: 'Pages',
  chat: 'Chats',
  similar: 'Similar',
  thread: 'Threads',
};
export const dejaVuFacetChipLabel = (facet: SearchHitFacet): string =>
  FACET_CHIP_LABEL[facet];

// Service category — a SECOND, orthogonal filter dimension for the
// chips (the user's "AI Chats" / "Google Services" grouping).
// Deliberately NOT folded into ProviderId: that type drives capture
// composer/send selectors for *chat* providers, so adding google /
// translate there would risk that machinery. This is a pure
// URL→category classifier used only by the Déjà-vu chips + row tag.
export type DejaVuCategory = 'ai-chat' | 'google' | 'web';

const AI_CHAT_HOST = [
  /(^|\.)chatgpt\.com$/,
  /(^|\.)chat\.openai\.com$/,
  /(^|\.)openai\.com$/,
  /(^|\.)claude\.ai$/,
  /(^|\.)gemini\.google\.com$/,
  /(^|\.)bard\.google\.com$/,
  /(^|\.)aistudio\.google\.com$/,
];
// Google Services EXCLUDING the Google-owned AI chats above (checked
// first, so gemini/aistudio land in 'ai-chat', not here).
const GOOGLE_HOST = [
  /(^|\.)translate\.google\.[a-z.]+$/,
  /(^|\.)google\.[a-z.]+$/,
  /(^|\.)docs\.google\.[a-z.]+$/,
];

export const dejaVuCategoryOf = (url: string | undefined): DejaVuCategory => {
  if (url === undefined || url.length === 0) return 'web';
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'web';
  }
  if (AI_CHAT_HOST.some((re) => re.test(host))) return 'ai-chat';
  if (GOOGLE_HOST.some((re) => re.test(host))) return 'google';
  return 'web';
};

const CATEGORY_LABEL: Record<DejaVuCategory, string> = {
  'ai-chat': 'AI Chats',
  google: 'Google',
  web: 'Web',
};
export const dejaVuCategoryLabel = (category: DejaVuCategory): string =>
  CATEGORY_LABEL[category];

/** Present categories in a stable ai-chat→google→web order. */
export const dejaVuCategoriesPresent = (
  hits: readonly { readonly canonicalUrl?: string; readonly threadUrl?: string }[],
): readonly DejaVuCategory[] => {
  const order: readonly DejaVuCategory[] = ['ai-chat', 'google', 'web'];
  const have = new Set(hits.map((h) => dejaVuCategoryOf(h.canonicalUrl ?? h.threadUrl)));
  return order.filter((c) => have.has(c));
};
