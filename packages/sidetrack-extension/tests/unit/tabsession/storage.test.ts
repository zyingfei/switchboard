import { describe, expect, it, vi } from 'vitest';

import {
  TAB_SESSION_BY_TAB_HASH_KEY,
  createChromeTabSessionStorage,
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
});
