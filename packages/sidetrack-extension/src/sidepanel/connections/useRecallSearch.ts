import { useEffect, useRef, useState } from 'react';

import { messageTypes } from '../../messages';
import { SEARCH_DEBOUNCE_MS, SEARCH_MIN_QUERY_CHARS } from '../search/constants';

// Scope A — Search migrates from /v1/content/query → /v2/recall with
// intent='search'. The server owns query analysis, source selection,
// fusion, dedupe, and suppression so the hook just sends the request,
// parses the response, and surfaces hits as RecallHit[] for the
// existing renderers (SearchTab, NodeSearchBox).
//
// Why use intent='search' and not the dejavu defaults: search has no
// current-page context, so suppressCurrentPage is 'never' and
// minHitAgeMs is 0 — the user typed a query and a fresh hit (a chat
// they created 30 seconds ago) IS the right answer.
//
// The hook debounces (default 300ms), skips short queries (< 3 chars),
// and exposes `{ items, loading, error }` with a stable empty-array
// reference so consumers don't churn re-renders.

export interface RecallHit {
  readonly id: string;
  readonly sourceKind?: 'page-content' | 'chat-turn';
  readonly anchorNodeId?: string;
  readonly threadId?: string;
  readonly canonicalUrl?: string;
  readonly capturedAt: string;
  readonly score: number;
  readonly title?: string;
  readonly threadUrl?: string;
  readonly snippet?: string;
}

interface RecallSearchState {
  readonly query: string;
  readonly items: readonly RecallHit[];
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_ITEMS: readonly RecallHit[] = [];

// Map /v2/recall's sourceKind (page_content / timeline_visit /
// chat_turn / semantic_query / graph_neighbor / focus) → the legacy
// RecallHit shape this hook's consumers already understand. Both
// 'page-content' and 'chat-turn' map cleanly; everything else groups
// under 'page-content' since the hook doesn't distinguish lexical
// vs semantic for the user.
const legacySourceKindOf = (k: string): RecallHit['sourceKind'] => {
  if (k === 'chat_turn') return 'chat-turn';
  return 'page-content';
};

// Map a v2 RecallCandidate (opaque record-shape, since we don't
// import the companion types into the extension) into a RecallHit.
// Picks `candidateId`/`entityId` for the row id, prefers the
// canonical url for the anchor, and surfaces snippet/title for the
// renderer to display.
const hitFromV2Candidate = (
  raw: unknown,
): RecallHit | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as {
    readonly candidateId?: unknown;
    readonly entityId?: unknown;
    readonly sourceKind?: unknown;
    readonly canonicalUrl?: unknown;
    readonly title?: unknown;
    readonly snippet?: unknown;
    readonly threadId?: unknown;
    readonly fusedScore?: unknown;
    readonly lastSeenAt?: unknown;
    readonly firstSeenAt?: unknown;
  };
  const id =
    typeof r.candidateId === 'string'
      ? r.candidateId
      : typeof r.entityId === 'string'
        ? r.entityId
        : null;
  if (id === null) return null;
  const capturedAt =
    typeof r.lastSeenAt === 'string'
      ? r.lastSeenAt
      : typeof r.firstSeenAt === 'string'
        ? r.firstSeenAt
        : new Date().toISOString();
  const sourceKind =
    typeof r.sourceKind === 'string' ? legacySourceKindOf(r.sourceKind) : 'page-content';
  return {
    id,
    sourceKind,
    capturedAt,
    score: typeof r.fusedScore === 'number' ? r.fusedScore : 0,
    ...(typeof r.canonicalUrl === 'string' ? { canonicalUrl: r.canonicalUrl } : {}),
    ...(typeof r.title === 'string' ? { title: r.title } : {}),
    ...(typeof r.snippet === 'string' ? { snippet: r.snippet } : {}),
    ...(typeof r.threadId === 'string' ? { threadId: r.threadId } : {}),
  };
};

export const useRecallSearch = (
  query: string,
  options: {
    readonly debounceMs?: number;
    readonly minQueryLength?: number;
    readonly limit?: number;
  } = {},
): RecallSearchState => {
  const debounceMs = options.debounceMs ?? SEARCH_DEBOUNCE_MS;
  const minLength = options.minQueryLength ?? SEARCH_MIN_QUERY_CHARS;
  const limit = options.limit ?? 12;
  const [state, setState] = useState<RecallSearchState>({
    query: '',
    items: EMPTY_ITEMS,
    loading: false,
    error: null,
  });
  // Track the most recent in-flight query so a stale response can't
  // overwrite a newer one. Hit-rate guard against the user typing
  // faster than the embedder runs.
  const latestRef = useRef<string>('');

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      latestRef.current = '';
      setState({ query: '', items: EMPTY_ITEMS, loading: false, error: null });
      return;
    }
    if (trimmed.length < minLength) {
      // Below threshold — clear results but don't show error.
      latestRef.current = trimmed;
      setState({ query: trimmed, items: EMPTY_ITEMS, loading: false, error: null });
      return;
    }
    latestRef.current = trimmed;
    setState((prev) => ({ ...prev, query: trimmed, loading: true, error: null }));
    const timer = setTimeout(() => {
      const sendQuery = (): void => {
        chrome.runtime.sendMessage(
          {
            type: messageTypes.recallV2Query,
            req: {
              q: trimmed,
              intent: 'search',
              limit,
              perSourceLimit: 20,
              strategy: { explain: true },
            },
          },
          (response: unknown) => {
            // Ignore stale responses: user may have typed something new.
            if (latestRef.current !== trimmed) return;
            const lastError = chrome.runtime.lastError;
            if (lastError !== undefined) {
              setState({
                query: trimmed,
                items: EMPTY_ITEMS,
                loading: false,
                error: lastError.message ?? 'Recall query failed',
              });
              return;
            }
            // v2 response wraps the RecallResponse under { ok, results }
            // (per background.ts:recallV2Query handler). `null` /
            // `undefined` means the SW short-circuited (e.g. local-
            // fallback path with no hits).
            if (response == null) {
              setState({ query: trimmed, items: EMPTY_ITEMS, loading: false, error: null });
              return;
            }
            if (typeof response !== 'object') {
              setState({
                query: trimmed,
                items: EMPTY_ITEMS,
                loading: false,
                error: 'Unexpected recall response',
              });
              return;
            }
            const wrap = response as {
              readonly ok?: unknown;
              readonly results?: unknown;
              readonly error?: unknown;
            };
            if (wrap.ok !== true) {
              setState({
                query: trimmed,
                items: EMPTY_ITEMS,
                loading: false,
                error: typeof wrap.error === 'string' ? wrap.error : 'Recall query failed',
              });
              return;
            }
            const rawResults = Array.isArray(wrap.results) ? wrap.results : [];
            const parsed = rawResults
              .map(hitFromV2Candidate)
              .filter((h): h is RecallHit => h !== null);
            setState({
              query: trimmed,
              items: parsed,
              loading: false,
              error: null,
            });
          },
        );
      };
      try {
        sendQuery();
      } catch (error) {
        setState({
          query: trimmed,
          items: EMPTY_ITEMS,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, debounceMs);
    return () => {
      clearTimeout(timer);
    };
  }, [query, debounceMs, minLength, limit]);

  return state;
};
