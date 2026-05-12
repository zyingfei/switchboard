import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserTimelineObservedPayload } from '../../../src/timeline/events';
import { createTimelineObserver } from '../../../src/timeline/observer';

// Sync Contract v1 / Class F — TimelineObserver coalesce + debounce.
//
// The observer takes raw tab observations and decides which produce
// `browser.timeline.observed` payloads. The contract:
//   - Same (tabIdHash, canonicalUrl) within coalesceWindowMs → no
//     emission.
//   - Same tabIdHash, new canonicalUrl → emit.
//   - New tabIdHash → emit.
//   - Title-only change → no emission.
//   - Tab close → emit `transition: 'closed'` for the last URL.

const setup = () => {
  const emitted: BrowserTimelineObservedPayload[] = [];
  let now = new Date('2026-05-07T10:00:00.000Z');
  const observer = createTimelineObserver({
    clock: () => now,
    emit: (p) => emitted.push(p),
    hashTabId: (tabId, windowId) => `tab_${String(tabId)}_${String(windowId)}`,
    hashWindowId: (windowId) => `win_${String(windowId)}`,
    canonicalize: (url) => url.replace(/\?.*$/u, ''),
    coalesceWindowMs: 30_000,
    mintEventId: ({ tabIdHash, canonicalUrl, observedAt }) =>
      `${tabIdHash}|${canonicalUrl ?? ''}|${observedAt}`,
  });
  return {
    emitted,
    observer,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
};

describe('TimelineObserver — coalesce + debounce', () => {
  it('first observation on a new tab emits', () => {
    const { emitted, observer } = setup();
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', transition: 'activated' });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.transition).toBe('activated');
    expect(emitted[0]?.tabIdHash).toBe('tab_1_1');
    expect(emitted[0]?.canonicalUrl).toBe('https://x/a');
    expect(emitted[0]?.workstreamId).toBeUndefined();
  });

  it('emits tabSessionId and openerTabSessionId when supplied by wiring', () => {
    const { emitted, observer } = setup();
    observer.observe({
      tabId: 1,
      windowId: 1,
      url: 'https://x/a',
      transition: 'activated',
      tabSessionId: 'tses_child',
      openerTabSessionId: 'tses_parent',
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.tabSessionId).toBe('tses_child');
    expect(emitted[0]?.openerTabSessionId).toBe('tses_parent');
    expect(emitted[0]?.workstreamId).toBeUndefined();
  });

  it('same (tabIdHash, canonicalUrl) within window does NOT emit', () => {
    const { emitted, observer, advance } = setup();
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a?token=1', transition: 'activated' });
    advance(5_000);
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a?token=2', transition: 'updated' });
    expect(emitted).toHaveLength(1);
  });

  it('same canonicalUrl outside window emits an updated', () => {
    const { emitted, observer, advance } = setup();
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', transition: 'activated' });
    advance(31_000);
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', transition: 'updated' });
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.transition).toBe('updated');
  });

  it('navigation to a new canonicalUrl on the same tab emits', () => {
    const { emitted, observer, advance } = setup();
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', transition: 'activated' });
    advance(5_000);
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/b', transition: 'updated' });
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.canonicalUrl).toBe('https://x/b');
    expect(emitted[1]?.transition).toBe('updated');
  });

  it('different tabs are independent', () => {
    const { emitted, observer } = setup();
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', transition: 'activated' });
    observer.observe({ tabId: 2, windowId: 1, url: 'https://x/a', transition: 'activated' });
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.tabIdHash).toBe('tab_1_1');
    expect(emitted[1]?.tabIdHash).toBe('tab_2_1');
  });

  it('repeat of the same URL+title within the coalesce window does NOT emit', () => {
    const { emitted, observer, advance } = setup();
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', title: 'A', transition: 'activated' });
    advance(2_000);
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', title: 'A', transition: 'updated' });
    expect(emitted).toHaveLength(1);
  });

  it('title change within the coalesce window DOES emit so the projection picks it up', () => {
    // SPAs like chatgpt.com update document.title after streaming finishes,
    // landing well inside the 30 s coalesce window. The observer must re-emit
    // so the tab-session projection's latestTitle reflects the new value.
    const { emitted, observer, advance } = setup();
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', transition: 'activated' });
    advance(2_000);
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', title: 'A real title', transition: 'updated' });
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.title).toBe('A real title');
  });

  it('title rename within the coalesce window emits the new title', () => {
    const { emitted, observer, advance } = setup();
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', title: 'A', transition: 'activated' });
    advance(2_000);
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', title: 'A renamed', transition: 'updated' });
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.title).toBe('A renamed');
  });

  it('close emits a closed transition with the last observed URL', () => {
    const { emitted, observer, advance } = setup();
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', title: 'A', transition: 'activated' });
    advance(60_000);
    observer.close({ tabId: 1, windowId: 1 });
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.transition).toBe('closed');
    expect(emitted[1]?.canonicalUrl).toBe('https://x/a');
  });

  it('close on an unknown tab is a no-op', () => {
    const { emitted, observer } = setup();
    observer.close({ tabId: 999, windowId: 999 });
    expect(emitted).toHaveLength(0);
  });

  it('mintEventId determines the emitted eventId', () => {
    const { emitted, observer } = setup();
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', transition: 'activated' });
    expect(emitted[0]?.eventId).toBe(
      'tab_1_1|https://x/a|2026-05-07T10:00:00.000Z',
    );
  });

  it('sanitizes raw URL — strips fragment and sensitive query params', () => {
    const { emitted, observer } = setup();
    observer.observe({
      tabId: 1,
      windowId: 1,
      url: 'https://example.com/callback?code=abc&state=xyz#hash',
      transition: 'activated',
    });
    // Synthetic canonicalize in setup() strips ?... already, so for
    // this URL canonicalUrl is 'https://example.com/callback' and
    // url is the sanitized form (which also collapses to that).
    expect(emitted[0]?.url).toBe('https://example.com/callback');
    expect(emitted[0]?.canonicalUrl).toBe('https://example.com/callback');
  });

  it('drops oversized URL silently (passive intent, no allocation)', () => {
    const { emitted, observer } = setup();
    const huge = 'https://x.com/?q=' + 'a'.repeat(5000);
    observer.observe({ tabId: 1, windowId: 1, url: huge, transition: 'activated' });
    // No emission — exceeded URL_MAX_LENGTH (4096).
    expect(emitted).toHaveLength(0);
  });

  // Stage 5 follow-up — Google search URLs / marketing landing pages
  // routinely produce 500+ char URLs. The default mintEventId used to
  // concatenate the full URL into the eventId, pushing past the
  // companion's TIMELINE_EVENT_ID_MAX_LENGTH (256) and causing the
  // /v1/timeline/events POST to skip the event with invalid-payload.
  // Now the URL portion is FNV-1a32 hashed so the eventId is bounded.
  it('default mintEventId keeps eventId bounded for long URLs', async () => {
    const { createTimelineObserver } = await import('../../../src/timeline/observer');
    const emitted: { readonly eventId: string }[] = [];
    const observer = createTimelineObserver({
      hashTabId: () => 'tabhash',
      hashWindowId: () => 'windowhash',
      emit: (payload) => {
        emitted.push({ eventId: payload.eventId });
      },
      clock: () => new Date('2026-05-11T18:57:00.000Z'),
      // Default mintEventId — NOT overridden.
    });
    const longUrl =
      'https://www.google.com/search?q=cartesian+pairs+multiplier&newwindow=1&sca_esv=' +
      '43a6c5a008a39361&sxsrf=ANbL-n6_ko5CWFfBfcAioxLCbUfTZNSfoA%3A1778521009893' +
      '&ei=sRMCarOVNq6O8L0P_pru2Qo&iflsig=AFdpzrgAAAAAagIvyx9Ajwyu3Y_D_2vTzTVvsdtU6H09' +
      '&ved=0ahUKEwjzsZSI47GUAxUuB7wBHX6NO6sQ4dUDCBE&uact=5&oq=cartesian+pairs+multiplier' +
      '&gs_lp=Egxnd3Mtd2l6LXNlcnAiG0NhcnRlc2lhbi1wYWlycyBtdWx0aXBsaWVyIDIEECMYJzIFEAAY7wU' +
      '&sclient=gws-wiz-serp';
    observer.observe({
      tabId: 1,
      windowId: 1,
      url: longUrl,
      transition: 'completed',
    });
    expect(emitted).toHaveLength(1);
    // Was previously > 600 chars (full URL embedded). Now hashed.
    const eventId = emitted[0]?.eventId ?? '';
    expect(eventId.length).toBeLessThan(80);
    // Sanity: must still contain the surrounding scaffolding.
    expect(eventId.startsWith('tl_tabhash|')).toBe(true);
  });

  it('truncates oversized title rather than dropping the observation', () => {
    const { emitted, observer } = setup();
    const longTitle = 'T'.repeat(2000);
    observer.observe({
      tabId: 1,
      windowId: 1,
      url: 'https://x/a',
      title: longTitle,
      transition: 'activated',
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.title).toBeDefined();
    expect((emitted[0]?.title ?? '').length).toBeLessThanOrEqual(1024);
  });

  it('sanitizes URL even when canonicalize returns undefined', () => {
    // Set up a fresh observer with no canonicalize hook so the
    // sanitizer's responsibility for url= is tested in isolation.
    const emitted: BrowserTimelineObservedPayload[] = [];
    const now = new Date('2026-05-07T10:00:00.000Z');
    const observer = createTimelineObserver({
      clock: () => now,
      emit: (p) => emitted.push(p),
      hashTabId: () => 'tab_h',
      hashWindowId: () => 'win_h',
      // No canonicalize at all — canonicalUrl will be undefined.
    });
    observer.observe({
      tabId: 1,
      windowId: 1,
      url: 'https://nopr0v1der.com/?password=secret&q=hi',
      transition: 'activated',
    });
    expect(emitted[0]?.url).toBe('https://nopr0v1der.com/?q=hi');
    expect(emitted[0]?.canonicalUrl).toBeUndefined();
  });
});
