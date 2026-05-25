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

// Host-agnostic detection for search-result URLs — mirrors
// timeline/sanitize.ts:detectSearchUrl on the companion side. A URL
// is a "search" if its path is `/` or `/search` AND it carries a `q`
// param. Returns the trimmed query string, or null otherwise.
const SEARCH_PATHS: ReadonlySet<string> = new Set<string>(['/', '/search']);
const searchQueryOf = (parsed: URL): string | null => {
  const rawPath = parsed.pathname.toLowerCase();
  const path = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.replace(/\/+$/u, '') : rawPath;
  const normalized = path.length === 0 ? '/' : path;
  if (!SEARCH_PATHS.has(normalized)) return null;
  const q = parsed.searchParams.get('q');
  if (q === null || q.trim().length === 0) return null;
  return q.trim().toLowerCase();
};

// host + pathname, lowercased, trailing slash stripped, query/hash
// dropped. Provider SPAs append ?session=… / #… drift to the live URL
// that the captured canonicalUrl doesn't carry, so strict equality
// both fails to drop the page you're on and fails to dedupe stale
// duplicates — the same normalization the old recall handler used.
//
// P4 (2026-05-24): search-result URLs are special-cased so that two
// different searches on the same engine (google.com/search?q=A vs
// q=B) get DIFFERENT location keys — otherwise the "drop the page
// you're on" pass would also drop every other prior search on that
// engine, hiding the user's own past queries from recall. Generic
// (host-agnostic) per the source-kind/context-rules principle.
const locationKey = (url: string | undefined): string | undefined => {
  if (url === undefined || url.length === 0) return undefined;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const sq = searchQueryOf(u);
    if (sq !== null) {
      // Stable, case-insensitive query in the key. Whitespace
      // collapsed so "foo  bar" and "foo bar" coalesce.
      const normQuery = sq.replace(/\s+/g, ' ');
      return `${host}${path}?q=${normQuery}`;
    }
    return `${host}${path}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};

const FACET_ORDER: readonly SearchHitFacet[] = [
  'page',
  'chat',
  'similar',
  'visited',
  'thread',
];

// Reciprocal Rank Fusion constant. Standard 60 (Cormack et al.); higher
// k flattens the contribution from top items, lower k makes rank 1
// dominate more aggressively. 60 matches the server-side
// `fuseByRank` constant so cross-tier scores are comparable.
const RRF_K = 60;

// Hits captured within this many ms before `now` are dropped as
// current-session noise (the "I just created this chat 9 minutes ago,
// why is it showing as déjà-vu" case from the 2026-05-24 dogfood).
// 5 minutes balances: kills the self-loop without losing genuine
// short-session repeats. Override via the opts arg in tests.
const DEFAULT_SELF_SUPPRESSION_MS = 5 * 60 * 1000;

// Reciprocal-rank-fusion across one or more response groups. Each
// group is treated as its own "ranker"; a URL that appears in
// multiple groups gets the sum of its 1/(k+rank) contributions, so
// hits that BOTH the lexical primary AND the semantic expansion
// surface end up dominant — which is the right behavior (multi-source
// agreement = stronger signal). Hit metadata is preserved from the
// FIRST group that surfaced the URL (the lexical primary typically
// has snippets that the semantic expansion lacks). Drops the
// currentUrl across all groups. Replaces the prior raw-score sort,
// which was meaningless across page-content (BM25 5-30) vs
// chat-turn (0-1) vs semantic-pool (capped 0.49) — pages always won
// regardless of relevance.
export const buildDejaVuHits = (
  raw: readonly ContentHitLike[] | readonly (readonly ContentHitLike[])[],
  opts: {
    readonly currentUrl: string;
    // Hits whose `capturedAt` is newer than `now - selfSuppressionMs`
    // are dropped — they belong to the current browsing session, not
    // to "déjà-vu" (prior encounters). Defaults to 5 minutes; pass 0
    // to disable.
    readonly selfSuppressionMs?: number;
    // Test-time injection of "now"; defaults to Date.now().
    readonly now?: number;
  },
): BuiltDejaVu => {
  const current = locationKey(opts.currentUrl);
  const now = opts.now ?? Date.now();
  const suppressionMs = opts.selfSuppressionMs ?? DEFAULT_SELF_SUPPRESSION_MS;
  // Accept either a single flat array (back-compat for existing
  // tests and any caller that hasn't migrated) or an array of
  // per-ranker arrays (the new RRF path). The flat input degrades
  // to single-group RRF, which is just stable rank order.
  const groups: readonly (readonly ContentHitLike[])[] =
    raw.length === 0
      ? []
      : Array.isArray((raw as readonly unknown[])[0])
        ? (raw as readonly (readonly ContentHitLike[])[])
        : [raw as readonly ContentHitLike[]];
  const fused = new Map<string, { hit: UnifiedSearchHit; rrf: number }>();
  for (const group of groups) {
    for (let i = 0; i < group.length; i += 1) {
      const row = group[i]!;
      const hit = fromRecallHit(row);
      const loc = locationKey(hit.canonicalUrl ?? hit.threadUrl);
      if (loc !== undefined && loc === current) continue;
      // Self-suppression: a hit captured in the last N ms is most
      // likely the user's just-created content (Ask-AI chat, a fresh
      // tab they're reading right now) — surfacing it as déjà-vu is
      // misleading. Cheap parse; absent capturedAt → no suppression.
      if (suppressionMs > 0 && hit.capturedAt !== undefined) {
        const ts = Date.parse(hit.capturedAt);
        if (!Number.isNaN(ts) && now - ts < suppressionMs) continue;
      }
      const dedupeKey = loc ?? hit.threadId ?? hit.id;
      const contribution = 1 / (RRF_K + (i + 1));
      const prev = fused.get(dedupeKey);
      if (prev === undefined) {
        fused.set(dedupeKey, { hit, rrf: contribution });
      } else {
        prev.rrf += contribution;
        // Upgrade to a richer hit if the new one carries a snippet
        // the old one lacked — keeps RRF score + dedupe identity but
        // surfaces the more informative copy to the user.
        if (
          (prev.hit.snippet === undefined || prev.hit.snippet.length === 0) &&
          hit.snippet !== undefined &&
          hit.snippet.length > 0
        ) {
          fused.set(dedupeKey, { hit, rrf: prev.rrf });
        }
      }
    }
  }
  const hits = [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf)
    // Stamp the RRF score onto the hit so downstream UI / sorting can
    // reason about a single normalized number (raw `score` from the
    // source ranker is preserved on the hit via fromRecallHit; we
    // replace it with rrf here because that's the order that survives
    // the merge — sorting by raw score downstream would undo this).
    .map(({ hit, rrf }) => ({ ...hit, score: rrf }));
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
  visited: 'Visited',
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
  visited: 'Visited',
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
