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
});
