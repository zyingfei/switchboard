import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryEventBuffer } from '../storage/in-memory-event-buffer';
import { saltedFnv1a32Hex } from '../../graph/fnv1a';
import { createTabOpenerStore } from './tabs';
import {
  createWebNavigationListener,
  loadOrCreateBrowserSessionStartMs,
  NAVIGATION_COMMITTED,
  type NavigationCommittedPayload,
  type TabsLookupApi,
  type WebNavigationApi,
} from './web-navigation';

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

const makeDeps = (
  tabs: Map<number, { readonly windowId: number; readonly url?: string }>,
) => {
  const buffer = new InMemoryEventBuffer();
  const store = createTabOpenerStore();
  const navigationStateStorageBacking: Record<string, unknown> = {};
  const navigationStateStorage = {
    get: vi.fn((key: string) => Promise.resolve({ [key]: navigationStateStorageBacking[key] })),
    set: vi.fn((entries: Record<string, unknown>) => {
      Object.assign(navigationStateStorageBacking, entries);
      return Promise.resolve();
    }),
  };
  let seq = 1;
  const webNavigation: WebNavigationApi = {
    onCommitted: { addListener: () => undefined },
  };
  const tabsApi: TabsLookupApi = {
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (tab === undefined) throw new Error('tab not found');
      return {
        id: tabId,
        windowId: tab.windowId,
        ...(tab.url === undefined ? {} : { url: tab.url }),
      };
    },
  };
  const onNavigationBuffered = vi.fn();
  const listener = createWebNavigationListener({
    webNavigation,
    tabs: tabsApi,
    tabOpenerStore: store,
    eventBuffer: buffer,
    navigationStateStorage,
    onNavigationBuffered,
    browserSessionStartMs: 1778260000000,
    edgeReplicaId: 'edge_test',
    allocateSeq: async (count = 1) => {
      const fromSeq = seq;
      seq += count;
      return { edgeReplicaId: 'edge_test', fromSeq, toSeq: seq - 1 };
    },
    now: () => new Date('2026-05-08T12:00:00.000Z'),
  });
  const createRestartedListener = () =>
    createWebNavigationListener({
      webNavigation,
      tabs: tabsApi,
      tabOpenerStore: store,
      eventBuffer: buffer,
      navigationStateStorage,
      onNavigationBuffered,
      browserSessionStartMs: 1778260000000,
      edgeReplicaId: 'edge_test',
      allocateSeq: async (count = 1) => {
        const fromSeq = seq;
        seq += count;
        return { edgeReplicaId: 'edge_test', fromSeq, toSeq: seq - 1 };
      },
      now: () => new Date('2026-05-08T12:00:00.000Z'),
    });
  return {
    buffer,
    createRestartedListener,
    listener,
    navigationStateStorage,
    onNavigationBuffered,
    store,
  };
};

const payloads = async (buffer: InMemoryEventBuffer): Promise<NavigationCommittedPayload[]> =>
  (await buffer.peek(100)).map((event) => event.payload as NavigationCommittedPayload);

describe('webNavigation committed listener', () => {
  it('ignores non-top-frame committed events', async () => {
    const { buffer, listener } = makeDeps(new Map([[1, { windowId: 9 }]]));
    await listener.handleCommitted({
      tabId: 1,
      frameId: 1,
      url: 'https://example.com/frame',
      timeStamp: 100,
      transitionType: 'link',
      transitionQualifiers: [],
    });
    expect(await buffer.count()).toBe(0);
  });

  it('emits navigation.committed payloads and previousVisitId on same-tab sequence', async () => {
    const { buffer, listener } = makeDeps(new Map([[1, { windowId: 9 }]]));
    await listener.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://EXAMPLE.com:443/a?utm_source=x&q=1#frag',
      timeStamp: 100,
      documentId: 'doc-a',
      transitionType: 'typed',
      transitionQualifiers: ['from_address_bar'],
    });
    await listener.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/b',
      timeStamp: 200,
      documentId: 'doc-b',
      parentDocumentId: 'doc-a',
      transitionType: 'link',
      transitionQualifiers: ['client_redirect', 'unsupported'],
    });

    const [first, second] = await payloads(buffer);
    expect(first?.canonicalUrl).toBe('https://example.com/a?q=1');
    expect(first?.transitionType).toBe('typed');
    expect(first?.transitionQualifiers).toEqual(['from_address_bar']);
    expect(first?.openerVisitId).toBeNull();
    expect(first?.previousVisitId).toBeNull();
    expect(second?.previousVisitId).toBe(first?.visitId);
    expect(second?.navigationSequence).toBe(2);
    expect(second?.parentDocumentId).toBe('doc-a');
    expect(second?.transitionQualifiers).toEqual(['client_redirect']);
  });

  it('notifies after buffering a top-frame navigation event', async () => {
    const { listener, onNavigationBuffered } = makeDeps(new Map([[1, { windowId: 9 }]]));

    await listener.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/story',
      timeStamp: 100,
      transitionType: 'link',
      transitionQualifiers: [],
    });

    expect(onNavigationBuffered).toHaveBeenCalledTimes(1);
  });

  it('resolves openerVisitId only while the opener tab is alive', async () => {
    const tabs = new Map([
      [1, { windowId: 9 }],
      [2, { windowId: 9 }],
    ]);
    const { buffer, listener, store } = makeDeps(tabs);

    await listener.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/source',
      timeStamp: 100,
      transitionType: 'typed',
      transitionQualifiers: [],
    });
    store.rememberCreated(2, 1);
    await listener.handleCommitted({
      tabId: 2,
      frameId: 0,
      url: 'https://example.com/child',
      timeStamp: 200,
      transitionType: 'link',
      transitionQualifiers: [],
    });
    store.markRemoved(1);
    tabs.delete(1);
    await listener.handleCommitted({
      tabId: 2,
      frameId: 0,
      url: 'https://example.com/child-next',
      timeStamp: 300,
      transitionType: 'link',
      transitionQualifiers: [],
    });

    const [source, child, childNext] = await payloads(buffer);
    expect(child?.openerVisitId).toBe(source?.visitId);
    expect(childNext?.openerVisitId).toBeNull();
    expect(childNext?.previousVisitId).toBe(child?.visitId);
  });

  it('hydrates previous visit state from buffered navigation stream', async () => {
    const { buffer, listener } = makeDeps(new Map([[4, { windowId: 8 }]]));
    await buffer.appendMany([
      {
        streamName: NAVIGATION_COMMITTED,
        lamport: 1,
        replicaId: 'edge_test',
        observedAt: '2026-05-08T11:00:00.000Z',
        payload: {
          payloadVersion: 1,
          visitId: 'visit_existing',
          tabSessionIdHash: saltedFnv1a32Hex('edge_test', 'tab|4|1778260000000'),
          navigationSequence: 3,
        },
      },
    ]);

    await listener.handleCommitted({
      tabId: 4,
      frameId: 0,
      url: 'https://example.com/after-restart',
      timeStamp: 400,
      transitionType: 'reload',
      transitionQualifiers: [],
    });

    const emitted = await payloads(buffer);
    const latest = emitted.at(-1);
    expect(latest?.previousVisitId).toBe('visit_existing');
    expect(latest?.navigationSequence).toBe(4);
  });

  it('hydrates previous visit state from session storage after buffered events drain', async () => {
    const { buffer, createRestartedListener, listener, navigationStateStorage } = makeDeps(
      new Map([[7, { windowId: 8 }]]),
    );

    await listener.handleCommitted({
      tabId: 7,
      frameId: 0,
      url: 'https://news.ycombinator.com/item?id=1',
      timeStamp: 500,
      transitionType: 'typed',
      transitionQualifiers: [],
    });
    const [source] = await payloads(buffer);
    expect(source?.previousVisitId).toBeNull();
    await buffer.deleteMany(await buffer.peek(100));

    const restarted = createRestartedListener();
    await restarted.handleCommitted({
      tabId: 7,
      frameId: 0,
      url: 'https://example.com/from-hn',
      timeStamp: 600,
      transitionType: 'link',
      transitionQualifiers: [],
    });

    const [destination] = await payloads(buffer);
    expect(navigationStateStorage.set).toHaveBeenCalled();
    expect(destination?.previousVisitId).toBe(source?.visitId);
    expect(destination?.navigationSequence).toBe(2);
  });

  it('uses a link-click fallback as same-tab provenance when source state was missing', async () => {
    const { buffer, listener } = makeDeps(new Map([[9, { windowId: 8 }]]));

    await listener.recordLinkClick({
      tabId: 9,
      sourceUrl: 'https://news.ycombinator.com/news',
      targetUrl: 'https://example.com/story',
      timeStamp: 700,
    });
    await listener.handleCommitted({
      tabId: 9,
      frameId: 0,
      url: 'https://example.com/story',
      timeStamp: 750,
      transitionType: 'link',
      transitionQualifiers: [],
    });

    const [source, destination] = await payloads(buffer);
    expect(source?.canonicalUrl).toBe('https://news.ycombinator.com/news');
    expect(source?.dimensions?.provenance?.source).toBe(
      'content-script.link-click.source-fallback',
    );
    expect(destination?.canonicalUrl).toBe('https://example.com/story');
    expect(destination?.previousVisitId).toBe(source?.visitId);
    expect(destination?.openerVisitId).toBeNull();
  });

  it('uses a link-click fallback as opener provenance when new-tab opener state was missing', async () => {
    const { buffer, listener } = makeDeps(
      new Map([
        [10, { windowId: 8 }],
        [11, { windowId: 8 }],
      ]),
    );

    await listener.handleCommitted({
      tabId: 10,
      frameId: 0,
      url: 'https://news.ycombinator.com/news',
      timeStamp: 800,
      transitionType: 'typed',
      transitionQualifiers: [],
    });
    await listener.recordLinkClick({
      tabId: 10,
      sourceUrl: 'https://news.ycombinator.com/news',
      targetUrl: 'https://example.com/from-hn',
      timeStamp: 810,
    });
    await listener.handleCommitted({
      tabId: 11,
      frameId: 0,
      url: 'https://example.com/from-hn',
      timeStamp: 850,
      transitionType: 'link',
      transitionQualifiers: [],
    });

    const [source, destination] = await payloads(buffer);
    expect(destination?.previousVisitId).toBeNull();
    expect(destination?.openerVisitId).toBe(source?.visitId);
  });

  it('uses webNavigation target-created as opener provenance for new-tab links', async () => {
    const tabs = new Map([
      [12, { windowId: 8, url: 'https://news.ycombinator.com/newest' }],
      [13, { windowId: 8 }],
    ]);
    const { buffer, listener } = makeDeps(tabs);

    await listener.handleCommitted({
      tabId: 12,
      frameId: 0,
      url: 'https://news.ycombinator.com/newest',
      timeStamp: 900,
      transitionType: 'typed',
      transitionQualifiers: [],
    });
    await listener.recordNavigationTargetCreated({
      sourceTabId: 12,
      tabId: 13,
      url: 'https://example.com/from-hn-new-tab',
      timeStamp: 910,
    });
    await listener.handleCommitted({
      tabId: 13,
      frameId: 0,
      url: 'https://example.com/from-hn-new-tab',
      timeStamp: 950,
      transitionType: 'link',
      transitionQualifiers: [],
    });

    const [source, destination] = await payloads(buffer);
    expect(destination?.previousVisitId).toBeNull();
    expect(destination?.openerVisitId).toBe(source?.visitId);
  });

  it('persists browser session start across service-worker restarts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-08T10:00:00.000Z'));
    const store: Record<string, unknown> = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        session: {
          get: vi.fn((key: string) => Promise.resolve({ [key]: store[key] })),
          set: vi.fn((entries: Record<string, unknown>) => {
            Object.assign(store, entries);
            return Promise.resolve();
          }),
        },
        local: {
          get: vi.fn(),
          set: vi.fn(),
        },
      },
    };

    const first = await loadOrCreateBrowserSessionStartMs();
    vi.setSystemTime(new Date('2026-05-08T11:00:00.000Z'));
    const second = await loadOrCreateBrowserSessionStartMs();

    expect(first).toBe(Date.parse('2026-05-08T10:00:00.000Z'));
    expect(second).toBe(first);
  });
});
