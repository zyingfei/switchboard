import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startEngagementTracking } from '../../../../entrypoints/engagement';

describe('engagement content script wiring', () => {
  const sent: unknown[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    Object.defineProperty(document, 'hasFocus', {
      value: () => true,
      configurable: true,
    });
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        // safeSendRuntimeMessage no-ops when chrome.runtime.id is
        // undefined (orphaned-content-script guard added in 527ce473);
        // a live content script always has an id, so the mock must too.
        id: 'test-extension-id',
        sendMessage: vi.fn((message: unknown) => {
          sent.push(message);
          return Promise.resolve();
        }),
        onMessage: { addListener: vi.fn() },
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('emits counts-and-durations payloads after visibility, scroll, and copy events', () => {
    startEngagementTracking();
    document.dispatchEvent(new Event('copy'));
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 2_000,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, 'clientHeight', {
      value: 1_000,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, 'scrollTop', {
      value: 500,
      configurable: true,
    });
    document.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(1_000);
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));

    const emitted = sent.at(-1) as {
      readonly type?: string;
      readonly final?: boolean;
      readonly dimensions?: {
        readonly engagement?: { readonly copyCount?: number; readonly scrollEvents?: number };
      };
    };
    expect(emitted.type).toBe('sidetrack.engagement.interval');
    expect(emitted.final).toBe(true);
    expect(emitted.dimensions?.engagement?.copyCount).toBe(1);
    expect(emitted.dimensions?.engagement?.scrollEvents).toBe(1);
  });

  it('emits an early non-final snapshot once the attention gate has focused time', () => {
    startEngagementTracking();

    vi.advanceTimersByTime(4_999);
    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(1);

    const emitted = sent.at(-1) as {
      readonly type?: string;
      readonly final?: boolean;
      readonly dimensions?: {
        readonly engagement?: { readonly focusedWindowMs?: number };
      };
    };
    expect(emitted.type).toBe('sidetrack.engagement.interval');
    expect(emitted.final).toBe(false);
    expect(emitted.dimensions?.engagement?.focusedWindowMs).toBeGreaterThanOrEqual(5_000);
  });

  it('suppresses zero-delta periodic beacons from a background tab (only idle grows)', () => {
    // A background (non-selected) tab: not visible, so no active/visible/
    // focused time ever accrues. The attention gate never fires (0 focused
    // time). The first periodic tick sends one snapshot; every later tick
    // is zero-delta and is suppressed — the flood this whole change kills.
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true });

    startEngagementTracking();

    vi.advanceTimersByTime(30_000); // first periodic tick -> sent (first of session)
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(30_000); // second periodic tick -> zero-delta -> suppressed
    vi.advanceTimersByTime(30_000); // third -> still suppressed
    expect(sent).toHaveLength(1);
  });

  it('resumes emitting once the background tab gains attention', () => {
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true });

    startEngagementTracking();

    vi.advanceTimersByTime(30_000);
    expect(sent).toHaveLength(1);
    // The tab becomes the selected tab in a focused window: a scroll records
    // an attention delta, so the next periodic tick is no longer zero-delta.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(30_000);
    expect(sent.length).toBeGreaterThan(1);
  });
});
