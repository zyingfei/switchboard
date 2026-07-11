// §13 step 8 — closed-tab restore via chrome.sessions.
//
// When the user closes an AI-thread tab, Chrome keeps it in its
// recently-closed session history for a while. Restoring from that
// history (chrome.sessions.restore) brings back scroll position and
// unsaved form state that a plain reopen-URL loses. This module holds
// the pure matching logic so it can be unit-tested without the chrome
// APIs: given the list Chrome returns and the thread's URL/title, it
// picks the best session to restore, or reports that none matched (the
// caller then falls back to reopen-URL).

// Shape mirrors the subset of chrome.sessions.Session we read. Kept
// local (rather than importing chrome's ambient types into a pure,
// test-runnable module) so the matcher runs under jsdom without the
// extension type shims.
export interface ClosedSessionTab {
  readonly sessionId?: string;
  readonly url?: string;
  readonly title?: string;
}

export interface ClosedSession {
  // A closed window carries several tabs; a closed single tab carries
  // one. We flatten both into candidate tabs before matching.
  readonly tab?: ClosedSessionTab;
  readonly window?: { readonly tabs?: readonly ClosedSessionTab[] };
}

export interface SessionRestoreTarget {
  readonly url: string;
  readonly title?: string;
}

// Chrome stores the sessionId on the RESTORE handle, which for a
// closed single tab is `session.tab.sessionId`, and for a tab inside a
// closed window is the enclosing `session.window`'s id. We restore the
// most specific handle we can: the tab's own sessionId when present,
// else nothing (a window restore would reopen every tab in that
// window, not just the one the user wants — so we decline and let the
// caller reopen the single URL instead).
export interface SessionRestoreMatch {
  readonly sessionId: string;
  readonly matchedOn: 'url' | 'url+title';
}

const normalizeUrl = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = new URL(trimmed);
    // Drop the hash — a closed chat tab and its reopened twin often
    // differ only by an in-page anchor. Keep the search string: chat
    // URLs identify the thread via query/path, not fragment.
    parsed.hash = '';
    // Trailing-slash-insensitive: '/c/abc' and '/c/abc/' are the same
    // thread. Collapse a lone trailing slash on the path.
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
};

const normalizeTitle = (title: string | undefined): string | undefined => {
  if (title === undefined) return undefined;
  const trimmed = title.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
};

// Walk one closed-session entry into the individual tabs it contains.
// Only tabs that carry their own sessionId are restorable in isolation.
const restorableTabsOf = (session: ClosedSession): readonly ClosedSessionTab[] => {
  if (session.tab !== undefined) {
    return [session.tab];
  }
  if (session.window?.tabs !== undefined) {
    return session.window.tabs;
  }
  return [];
};

// Pick the best recently-closed session to restore for `target`.
// URL is the primary key (hash-insensitive, trailing-slash-insensitive);
// title is a tiebreak that upgrades the match confidence but is never
// required. Returns null when nothing matches by URL — the caller then
// falls back to reopen-URL.
export const findSessionRestoreMatch = (
  sessions: readonly ClosedSession[],
  target: SessionRestoreTarget,
): SessionRestoreMatch | null => {
  const wantUrl = normalizeUrl(target.url);
  if (wantUrl === undefined) return null;
  const wantTitle = normalizeTitle(target.title);

  // Sessions come back most-recent-first from Chrome; keep that order
  // so the freshest matching close wins. Prefer a url+title match over
  // a url-only match even if the url-only one is more recent — the
  // extra signal makes it far more likely to be the same tab.
  let urlOnly: SessionRestoreMatch | null = null;
  for (const session of sessions) {
    for (const tab of restorableTabsOf(session)) {
      const sessionId = tab.sessionId;
      if (sessionId === undefined || normalizeUrl(tab.url) !== wantUrl) {
        continue;
      }
      const tabTitle = normalizeTitle(tab.title);
      if (wantTitle !== undefined && tabTitle !== undefined && tabTitle === wantTitle) {
        return { sessionId, matchedOn: 'url+title' };
      }
      urlOnly ??= { sessionId, matchedOn: 'url' };
    }
  }
  return urlOnly;
};
