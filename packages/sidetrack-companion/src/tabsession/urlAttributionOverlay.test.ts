import { describe, expect, it } from 'vitest';

import type { UrlProjection, UrlVisitRecord } from '../urls/projection.js';
import type { TabSessionProjection, TabSessionRecord } from './projection.js';
import { overlayUrlAttributionOntoTabSessions } from './urlAttributionOverlay.js';

const tabRecord = (input: Partial<TabSessionRecord> & { tabSessionId: string }): TabSessionRecord => ({
  openedAt: 't0',
  lastActivityAt: 't0',
  attributionHistory: [],
  ...input,
});

const tabProjection = (records: readonly TabSessionRecord[]): TabSessionProjection => ({
  schemaVersion: 1,
  bySessionId: new Map(records.map((r) => [r.tabSessionId, r])),
  openSessionsByTabId: new Map(),
});

const urlRecord = (canonicalUrl: string, workstreamId: string | null): UrlVisitRecord =>
  ({
    canonicalUrl,
    firstSeenAt: 't',
    lastSeenAt: 't',
    visitCount: 1,
    tabSessionIds: [],
    attributionHistory: [],
    currentAttribution: {
      workstreamId,
      source: 'user_asserted',
      observedAt: '2026-05-18T04:19:56.243Z',
      clientEventId: 'url-evt-1',
      replicaId: 'replica-a',
      seq: 42,
    },
  }) as unknown as UrlVisitRecord;

const urlProjection = (records: readonly UrlVisitRecord[]): UrlProjection => ({
  schemaVersion: 1,
  byCanonicalUrl: new Map(records.map((r) => [r.canonicalUrl, r])),
});

describe('overlayUrlAttributionOntoTabSessions', () => {
  it('inherits the URL attribution when the tab-session has none (the CUDA-Gemini case)', () => {
    const tab = tabProjection([
      tabRecord({
        tabSessionId: 'tses_a',
        latestUrl: 'https://gemini.google.com/app/dfb947c03cc59bd1',
      }),
    ]);
    const url = urlProjection([
      urlRecord('https://gemini.google.com/app/dfb947c03cc59bd1', '0K230YS0SZ8F1MZD'),
    ]);
    const out = overlayUrlAttributionOntoTabSessions(tab, url);
    const rec = out.bySessionId.get('tses_a');
    expect(rec?.currentAttribution).toEqual({
      workstreamId: '0K230YS0SZ8F1MZD',
      source: 'user_asserted',
      observedAt: '2026-05-18T04:19:56.243Z',
      clientEventId: 'url-evt-1',
      replicaId: 'replica-a',
      seq: 42,
    });
  });

  it('does not override a tab-session that already has its own attribution', () => {
    const own = {
      workstreamId: 'WS_OWN',
      source: 'user_asserted' as const,
      observedAt: 't',
      clientEventId: 'own',
      replicaId: 'r',
      seq: 1,
    };
    const tab = tabProjection([
      tabRecord({
        tabSessionId: 'tses_a',
        latestUrl: 'https://x.test/a',
        currentAttribution: own,
      }),
    ]);
    const url = urlProjection([urlRecord('https://x.test/a', 'WS_URL')]);
    const out = overlayUrlAttributionOntoTabSessions(tab, url);
    expect(out.bySessionId.get('tses_a')?.currentAttribution).toBe(own);
  });

  it('returns the same projection object when nothing matches (no churn)', () => {
    const tab = tabProjection([tabRecord({ tabSessionId: 'tses_a', latestUrl: 'https://no.test' })]);
    const url = urlProjection([urlRecord('https://other.test', 'WS')]);
    expect(overlayUrlAttributionOntoTabSessions(tab, url)).toBe(tab);
  });
});
