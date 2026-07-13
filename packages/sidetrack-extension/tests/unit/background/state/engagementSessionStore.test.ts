import { describe, expect, it, vi } from 'vitest';

import {
  ENGAGEMENT_SESSIONS_KEY,
  createChromeEngagementSessionStore,
  foldIntervalIntoSession,
  type StoredEngagementSession,
} from '../../../../src/background/state/engagementSessionStore';
import { emptyEngagementTotals } from '../../../../src/content/engagement/aggregator';

const createMemoryChromeStorage = () => {
  const store: Record<string, unknown> = {};
  return {
    store,
    get: vi.fn(async (key: string) => ({ [key]: store[key] })),
    set: vi.fn(async (entries: Record<string, unknown>) => {
      Object.assign(store, entries);
    }),
  };
};

const record = (over: Partial<StoredEngagementSession> = {}): StoredEngagementSession => ({
  visitId: 'visit:a',
  sessionId: 'session:edge:tab:10:start:1000',
  intervalStart: 1_000,
  intervalEnd: 2_000,
  updatedAt: 2_000,
  totals: { ...emptyEngagementTotals(), focusedWindowMs: 4_200 },
  ...over,
});

describe('engagement session store', () => {
  it('round-trips a stored session through chrome.storage.local', async () => {
    const raw = createMemoryChromeStorage();
    const store = createChromeEngagementSessionStore(raw);
    await store.set(10, record());
    expect(await store.get(10)).toEqual(record());
    expect(raw.store[ENGAGEMENT_SESSIONS_KEY]).toBeDefined();
  });

  it('concurrent set for two tabs preserves both records', async () => {
    const raw = createMemoryChromeStorage();
    const store = createChromeEngagementSessionStore(raw);
    const a = record({ sessionId: 'sess:a' });
    const b = record({ sessionId: 'sess:b', visitId: 'visit:b' });
    await Promise.all([store.set(10, a), store.set(11, b)]);
    await expect(store.readAll()).resolves.toMatchObject({ '10': a, '11': b });
  });

  it('remove returns the removed record and deletes it', async () => {
    const raw = createMemoryChromeStorage();
    const store = createChromeEngagementSessionStore(raw);
    await store.set(10, record());
    const removed = await store.remove(10);
    expect(removed?.sessionId).toBe('session:edge:tab:10:start:1000');
    expect(await store.get(10)).toBeUndefined();
    expect(await store.remove(10)).toBeUndefined();
  });

  it('drops malformed persisted entries on read (defensive parse)', async () => {
    const raw = createMemoryChromeStorage();
    raw.store[ENGAGEMENT_SESSIONS_KEY] = {
      '10': record(),
      '11': { visitId: '', sessionId: 'x' }, // missing/empty fields
    };
    const store = createChromeEngagementSessionStore(raw);
    const all = await store.readAll();
    expect(Object.keys(all)).toEqual(['10']);
  });
});

describe('foldIntervalIntoSession', () => {
  it('pins sessionId + intervalStart to the first interval and sums totals', () => {
    const totals = { ...emptyEngagementTotals(), focusedWindowMs: 1_000 };
    const first = foldIntervalIntoSession({
      existing: undefined,
      baseSessionId: 'session:edge',
      tabId: 10,
      visitId: 'visit:a',
      intervalStart: 1_000,
      intervalEnd: 2_000,
      totals,
      now: 5_000,
    });
    expect(first.sessionId).toBe('session:edge:tab:10:start:1000');
    expect(first.totals.focusedWindowMs).toBe(1_000);

    const second = foldIntervalIntoSession({
      existing: first,
      baseSessionId: 'session:edge',
      tabId: 10,
      visitId: 'visit:a',
      intervalStart: 2_000,
      intervalEnd: 3_000,
      totals: { ...emptyEngagementTotals(), focusedWindowMs: 500 },
      now: 6_000,
    });
    // sessionId + start pinned to the first; totals summed; updatedAt advanced.
    expect(second.sessionId).toBe('session:edge:tab:10:start:1000');
    expect(second.intervalStart).toBe(1_000);
    expect(second.intervalEnd).toBe(3_000);
    expect(second.totals.focusedWindowMs).toBe(1_500);
    expect(second.updatedAt).toBe(6_000);
  });
});
