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

  it('title-only change within the coalesce window does NOT emit', () => {
    const { emitted, observer, advance } = setup();
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', title: 'A', transition: 'activated' });
    advance(2_000);
    observer.observe({ tabId: 1, windowId: 1, url: 'https://x/a', title: 'A renamed', transition: 'updated' });
    expect(emitted).toHaveLength(1);
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
});
