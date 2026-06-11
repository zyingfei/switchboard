import { useEffect, useRef, useState } from 'react';

import { messageTypes } from '../messages';

// Now-card "Related" strip — data source.
//
// The first cut of the strip scraped visit-instance anchor ids out of
// the attribution resolver's fusedCandidates. Two structural problems
// killed it: the anchor-id format embeds an ISO timestamp (colon
// parsing broke), and resolver anchors point at the *resolved visit
// itself* in practice, so after self-suppression the strip was
// permanently empty.
//
// This module replaces that with the server-owned path built for this
// exact surface: /v2/recall `intent: 'focus'` (pipeline source profile
// "Now card; current-page-anchored") — direct canonical-URL lookup +
// graph-neighbor expansion, fused/deduped/suppressed server-side. The
// hook rides the same background recallV2Query bridge as search.

export interface FocusedRelatedItem {
  readonly url: string;
  readonly label: string;
}

const EMPTY_RELATED: readonly FocusedRelatedItem[] = [];

// Canonicalization drift in the vault means the same page can appear
// with and without a trailing slash (observed live: openfeature.dev
// vs openfeature.dev/). Compare on a slash-normalized key so those
// variants dedupe and self-suppress.
const urlKeyOf = (u: string): string => (u.endsWith('/') ? u.slice(0, -1) : u);

/** Map raw /v2/recall results → deduped, self-suppressed link items.
 *  Pure; exported for unit tests. */
export const buildFocusedRelatedItems = (
  results: readonly unknown[],
  selfUrl: string,
  max = 6,
): readonly FocusedRelatedItem[] => {
  const selfKey = urlKeyOf(selfUrl);
  const seen = new Set<string>();
  const items: FocusedRelatedItem[] = [];
  for (const raw of results) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as { readonly canonicalUrl?: unknown; readonly title?: unknown };
    const url = typeof r.canonicalUrl === 'string' ? r.canonicalUrl : '';
    if (!/^https?:\/\//u.test(url)) continue;
    const key = urlKeyOf(url);
    // Server suppression catches the exact canonical form; this guard
    // additionally catches slash-variant drift.
    if (key === selfKey || seen.has(key)) continue;
    seen.add(key);
    const title = typeof r.title === 'string' && r.title.trim().length > 0 ? r.title : url;
    items.push({ url, label: title });
    if (items.length >= max) break;
  }
  return items;
};

const RELATED_CACHE_TTL_MS = 5 * 60_000;
const RELATED_CACHE_CAP = 50;
const RELATED_DEBOUNCE_MS = 700;

// Module-level so panel remounts reuse it. Empty results are cached
// too (negative cache) — a page with no neighbors or a dark companion
// must not turn focus changes into a retry storm.
const relatedCache = new Map<
  string,
  { readonly items: readonly FocusedRelatedItem[]; readonly atMs: number }
>();

/** Related pages for the focused tab via /v2/recall intent='focus'.
 *  Pass undefined (or a non-http url) to idle the hook. Returns a
 *  stable empty array until results for the CURRENT url are in. */
export const useFocusedRelatedPages = (
  canonicalUrl: string | undefined,
): readonly FocusedRelatedItem[] => {
  const [state, setState] = useState<{
    readonly url: string;
    readonly items: readonly FocusedRelatedItem[];
  }>({ url: '', items: EMPTY_RELATED });
  // Most-recent requested url — a stale response must not overwrite a
  // newer focus.
  const latestRef = useRef('');

  useEffect(() => {
    const url = canonicalUrl ?? '';
    if (!/^https?:\/\//u.test(url)) {
      latestRef.current = '';
      return undefined;
    }
    latestRef.current = url;
    const cached = relatedCache.get(url);
    if (cached !== undefined && Date.now() - cached.atMs < RELATED_CACHE_TTL_MS) {
      setState({ url, items: cached.items });
      return undefined;
    }
    const timer = setTimeout(() => {
      try {
        chrome.runtime.sendMessage(
          {
            type: messageTypes.recallV2Query,
            req: {
              q: '',
              intent: 'focus',
              limit: 8,
              session: { currentUrl: url },
              // focus intent default keeps the current page (the Now
              // card wants it for the header) — this strip only wants
              // the neighbors, so suppress explicitly.
              suppression: { suppressCurrentPage: 'always' },
            },
          },
          (response: unknown) => {
            // Read lastError first so Chrome doesn't log an unchecked
            // error when the SW is mid-restart.
            const lastError = chrome.runtime.lastError;
            if (latestRef.current !== url) return;
            let items: readonly FocusedRelatedItem[] = EMPTY_RELATED;
            if (lastError === undefined && typeof response === 'object' && response !== null) {
              const wrap = response as { readonly ok?: unknown; readonly results?: unknown };
              if (wrap.ok === true && Array.isArray(wrap.results)) {
                items = buildFocusedRelatedItems(wrap.results, url);
              }
            }
            relatedCache.set(url, { items, atMs: Date.now() });
            if (relatedCache.size > RELATED_CACHE_CAP) {
              const oldest = relatedCache.keys().next().value;
              if (oldest !== undefined) relatedCache.delete(oldest);
            }
            setState({ url, items });
          },
        );
      } catch {
        // sendMessage throws when the extension context is being torn
        // down — nothing to render, next focus change retries.
      }
    }, RELATED_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [canonicalUrl]);

  return state.url === canonicalUrl ? state.items : EMPTY_RELATED;
};
