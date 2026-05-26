// Now-tab context history.
//
// Tracks the last N Now contexts (URL + title + page-kind + when
// observed). The strip above the Now card renders the previous
// entries so when active browser tab changes update Now, the user
// can still see "this used to be a chat, the prior context was
// 'Anthropic blog'".
//
// Rules from the UX spec (Scope E):
//   - Max 3 recent Now contexts
//   - Click a chip restores the prior Now context view
//   - Do NOT auto-switch browser tabs when a chip is clicked
//   - Do NOT create a full navigation surface; this is a peripheral
//     breadcrumb, not a back-button.
//
// The hook keeps the list in React state. Persistence to
// chrome.storage is out of scope for the first cut — the strip is
// session-scoped (clears on side-panel reload). If that turns out
// to be surprising during dogfood, lift it into chrome.storage.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { PageKind } from './pageKind';

export interface NowContext {
  readonly url: string;
  readonly title: string;
  readonly kind: PageKind;
  /** ISO timestamp of when this context became Now. */
  readonly enteredAt: string;
}

export interface NowHistoryState {
  /** All contexts the user has visited under Now this session, most
   *  recent FIRST. The active context is the head of the list when
   *  `pinned` is null; otherwise the head is the user's pinned
   *  selection (clicked a history chip). */
  readonly contexts: readonly NowContext[];
  /** When the user clicks a chip we "pin" that context as the active
   *  display so the auto-update from the live tab change doesn't
   *  immediately replace it. The user can clear by clicking the
   *  current-tab chip (head) or by clicking the same chip again. */
  readonly pinnedUrl: string | null;
}

const HISTORY_LIMIT = 4; // current + 3 previous = 4 chips total.

export interface UseNowHistoryResult extends NowHistoryState {
  /** Called when the live active-tab context arrives. No-op when the
   *  URL matches the most-recent context (de-dupe consecutive same-
   *  URL updates that happen when nothing actually changed). */
  readonly observe: (next: NowContext | null) => void;
  /** Pin the user's chip selection. Pass `null` to unpin (default
   *  back to "show me the live current tab"). */
  readonly pin: (url: string | null) => void;
}

export const useNowHistory = (): UseNowHistoryResult => {
  const [state, setState] = useState<NowHistoryState>({
    contexts: [],
    pinnedUrl: null,
  });
  // De-dupe consecutive same-URL observations. The active tab card
  // re-renders on every projection poll; we only want to push a new
  // history entry when the URL actually changes.
  const lastUrlRef = useRef<string | null>(null);

  const observe = useCallback((next: NowContext | null): void => {
    if (next === null) return;
    if (lastUrlRef.current === next.url) return;
    lastUrlRef.current = next.url;
    setState((prev) => {
      // Drop any prior entry with the same URL so revisiting moves it
      // to the head instead of duplicating.
      const filtered = prev.contexts.filter((c) => c.url !== next.url);
      const nextContexts = [next, ...filtered].slice(0, HISTORY_LIMIT);
      return { ...prev, contexts: nextContexts };
    });
  }, []);

  const pin = useCallback((url: string | null): void => {
    setState((prev) => ({ ...prev, pinnedUrl: url }));
  }, []);

  // Defensive cleanup — if a pinned URL is no longer in the history
  // (e.g. dropped out of the 4-entry window), unpin so the strip
  // doesn't render an active-state chip the user can't see.
  useEffect(() => {
    if (state.pinnedUrl === null) return;
    if (!state.contexts.some((c) => c.url === state.pinnedUrl)) {
      setState((prev) => ({ ...prev, pinnedUrl: null }));
    }
  }, [state.contexts, state.pinnedUrl]);

  return { ...state, observe, pin };
};
