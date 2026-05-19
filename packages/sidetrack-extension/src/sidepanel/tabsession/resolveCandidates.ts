// Tab-session resolve candidate selection + diagnostics.
//
// Incident: /v1/tabsessions/{id}/resolve?dryRun=true is intrinsically
// ~0.8–1.5s and `loadTabSessionSuggestions` was unioning EVERY open +
// unattributed record in the WHOLE projection (not just the Inbox
// page / current tab) with inbox.items, then resolving the lot on
// every ambient snapshotRevision / view-mode / push refresh. At
// dogfood scale (~118 open-unattributed) that is minutes of serial
// single-loop work per snapshot bump → /status starvation. (And the
// result feeds a state slice nothing renders — the live UI uses the
// URL-suggestion path — so the projection-wide fan-out was pure dead
// work.)
//
// These pure helpers make the candidate set selectable (bounded vs
// the legacy projection-wide) and expose a diagnostic summary so a
// load can be explained (real tabs vs unsealed stale vs projection
// backlog) — both unit-testable without the DOM.

import type { TabSessionInboxData, TabSessionProjection, TabSessionRecord } from './types';

export type ResolveCandidateScope = 'bounded' | 'projection-wide';

const isOpenUnattributed = (r: TabSessionRecord): boolean =>
  r.closedAt === undefined && r.currentAttribution === undefined;

export interface SelectCandidatesInput {
  readonly projection: TabSessionProjection;
  readonly inbox: TabSessionInboxData;
  /** Routine refresh ⇒ 'bounded' (Inbox page + focused tab only).
   * 'projection-wide' is the legacy behaviour, reachable ONLY behind
   * an explicit user/debug path — never ambient browsing. */
  readonly scope: ResolveCandidateScope;
  /** The focused/current tab-session id, included even when it isn't
   * on the Inbox top page so the Current Tab card can still resolve. */
  readonly focusedTabSessionId?: string;
}

/**
 * The candidate set to resolve. Bounded = inbox.items (unattributed)
 * + the focused tab-session. Projection-wide = the legacy union of
 * every open+unattributed record across the whole projection (kept
 * for an explicit/debug trigger only — NOT routine refresh).
 */
export const selectTabSessionCandidates = (
  input: SelectCandidatesInput,
): Map<string, TabSessionRecord> => {
  const out = new Map<string, TabSessionRecord>();
  if (input.scope === 'projection-wide') {
    for (const record of Object.values(input.projection.bySessionId)) {
      if (isOpenUnattributed(record)) out.set(record.tabSessionId, record);
    }
  }
  // Inbox page — the actually-rendered surface (≤ /v1/tabsessions/
  // inbox?limit=51). Always bounded regardless of scope.
  for (const record of input.inbox.items) {
    if (record.currentAttribution === undefined) out.set(record.tabSessionId, record);
  }
  // Focused/current tab-session, if present + still actionable.
  if (input.focusedTabSessionId !== undefined && !out.has(input.focusedTabSessionId)) {
    const f = input.projection.bySessionId[input.focusedTabSessionId];
    if (f !== undefined && isOpenUnattributed(f)) out.set(f.tabSessionId, f);
  }
  return out;
};

export interface ResolveCandidateDiagnostics {
  readonly scope: ResolveCandidateScope;
  readonly forceRefetch: boolean;
  readonly projectionTotal: number;
  readonly openSessionsByTabId: number;
  readonly openUnattributed: number;
  readonly inboxItems: number;
  readonly inboxUnattributed: number;
  readonly unionCandidates: number;
  readonly idsToFetch: number;
  readonly cacheHits: number;
  readonly negativeCacheSkips: number;
  readonly projectionOnly: number;
  readonly inboxOverlap: number;
  readonly oldestActivityMs: number | null;
  readonly newestActivityMs: number | null;
  readonly olderThan1h: number;
  readonly olderThan1d: number;
  readonly olderThan7d: number;
  readonly providerHistogram: Record<string, number>;
  /** Best-effort real Chrome tab count (chrome.tabs.query); null when
   * the API is unavailable (tests / no permission). */
  readonly realChromeTabs: number | null;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Pure summary of a resolve-candidate load. `idsToFetch` /
 * `cacheHits` / `negativeCacheSkips` are passed in (the cache lives
 * in the hook). `now` is injectable for deterministic tests.
 */
export const summarizeResolveCandidates = (args: {
  readonly projection: TabSessionProjection;
  readonly inbox: TabSessionInboxData;
  readonly candidates: Map<string, TabSessionRecord>;
  readonly idsToFetch: number;
  readonly cacheHits: number;
  readonly negativeCacheSkips: number;
  readonly scope: ResolveCandidateScope;
  readonly forceRefetch: boolean;
  readonly realChromeTabs: number | null;
  readonly now?: number;
}): ResolveCandidateDiagnostics => {
  const now = args.now ?? Date.now();
  const allRecords = Object.values(args.projection.bySessionId);
  const inboxIds = new Set(args.inbox.items.map((r) => r.tabSessionId));
  let projectionOnly = 0;
  let inboxOverlap = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  let o1h = 0;
  let o1d = 0;
  let o7d = 0;
  const providerHistogram: Record<string, number> = {};
  for (const rec of args.candidates.values()) {
    if (inboxIds.has(rec.tabSessionId)) inboxOverlap += 1;
    else projectionOnly += 1;
    const t = Date.parse(rec.lastActivityAt);
    if (!Number.isNaN(t)) {
      if (oldest === null || t < oldest) oldest = t;
      if (newest === null || t > newest) newest = t;
      const age = now - t;
      if (age > HOUR) o1h += 1;
      if (age > DAY) o1d += 1;
      if (age > 7 * DAY) o7d += 1;
    }
    const p = rec.provider ?? '(none)';
    providerHistogram[p] = (providerHistogram[p] ?? 0) + 1;
  }
  return {
    scope: args.scope,
    forceRefetch: args.forceRefetch,
    projectionTotal: allRecords.length,
    openSessionsByTabId: Object.keys(args.projection.openSessionsByTabId).length,
    openUnattributed: allRecords.filter(isOpenUnattributed).length,
    inboxItems: args.inbox.items.length,
    inboxUnattributed: args.inbox.items.filter((r) => r.currentAttribution === undefined).length,
    unionCandidates: args.candidates.size,
    idsToFetch: args.idsToFetch,
    cacheHits: args.cacheHits,
    negativeCacheSkips: args.negativeCacheSkips,
    projectionOnly,
    inboxOverlap,
    oldestActivityMs: oldest,
    newestActivityMs: newest,
    olderThan1h: o1h,
    olderThan1d: o1d,
    olderThan7d: o7d,
    providerHistogram,
    realChromeTabs: args.realChromeTabs,
  };
};

/** Best-effort live Chrome tab count for the projection-vs-reality
 * comparison. Resolves null when chrome.tabs is unavailable. */
export const queryRealChromeTabCount = async (): Promise<number | null> => {
  try {
    const c = (globalThis as { chrome?: { tabs?: { query?: unknown } } }).chrome;
    if (c?.tabs?.query === undefined) return null;
    const tabs = await (
      c.tabs as { query: (q: Record<string, never>) => Promise<readonly unknown[]> }
    ).query({});
    return Array.isArray(tabs) ? tabs.length : null;
  } catch {
    return null;
  }
};
