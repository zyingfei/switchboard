import { useEffect, useRef, useState } from 'react';

import { messageTypes } from '../../messages';

// Stage 5 polish — recall-index full-text search hook. The
// companion's `/v1/recall/query` route does hybrid lexical +
// vector retrieval over indexed turn chunks; we proxy through
// background.ts's existing `messageTypes.recallQuery` handler so
// we don't reinvent the bridge-key + fetch dance.
//
// The hook debounces (default 300ms), skips short queries
// (< 3 chars), and exposes `{ items, loading, error }` with a
// stable empty-array reference so consumers don't churn re-renders.

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

const isHit = (value: unknown): value is RecallHit => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<RecallHit>;
  return (
    typeof v.id === 'string' &&
    (typeof v.threadId === 'string' || typeof v.anchorNodeId === 'string') &&
    typeof v.capturedAt === 'string' &&
    typeof v.score === 'number'
  );
};

export const useRecallSearch = (
  query: string,
  options: {
    readonly debounceMs?: number;
    readonly minQueryLength?: number;
    readonly limit?: number;
  } = {},
): RecallSearchState => {
  const debounceMs = options.debounceMs ?? 300;
  const minLength = options.minQueryLength ?? 3;
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
            type: messageTypes.contentQuery,
            q: trimmed,
            limit,
            sourceKind: ['page-content', 'chat-turn'],
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
            if (typeof response !== 'object' || response === null || !('items' in response)) {
              setState({
                query: trimmed,
                items: EMPTY_ITEMS,
                loading: false,
                error: 'Unexpected recall response',
              });
              return;
            }
            const items = (response as { items?: unknown }).items;
            const parsed = Array.isArray(items) ? items.filter(isHit) : [];
            const error = (response as { error?: string }).error;
            setState({
              query: trimmed,
              items: parsed,
              loading: false,
              error: typeof error === 'string' && parsed.length === 0 ? error : null,
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
