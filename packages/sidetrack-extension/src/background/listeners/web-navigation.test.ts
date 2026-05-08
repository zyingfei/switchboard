import { describe, expect, it } from 'vitest';

import { InMemoryEventBuffer } from '../storage/in-memory-event-buffer';
import { saltedFnv1a32Hex } from '../../graph/fnv1a';
import { createTabOpenerStore } from './tabs';
import {
  createWebNavigationListener,
  NAVIGATION_COMMITTED,
  type NavigationCommittedPayload,
  type TabsLookupApi,
  type WebNavigationApi,
} from './web-navigation';

const makeDeps = (tabs: Map<number, { readonly windowId: number }>) => {
  const buffer = new InMemoryEventBuffer();
  const store = createTabOpenerStore();
  let seq = 1;
  const webNavigation: WebNavigationApi = {
    onCommitted: { addListener: () => undefined },
  };
  const tabsApi: TabsLookupApi = {
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (tab === undefined) throw new Error('tab not found');
      return { id: tabId, windowId: tab.windowId };
    },
  };
  const listener = createWebNavigationListener({
    webNavigation,
    tabs: tabsApi,
    tabOpenerStore: store,
    eventBuffer: buffer,
    browserSessionStartMs: 1778260000000,
    edgeReplicaId: 'edge_test',
    allocateSeq: async (count = 1) => {
      const fromSeq = seq;
      seq += count;
      return { edgeReplicaId: 'edge_test', fromSeq, toSeq: seq - 1 };
    },
    now: () => new Date('2026-05-08T12:00:00.000Z'),
  });
  return { buffer, listener, store };
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
});
