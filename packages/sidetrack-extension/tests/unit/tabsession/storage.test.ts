import { describe, expect, it, vi } from 'vitest';

import {
  TAB_SESSION_BY_TAB_HASH_KEY,
  createChromeTabSessionStorage,
  sealOrphanTabSessionsOnWake,
  type StoredTabSession,
} from '../../../src/tabsession/storage';

const record = (tabSessionId: string): StoredTabSession => ({
  tabSessionId,
  openedAt: '2026-05-07T10:00:00.000Z',
  lastActivityAt: '2026-05-07T10:00:00.000Z',
});

const createMemoryChromeStorage = () => {
  const store: Record<string, unknown> = {};
  return {
    get: vi.fn(async (key: string) => ({ [key]: store[key] })),
    set: vi.fn(async (entries: Record<string, unknown>) => {
      Object.assign(store, entries);
    }),
  };
};

describe('tab-session chrome storage', () => {
  it('concurrent set("tab-a") and set("tab-b") preserves both records', async () => {
    const raw = createMemoryChromeStorage();
    const storage = createChromeTabSessionStorage(raw);
    const recordA = record('tses_a');
    const recordB = record('tses_b');

    await Promise.all([storage.set('tab_a', recordA), storage.set('tab_b', recordB)]);

    await expect(storage.readAll()).resolves.toMatchObject({
      tab_a: recordA,
      tab_b: recordB,
    });
    expect(raw.set).toHaveBeenLastCalledWith({
      [TAB_SESSION_BY_TAB_HASH_KEY]: {
        tab_a: recordA,
        tab_b: recordB,
      },
    });
  });

  it('seals orphan sessions on service-worker wake without touching already-ended sessions', async () => {
    const raw = createMemoryChromeStorage();
    const storage = createChromeTabSessionStorage(raw);
    await storage.writeAll({
      tab_a: record('tses_a'),
      tab_b: record('tses_b'),
      tab_c: record('tses_c'),
      tab_done: { ...record('tses_done'), endTimeMs: 1770000000000 },
    });

    await expect(sealOrphanTabSessionsOnWake(storage, 1778260000000)).resolves.toEqual({
      sealed: 3,
    });

    await expect(storage.readAll()).resolves.toMatchObject({
      tab_a: { tabSessionId: 'tses_a', endTimeMs: 1778260000000 },
      tab_b: { tabSessionId: 'tses_b', endTimeMs: 1778260000000 },
      tab_c: { tabSessionId: 'tses_c', endTimeMs: 1778260000000 },
      tab_done: { tabSessionId: 'tses_done', endTimeMs: 1770000000000 },
    });
  });
});
