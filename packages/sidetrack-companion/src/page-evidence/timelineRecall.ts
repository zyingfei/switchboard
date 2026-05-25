// Timeline-visit candidate source for /v1/content/query.
//
// Closes the "I visited this page two days ago, why doesn't it
// surface?" gap exposed by the 2026-05-24 dogfood case study. The
// page-content pool only indexes pages whose body got extracted via
// Mozilla Readability — Readability bails on HN threaded comments,
// Google SERP DOM, most JS-heavy SPAs, and any short-stay visit
// where auto-extract hadn't run. Those URLs DO have page-evidence
// records (title + URL captured on every visit), so we can recall
// them with a lightweight title-only MiniSearch and surface them as
// `sourceKind: 'timeline-visit'` hits.
//
// Intentionally tiny and stateless — no cluster math, no embeddings,
// just lexical match over `{title, url}` fields with the SAME
// analyzer the page-content pool uses (so the same selection
// tokenizes consistently across sources).

import MiniSearch from 'minisearch';

import { listPageEvidenceRecords } from './store.js';
import { analyze } from '../search/analyzer.js';
import type { ContentSearchHit } from '../page-content/types.js';

// Cache the built index per (vault, mtime-hash) so repeated queries
// don't re-list + re-build. Same strategy as the page-content
// lexical index. Coarser invalidation: rebuild when the count
// changes — page-evidence records are small and the rebuild is
// O(N) with N small (no chunk fan-out like page-content).
let cached:
  | { vaultRoot: string; recordCount: number; index: TimelineVisitIndex }
  | null = null;

interface TimelineVisitEntry {
  readonly canonicalUrl: string;
  readonly title?: string;
  readonly host: string;
  readonly lastSeenAt?: string;
  readonly firstSeenAt?: string;
}

interface TimelineVisitIndex {
  readonly mini: MiniSearch<{
    id: string;
    text: string;
    title: string;
    host: string;
  }>;
  readonly byUrl: Map<string, TimelineVisitEntry>;
}

const buildIndex = (entries: readonly TimelineVisitEntry[]): TimelineVisitIndex => {
  const mini = new MiniSearch<{
    id: string;
    text: string;
    title: string;
    host: string;
  }>({
    fields: ['text', 'title', 'host'],
    storeFields: ['id'],
    idField: 'id',
    tokenize: analyze,
    processTerm: (term) => term.toLowerCase(),
    searchOptions: {
      tokenize: analyze,
      processTerm: (term) => term.toLowerCase(),
      // Title carries the most signal; host is a weak tiebreaker;
      // `text` is the URL path tokens (slugs encode topical clues
      // — "claude-is-not-your-architect"). Boosts roughly mirror
      // the page-content index so cross-tier RRF ranks comparably.
      boost: { title: 2, text: 1, host: 0.5 },
      prefix: true,
      fuzzy: 0.15,
    },
  });
  const byUrl = new Map<string, TimelineVisitEntry>();
  for (const e of entries) {
    byUrl.set(e.canonicalUrl, e);
    // The "text" field is the URL's pathname (slug tokens). Lets
    // a query like "claude" match a URL with /claude-is-not-…
    // even when the captured title is empty (auto-capture failures).
    let pathText = '';
    try {
      pathText = new URL(e.canonicalUrl).pathname.replace(/[/_-]+/g, ' ');
    } catch {
      // Fallback for non-parseable URLs — use as-is.
      pathText = e.canonicalUrl;
    }
    mini.add({
      id: e.canonicalUrl,
      text: pathText,
      title: e.title ?? '',
      host: e.host,
    });
  }
  return { mini, byUrl };
};

const ensureIndex = async (vaultRoot: string): Promise<TimelineVisitIndex> => {
  const records = await listPageEvidenceRecords(vaultRoot);
  if (
    cached?.vaultRoot === vaultRoot &&
    cached.recordCount === records.length
  ) {
    return cached.index;
  }
  const entries: TimelineVisitEntry[] = records.map((r) => ({
    canonicalUrl: r.canonicalUrl,
    ...(r.metadata.title === undefined ? {} : { title: r.metadata.title }),
    host: r.metadata.host,
    ...(r.metadata.lastSeenAt === undefined ? {} : { lastSeenAt: r.metadata.lastSeenAt }),
    ...(r.metadata.firstSeenAt === undefined ? {} : { firstSeenAt: r.metadata.firstSeenAt }),
  }));
  const index = buildIndex(entries);
  cached = { vaultRoot, recordCount: records.length, index };
  return index;
};

export const queryTimelineVisits = async (
  vaultRoot: string,
  q: string,
  options: { readonly limit?: number } = {},
): Promise<readonly ContentSearchHit[]> => {
  const trimmed = q.trim();
  if (trimmed.length === 0) return [];
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const index = await ensureIndex(vaultRoot);
  const results = index.mini.search(trimmed);
  const nowIso = new Date().toISOString();
  const out: ContentSearchHit[] = [];
  for (let i = 0; i < results.length && out.length < limit; i += 1) {
    const result = results[i]!;
    const entry = index.byUrl.get(result.id as string);
    if (entry === undefined) continue;
    out.push({
      // ID namespaced so RRF dedupe across sources doesn't collide
      // with page-content chunk IDs.
      id: `timeline-visit:${entry.canonicalUrl}`,
      sourceKind: 'timeline-visit',
      anchorNodeId: `timeline-visit:${entry.canonicalUrl}`,
      canonicalUrl: entry.canonicalUrl,
      title: entry.title ?? entry.canonicalUrl,
      // No body extracted → no snippet. The UI degrades to title-only
      // for these rows (the "we know you've been there" affordance).
      score: result.score,
      // "When did I first encounter this URL?" — same semantics the
      // semantic-recall expansion uses, so the relativeWhen pill
      // means the same thing across tiers.
      capturedAt: entry.firstSeenAt ?? entry.lastSeenAt ?? nowIso,
    });
  }
  return out;
};

// Test-only: drops the in-memory index cache. Lets unit tests build
// fresh indexes per case without leaking state across describes.
export const __resetTimelineRecallCacheForTests = (): void => {
  cached = null;
};
