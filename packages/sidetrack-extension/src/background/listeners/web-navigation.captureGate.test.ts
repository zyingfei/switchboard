import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  matchesNoCaptureRules,
  type NoCaptureRule,
} from '../../capture/noCaptureRules';
import { InMemoryEventBuffer } from '../storage/in-memory-event-buffer';
import { createTabOpenerStore } from './tabs';
import {
  createWebNavigationListener,
  type NavigationCommittedPayload,
  type TabsLookupApi,
  type WebNavigationApi,
} from './web-navigation';

// Regression test for the capture-pause BYPASS.
//
// Before the fix, chrome.webNavigation.onCommitted (registered in
// web-navigation.ts) buffered a `navigation.committed` event — carrying
// the page URL + canonicalUrl — on EVERY navigation with NO gate at
// all. The edge-events drainer then POSTed it to /v1/companion, so a
// user who paused capture (captureEnabled=false) still had e.g. their
// pge.com visit shipped to the companion. The fix routes handleCommitted
// / recordLinkClick through the shared capture gate
// (isCaptureAllowedForUrl). These tests assert ZERO buffer writes when
// the gate denies — the buffer feeds the drainer's POST, so zero buffer
// writes ⇒ zero companion posts for a paused / blocked page.

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

const makeListener = (opts: {
  readonly isCaptureAllowedForUrl?: (url: string) => Promise<boolean>;
}) => {
  const buffer = new InMemoryEventBuffer();
  const store = createTabOpenerStore();
  let seq = 1;
  const webNavigation: WebNavigationApi = { onCommitted: { addListener: () => undefined } };
  const tabsApi: TabsLookupApi = {
    async get(tabId) {
      return { id: tabId, windowId: 9 };
    },
  };
  const onNavigationBuffered = vi.fn();
  const listener = createWebNavigationListener({
    webNavigation,
    tabs: tabsApi,
    tabOpenerStore: store,
    eventBuffer: buffer,
    onNavigationBuffered,
    browserSessionStartMs: 1778260000000,
    edgeReplicaId: 'edge_test',
    allocateSeq: async (count = 1) => {
      const fromSeq = seq;
      seq += count;
      return { edgeReplicaId: 'edge_test', fromSeq, toSeq: seq - 1 };
    },
    now: () => new Date('2026-07-11T12:00:00.000Z'),
    ...(opts.isCaptureAllowedForUrl === undefined
      ? {}
      : { isCaptureAllowedForUrl: opts.isCaptureAllowedForUrl }),
  });
  return { buffer, listener, onNavigationBuffered };
};

const payloads = async (buffer: InMemoryEventBuffer): Promise<NavigationCommittedPayload[]> =>
  (await buffer.peek(100)).map((event) => event.payload as NavigationCommittedPayload);

describe('web-navigation capture gate (pause-bypass regression)', () => {
  it('buffers nothing when the capture gate denies (captureEnabled=false)', async () => {
    const gate = vi.fn(async () => false);
    const { buffer, listener, onNavigationBuffered } = makeListener({
      isCaptureAllowedForUrl: gate,
    });

    await listener.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://www.pge.com/en/account/billing.page',
      timeStamp: 100,
      transitionType: 'typed',
      transitionQualifiers: ['from_address_bar'],
    });

    expect(gate).toHaveBeenCalledWith('https://www.pge.com/en/account/billing.page');
    expect(await buffer.count()).toBe(0);
    expect(onNavigationBuffered).not.toHaveBeenCalled();
  });

  it('buffers nothing for a link click when the gate denies', async () => {
    const gate = vi.fn(async () => false);
    const { buffer, onNavigationBuffered } = makeListener({ isCaptureAllowedForUrl: gate });
    const { listener } = makeListener({ isCaptureAllowedForUrl: gate });

    await listener.recordLinkClick({
      tabId: 1,
      sourceUrl: 'https://example.com/a',
      targetUrl: 'https://www.pge.com/en/account/pay.page',
      timeStamp: 100,
    });

    void onNavigationBuffered;
    expect(await buffer.count()).toBe(0);
  });

  it('still buffers when the gate allows (capture on, site not blocked)', async () => {
    const gate = vi.fn(async () => true);
    const { buffer, listener } = makeListener({ isCaptureAllowedForUrl: gate });

    await listener.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/story',
      timeStamp: 100,
      transitionType: 'link',
      transitionQualifiers: [],
    });

    const [first] = await payloads(buffer);
    expect(first?.canonicalUrl).toBe('https://example.com/story');
    expect(await buffer.count()).toBe(1);
  });

  it('gate denial is per-URL — allows one navigation, blocks the next', async () => {
    const blockedDomain = 'pge.com';
    const gate = vi.fn(async (url: string) => !url.includes(blockedDomain));
    const { buffer, listener } = makeListener({ isCaptureAllowedForUrl: gate });

    await listener.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/allowed',
      timeStamp: 100,
      transitionType: 'link',
      transitionQualifiers: [],
    });
    await listener.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://www.pge.com/en/account/blocked.page',
      timeStamp: 200,
      transitionType: 'typed',
      transitionQualifiers: [],
    });

    const buffered = await payloads(buffer);
    expect(buffered).toHaveLength(1);
    expect(buffered[0]?.url).toBe('https://example.com/allowed');
  });

  it('fails CLOSED — a gate that throws buffers nothing', async () => {
    const gate = vi.fn(async () => {
      throw new Error('gate read failed');
    });
    const { buffer, listener } = makeListener({ isCaptureAllowedForUrl: gate });

    await listener.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://www.pge.com/en/account/billing.page',
      timeStamp: 100,
      transitionType: 'typed',
      transitionQualifiers: [],
    });

    expect(await buffer.count()).toBe(0);
  });

  it('back-compat: no gate dep ⇒ allows (legacy callers unchanged)', async () => {
    const { buffer, listener } = makeListener({});

    await listener.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://example.com/legacy',
      timeStamp: 100,
      transitionType: 'link',
      transitionQualifiers: [],
    });

    expect(await buffer.count()).toBe(1);
  });
});

// End-to-end scope regression for the meet.google.com bug. Instead of a
// hand-mocked gate, this wires the REAL no-capture matcher into the gate
// exactly the way background.ts composes it
// (`!matchesNoCaptureRules({ url }, rules)`), so it proves the listener
// buffers/ships google.com traffic even when meet.google.com is blocked.
describe('web-navigation capture gate × host-scoped no-capture rule', () => {
  const gateForRules =
    (rules: readonly NoCaptureRule[]) =>
    async (url: string): Promise<boolean> =>
      !matchesNoCaptureRules({ url }, rules);

  // The exact shape the "Don't capture <site>" action produces for a click
  // on meet.google.com (host-scoped: domain=eTLD+1 for the label, host=the
  // exact host that drives matching).
  const meetHostRule: NoCaptureRule = {
    id: 'ncr_meet',
    kind: 'domain',
    domain: 'google.com',
    host: 'meet.google.com',
    label: 'meet.google.com',
    createdAt: '2026-07-24T00:00:00.000Z',
  };

  it('BUFFERS NOTHING for the blocked host (meet.google.com)', async () => {
    const { buffer, listener } = makeListener({
      isCaptureAllowedForUrl: gateForRules([meetHostRule]),
    });

    await listener.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://meet.google.com/abc-defg-hij',
      timeStamp: 100,
      transitionType: 'typed',
      transitionQualifiers: [],
    });

    expect(await buffer.count()).toBe(0);
  });

  it('STILL BUFFERS the rest of the google.com family (the bug: it did not)', async () => {
    const { buffer, listener } = makeListener({
      isCaptureAllowedForUrl: gateForRules([meetHostRule]),
    });

    // google.com apex + a sibling host — both must remain captured.
    await listener.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://www.google.com/search?q=weather',
      timeStamp: 100,
      transitionType: 'typed',
      transitionQualifiers: [],
    });
    await listener.handleCommitted({
      tabId: 2,
      frameId: 0,
      url: 'https://mail.google.com/mail/u/0',
      timeStamp: 200,
      transitionType: 'link',
      transitionQualifiers: [],
    });

    const urls = (await payloads(buffer)).map((p) => p.url);
    expect(urls).toContain('https://www.google.com/search?q=weather');
    expect(urls).toContain('https://mail.google.com/mail/u/0');
    expect(await buffer.count()).toBe(2);
  });

  it('a legacy family-wide rule (no host) still blocks the whole family', async () => {
    const legacyFamilyRule: NoCaptureRule = {
      id: 'ncr_legacy',
      kind: 'domain',
      domain: 'google.com',
      label: 'google.com',
      createdAt: '2026-07-11T00:00:00.000Z',
    };
    const { buffer, listener } = makeListener({
      isCaptureAllowedForUrl: gateForRules([legacyFamilyRule]),
    });

    await listener.handleCommitted({
      tabId: 1,
      frameId: 0,
      url: 'https://mail.google.com/mail/u/0',
      timeStamp: 100,
      transitionType: 'link',
      transitionQualifiers: [],
    });

    expect(await buffer.count()).toBe(0);
  });
});
