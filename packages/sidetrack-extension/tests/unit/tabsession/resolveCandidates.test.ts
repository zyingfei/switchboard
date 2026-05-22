import { describe, expect, it } from 'vitest';

import {
  queryRealChromeTabCount,
  selectTabSessionCandidates,
  summarizeResolveCandidates,
} from '../../../src/sidepanel/tabsession/resolveCandidates';
import type {
  TabSessionInboxData,
  TabSessionProjection,
  TabSessionRecord,
} from '../../../src/sidepanel/tabsession/types';

const rec = (o: Partial<TabSessionRecord> & { tabSessionId: string }): TabSessionRecord => ({
  openedAt: '2026-05-19T00:00:00.000Z',
  lastActivityAt: '2026-05-19T00:00:00.000Z',
  attributionHistory: [],
  ...o,
});

// A projection with `open` open+unattributed sessions, `closed`
// sealed ones, and `attributed` decided ones — the dogfood shape
// that drove the flood (hundreds of open+unattributed).
const projectionOf = (open: number, closed = 3, attributed = 2): TabSessionProjection => {
  const bySessionId: Record<string, TabSessionRecord> = {};
  const openSessionsByTabId: Record<string, string> = {};
  for (let i = 0; i < open; i += 1) {
    const id = `tses_open_${String(i)}`;
    bySessionId[id] = rec({
      tabSessionId: id,
      latestUrl: `https://o${String(i)}.test/`,
      provider: i % 2 === 0 ? 'chatgpt' : undefined,
    });
    openSessionsByTabId[`tab_${String(i)}`] = id;
  }
  for (let i = 0; i < closed; i += 1) {
    const id = `tses_closed_${String(i)}`;
    bySessionId[id] = rec({ tabSessionId: id, closedAt: '2026-05-19T00:05:00.000Z' });
  }
  for (let i = 0; i < attributed; i += 1) {
    const id = `tses_attr_${String(i)}`;
    bySessionId[id] = rec({
      tabSessionId: id,
      currentAttribution: {
        workstreamId: 'bac_ws',
        source: 'user_asserted',
        observedAt: '2026-05-19T00:00:00.000Z',
        clientEventId: 'e1',
      },
    });
  }
  return { schemaVersion: 1, bySessionId, openSessionsByTabId };
};

const inboxOf = (ids: readonly string[], records: TabSessionProjection): TabSessionInboxData => ({
  items: ids.map((id) => records.bySessionId[id]!),
  total: ids.length,
  limit: 51,
  offset: 0,
});

describe('selectTabSessionCandidates — the resolve-flood fix', () => {
  it('BOUNDED routine refresh does NOT grow with projection backlog', () => {
    // Same Inbox page (5 items), wildly different projection backlog.
    const small = projectionOf(10);
    const huge = projectionOf(1000);
    const inboxSmall = inboxOf(
      ['tses_open_0', 'tses_open_1', 'tses_open_2', 'tses_open_3', 'tses_open_4'],
      small,
    );
    const inboxHuge = inboxOf(
      ['tses_open_0', 'tses_open_1', 'tses_open_2', 'tses_open_3', 'tses_open_4'],
      huge,
    );
    const cSmall = selectTabSessionCandidates({
      projection: small,
      inbox: inboxSmall,
      scope: 'bounded',
    });
    const cHuge = selectTabSessionCandidates({
      projection: huge,
      inbox: inboxHuge,
      scope: 'bounded',
    });
    expect(cSmall.size).toBe(5);
    expect(cHuge.size).toBe(5); // unchanged despite 1000 open sessions — bounded
  });

  it('PROJECTION-WIDE (legacy/explicit only) DOES grow with backlog — the old flood', () => {
    const huge = projectionOf(1000);
    const inbox = inboxOf(['tses_open_0'], huge);
    const wide = selectTabSessionCandidates({ projection: huge, inbox, scope: 'projection-wide' });
    expect(wide.size).toBe(1000); // every open+unattributed — what pegged the loop
  });

  it('bounded includes the focused tab-session even when off the Inbox page', () => {
    const proj = projectionOf(200);
    const inbox = inboxOf(['tses_open_0'], proj);
    const c = selectTabSessionCandidates({
      projection: proj,
      inbox,
      scope: 'bounded',
      focusedTabSessionId: 'tses_open_137',
    });
    expect([...c.keys()].sort()).toEqual(['tses_open_0', 'tses_open_137']);
  });

  it('never includes closed or attributed sessions (either scope)', () => {
    const proj = projectionOf(4);
    const inbox = inboxOf(['tses_open_0'], proj);
    for (const scope of ['bounded', 'projection-wide'] as const) {
      const c = selectTabSessionCandidates({ projection: proj, inbox, scope });
      expect([...c.keys()].some((id) => id.startsWith('tses_closed_'))).toBe(false);
      expect([...c.keys()].some((id) => id.startsWith('tses_attr_'))).toBe(false);
    }
  });
});

describe('summarizeResolveCandidates — incident diagnostics', () => {
  it('explains the load: backlog vs inbox-overlap, age buckets, providers', () => {
    const proj = projectionOf(100);
    // 3 of the open sessions are stale (last activity > 8 days ago).
    proj.bySessionId['tses_open_0'] = rec({
      tabSessionId: 'tses_open_0',
      lastActivityAt: '2026-05-01T00:00:00.000Z',
      provider: 'chatgpt',
    });
    proj.bySessionId['tses_open_1'] = rec({
      tabSessionId: 'tses_open_1',
      lastActivityAt: '2026-05-17T00:00:00.000Z', // 2 days → >1d, not >7d
    });
    const inbox = inboxOf(['tses_open_0', 'tses_open_1', 'tses_open_2'], proj);
    const candidates = selectTabSessionCandidates({
      projection: proj,
      inbox,
      scope: 'projection-wide',
    });
    const d = summarizeResolveCandidates({
      projection: proj,
      inbox,
      candidates,
      idsToFetch: 90,
      cacheHits: 8,
      negativeCacheSkips: 2,
      scope: 'projection-wide',
      forceRefetch: false,
      realChromeTabs: 7,
      now: Date.parse('2026-05-19T00:00:00.000Z'),
    });
    expect(d.projectionTotal).toBe(105); // 100 open + 3 closed + 2 attributed
    expect(d.openUnattributed).toBe(100);
    expect(d.openSessionsByTabId).toBe(100);
    expect(d.unionCandidates).toBe(100);
    expect(d.inboxOverlap).toBe(3);
    expect(d.projectionOnly).toBe(97); // candidates not on the Inbox page
    expect(d.olderThan7d).toBe(1); // tses_open_0 (May 1, 18d)
    expect(d.olderThan1d).toBe(2); // + tses_open_1 (May 10, 9d)
    expect(d.realChromeTabs).toBe(7); // ⇒ 100 "open" vs 7 real tabs = unsealed backlog
    expect(d.providerHistogram['chatgpt']).toBeGreaterThan(0);
    expect(d.idsToFetch).toBe(90);
    expect(d.cacheHits).toBe(8);
    expect(d.negativeCacheSkips).toBe(2);
  });

  it('bounded scope summary stays small regardless of backlog', () => {
    const proj = projectionOf(800);
    const inbox = inboxOf(['tses_open_0', 'tses_open_1'], proj);
    const candidates = selectTabSessionCandidates({ projection: proj, inbox, scope: 'bounded' });
    const d = summarizeResolveCandidates({
      projection: proj,
      inbox,
      candidates,
      idsToFetch: 2,
      cacheHits: 0,
      negativeCacheSkips: 0,
      scope: 'bounded',
      forceRefetch: false,
      realChromeTabs: null,
    });
    expect(d.openUnattributed).toBe(800); // backlog still visible in diagnostics
    expect(d.unionCandidates).toBe(2); // …but the resolve set is bounded
    expect(d.idsToFetch).toBe(2);
  });
});

describe('queryRealChromeTabCount', () => {
  it('returns null when chrome.tabs is unavailable (no throw)', async () => {
    await expect(queryRealChromeTabCount()).resolves.toBeNull();
  });
});
