import { describe, expect, it } from 'vitest';

import { createTabSessionBoundary } from '../../../src/tabsession/boundary';
import type {
  StoredTabSession,
  TabSessionByTabIdHash,
  TabSessionStorage,
} from '../../../src/tabsession/storage';

const memoryStorage = (): {
  readonly records: TabSessionByTabIdHash;
  readonly storage: TabSessionStorage;
} => {
  const records: TabSessionByTabIdHash = {};
  return {
    records,
    storage: {
      readAll: async () => ({ ...records }),
      writeAll: async (next) => {
        for (const key of Object.keys(records)) delete records[key];
        Object.assign(records, next);
      },
      mutate: async (apply) => {
        const next = apply({ ...records });
        for (const key of Object.keys(records)) delete records[key];
        Object.assign(records, next);
      },
      get: async (tabIdHash) => records[tabIdHash],
      set: async (tabIdHash, record) => {
        records[tabIdHash] = record;
      },
      remove: async (tabIdHash) => {
        delete records[tabIdHash];
      },
    },
  };
};

describe('tab-session boundary state machine', () => {
  it('hard-stops tab sessions on tab removal and explicit move', async () => {
    const { records, storage } = memoryStorage();
    let seq = 0;
    const boundary = createTabSessionBoundary({
      storage,
      mintId: () => `tses_${String((seq += 1))}`,
    });
    await boundary.recordActivity({
      tabIdHash: 'tab-a',
      windowIdHash: 'win-a',
      url: 'https://example.test/a',
      at: new Date('2026-05-07T10:00:00.000Z'),
    });
    expect(records['tab-a']?.tabSessionId).toBe('tses_1');
    await boundary.hardStopTab('tab-a');
    expect(records['tab-a']).toBeUndefined();

    await boundary.recordActivity({
      tabIdHash: 'tab-b',
      windowIdHash: 'win-a',
      url: 'https://example.test/b',
      at: new Date('2026-05-07T10:01:00.000Z'),
    });
    await boundary.hardStopForExplicitMove('tab-b');
    expect(records['tab-b']).toBeUndefined();
  });

  it('hard-stops every stored session in a removed window', async () => {
    const { records, storage } = memoryStorage();
    let seq = 0;
    const boundary = createTabSessionBoundary({
      storage,
      mintId: () => `tses_${String((seq += 1))}`,
    });
    await boundary.recordActivity({
      tabIdHash: 'tab-a',
      windowIdHash: 'win-a',
      url: 'https://example.test/a',
    });
    await boundary.recordActivity({
      tabIdHash: 'tab-b',
      windowIdHash: 'win-b',
      url: 'https://example.test/b',
    });
    await boundary.hardStopWindow('win-a');
    expect(records['tab-a']).toBeUndefined();
    expect(records['tab-b']?.tabSessionId).toBe('tses_2');
  });

  it('tracks idle progression and reopens the same session on activity within the idle window', async () => {
    const { records, storage } = memoryStorage();
    let seq = 0;
    const boundary = createTabSessionBoundary({
      storage,
      mintId: () => `tses_${String((seq += 1))}`,
    });
    const first = await boundary.recordActivity({
      tabIdHash: 'tab-a',
      windowIdHash: 'win-a',
      url: 'https://chatgpt.com/c/thread-a',
      at: new Date('2026-05-07T10:00:00.000Z'),
    });
    await boundary.markIdle(new Date('2026-05-07T10:05:00.000Z'));
    expect(records['tab-a']?.idleSince).toBe('2026-05-07T10:05:00.000Z');
    const second = await boundary.recordActivity({
      tabIdHash: 'tab-a',
      windowIdHash: 'win-a',
      url: 'https://chatgpt.com/c/thread-a',
      at: new Date('2026-05-07T10:10:00.000Z'),
    });
    expect(second.tabSessionId).toBe(first.tabSessionId);
    expect(records['tab-a']?.idleSince).toBeUndefined();
  });

  it('mints a new session on known-provider thread-id changes', async () => {
    const { storage } = memoryStorage();
    let seq = 0;
    const boundary = createTabSessionBoundary({
      storage,
      mintId: () => `tses_${String((seq += 1))}`,
    });
    const first = await boundary.recordActivity({
      tabIdHash: 'tab-a',
      windowIdHash: 'win-a',
      url: 'https://chatgpt.com/c/thread-a',
    });
    const second = await boundary.recordActivity({
      tabIdHash: 'tab-a',
      windowIdHash: 'win-a',
      url: 'https://chatgpt.com/c/thread-b',
    });
    expect(second.tabSessionId).not.toBe(first.tabSessionId);
  });

  it('records opener tab-session chains from chrome tab creation', async () => {
    const { records, storage } = memoryStorage();
    let seq = 0;
    const boundary = createTabSessionBoundary({
      storage,
      mintId: () => `tses_${String((seq += 1))}`,
    });
    const parent = await boundary.recordActivity({
      tabIdHash: 'tab-parent',
      windowIdHash: 'win-a',
      url: 'https://example.test/parent',
    });
    const child = await boundary.recordTabCreated({
      tabIdHash: 'tab-child',
      windowIdHash: 'win-a',
      openerTabIdHash: 'tab-parent',
    });
    expect(child.openerTabSessionId).toBe(parent.tabSessionId);
    expect(records['tab-child']?.openerTabSessionId).toBe(parent.tabSessionId);
  });

  it('soft idle close is feature-flagged and requires embedding drift threshold', async () => {
    const { records, storage } = memoryStorage();
    const staleRecord: StoredTabSession = {
      tabSessionId: 'tses_stale',
      openedAt: '2026-05-07T10:00:00.000Z',
      lastActivityAt: '2026-05-07T10:00:00.000Z',
      idleSince: '2026-05-07T10:00:00.000Z',
    };
    await storage.set('tab-a', staleRecord);
    const disabled = createTabSessionBoundary({
      storage,
      mintId: () => 'tses_new',
      softCloseOnIdleDriftEnabled: false,
      embeddingDriftForTab: () => 1,
    });
    await disabled.sweepIdle(new Date('2026-05-07T10:30:00.000Z'));
    expect(records['tab-a']).toBeDefined();

    const enabled = createTabSessionBoundary({
      storage,
      mintId: () => 'tses_new',
      softCloseOnIdleDriftEnabled: true,
      embeddingDriftForTab: () => 0.5,
    });
    await enabled.sweepIdle(new Date('2026-05-07T10:30:00.000Z'));
    expect(records['tab-a']).toBeUndefined();
  });
});
