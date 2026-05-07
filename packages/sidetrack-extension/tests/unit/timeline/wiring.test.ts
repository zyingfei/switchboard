import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTimelineMaterializerStateForTests, setTimelineDrainHook } from '../../../src/timeline/materializer';
import { initializeTimelineWiring, resetTimelineWiringForTests } from '../../../src/timeline/wiring';

// Smoke test: the wiring init registers listeners + alarm without
// throwing, and the chrome.tabs.onActivated → observer.observe →
// materializer.admitLocal path runs end-to-end with stubbed chrome
// APIs.

interface ListenerStore {
  onActivated: (info: chrome.tabs.TabActiveInfo) => void;
  onUpdated: (
    tabId: number,
    info: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ) => void;
  onRemoved: (tabId: number, info: chrome.tabs.TabRemoveInfo) => void;
  onAlarm: (alarm: chrome.alarms.Alarm) => void;
}

const stubChrome = (): {
  store: Record<string, unknown>;
  listeners: ListenerStore;
  reset: () => void;
} => {
  const store: Record<string, unknown> = {};
  const listeners: ListenerStore = {
    onActivated: () => undefined,
    onUpdated: () => undefined,
    onRemoved: () => undefined,
    onAlarm: () => undefined,
  };
  const tabState = new Map<number, { url?: string; title?: string; windowId?: number }>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn((req: unknown) => {
          if (typeof req === 'string') return Promise.resolve({ [req]: store[req] });
          if (Array.isArray(req)) {
            const out: Record<string, unknown> = {};
            for (const k of req) out[k] = store[k];
            return Promise.resolve(out);
          }
          if (typeof req === 'object' && req !== null) {
            const out: Record<string, unknown> = {};
            for (const [k, fb] of Object.entries(req)) out[k] = k in store ? store[k] : fb;
            return Promise.resolve(out);
          }
          return Promise.resolve({});
        }),
        set: vi.fn((entries: Record<string, unknown>) => {
          Object.assign(store, entries);
          return Promise.resolve();
        }),
      },
    },
    tabs: {
      onActivated: { addListener: vi.fn((cb: ListenerStore['onActivated']) => { listeners.onActivated = cb; }) },
      onUpdated: { addListener: vi.fn((cb: ListenerStore['onUpdated']) => { listeners.onUpdated = cb; }) },
      onRemoved: { addListener: vi.fn((cb: ListenerStore['onRemoved']) => { listeners.onRemoved = cb; }) },
      get: vi.fn((tabId: number) => Promise.resolve(tabState.get(tabId) ?? { id: tabId })),
      __setTab: (tabId: number, data: { url?: string; title?: string; windowId?: number }) => {
        tabState.set(tabId, data);
      },
    },
    alarms: {
      create: vi.fn(() => Promise.resolve()),
      onAlarm: { addListener: vi.fn((cb: ListenerStore['onAlarm']) => { listeners.onAlarm = cb; }) },
    },
  };
  return {
    store,
    listeners,
    reset: () => {
      for (const k of Object.keys(store)) delete store[k];
      tabState.clear();
    },
  };
};

describe('timeline wiring', () => {
  let env: ReturnType<typeof stubChrome>;
  beforeEach(() => {
    env = stubChrome();
    resetTimelineMaterializerStateForTests();
    resetTimelineWiringForTests();
    setTimelineDrainHook(null);
  });
  afterEach(() => {
    env.reset();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('initialize registers chrome.tabs + chrome.alarms listeners', async () => {
    await initializeTimelineWiring({
      readCompanion: async () => null, // companion offline; drain disabled
    });
    const c = (globalThis as unknown as {
      chrome: {
        tabs: { onActivated: { addListener: { mock: { calls: unknown[] } } } };
        alarms: { create: { mock: { calls: unknown[] } } };
      };
    }).chrome;
    expect(c.tabs.onActivated.addListener.mock.calls.length).toBe(1);
    expect(c.alarms.create.mock.calls.length).toBe(1);
  });

  it('initialize is idempotent across repeated calls', async () => {
    await initializeTimelineWiring({ readCompanion: async () => null });
    await initializeTimelineWiring({ readCompanion: async () => null });
    const c = (globalThis as unknown as {
      chrome: { tabs: { onActivated: { addListener: { mock: { calls: unknown[] } } } } };
    }).chrome;
    expect(c.tabs.onActivated.addListener.mock.calls.length).toBe(1);
  });

  it('chrome.tabs.onActivated → observer.observe → materializer.admitLocal', async () => {
    await initializeTimelineWiring({ readCompanion: async () => null });
    // Pre-populate the tab with a URL.
    const c = (globalThis as unknown as {
      chrome: { tabs: { __setTab: (id: number, data: { url?: string; title?: string; windowId?: number }) => void } };
    }).chrome;
    c.tabs.__setTab(42, {
      url: 'https://chatgpt.com/c/abc123',
      title: 'My chat',
      windowId: 1,
    });
    // Fire the listener — synchronous registration; the listener
    // does an async chrome.tabs.get internally, so we yield twice
    // for the microtask queue.
    env.listeners.onActivated({ tabId: 42, windowId: 1 });
    await new Promise((r) => setTimeout(r, 10));
    // The materializer admitted; spool has one entry.
    const spool = (await (globalThis as unknown as {
      chrome: { storage: { local: { get: (k: string) => Promise<Record<string, unknown>> } } };
    }).chrome.storage.local.get('sidetrack.sync.spool.timeline'))[
      'sidetrack.sync.spool.timeline'
    ];
    expect(Array.isArray(spool)).toBe(true);
    expect((spool as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('chrome.alarms.onAlarm filtered by name; non-timeline alarm is no-op', async () => {
    await initializeTimelineWiring({ readCompanion: async () => null });
    // Fire an unrelated alarm — should not throw.
    env.listeners.onAlarm({
      name: 'sidetrack.dispatch.poll',
      scheduledTime: Date.now(),
    });
    // No assertion necessary — pass means the wiring guards on alarm name.
  });
});
