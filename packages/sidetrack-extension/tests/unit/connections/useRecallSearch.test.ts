import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRecallSearch } from '../../../src/sidepanel/connections/useRecallSearch';

// Stub a minimal chrome.runtime.sendMessage that replies via the
// supplied callback synchronously (vitest's userEvent timing
// works well with this shape).
type SendCb = (response: unknown) => void;
const stubChrome = (responder: (request: unknown) => unknown): void => {
  globalThis.chrome = {
    runtime: {
      sendMessage: vi.fn((message: unknown, cb?: SendCb) => {
        const response = responder(message);
        cb?.(response);
      }),
      lastError: undefined,
    },
  } as unknown as typeof chrome;
};

describe('useRecallSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    // @ts-expect-error — restore default
    delete globalThis.chrome;
  });

  it('returns empty items for an empty query without firing a request', () => {
    const send = vi.fn();
    stubChrome(() => ({ ok: true, items: [] }));
    globalThis.chrome.runtime.sendMessage = send;
    const { result } = renderHook(() => useRecallSearch('', { debounceMs: 100 }));
    expect(result.current.items).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips short queries (< minQueryLength)', () => {
    const send = vi.fn();
    stubChrome(() => ({ ok: true, items: [] }));
    globalThis.chrome.runtime.sendMessage = send;
    renderHook(() => useRecallSearch('co', { debounceMs: 100, minQueryLength: 3 }));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('debounces + maps the response items', () => {
    stubChrome((message) => {
      const m = message as { q: string };
      if (m.q === 'copy fail') {
        return {
          ok: true,
          items: [
            {
              id: 'turn:1',
              threadId: 'thread:T1',
              capturedAt: '2026-05-12T00:00:00.000Z',
              score: 0.95,
              title: 'Pro-Questions - Copy Fail',
              threadUrl: 'https://chatgpt.com/c/abc',
            },
          ],
        };
      }
      return { ok: true, items: [] };
    });
    const { result } = renderHook(() => useRecallSearch('copy fail', { debounceMs: 100 }));
    expect(result.current.loading).toBe(true);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    // Stub responds synchronously inside sendMessage; the effect's
    // setState updates batch into the same tick.
    expect(result.current.loading).toBe(false);
    expect(result.current.items.length).toBe(1);
    expect(result.current.items[0]!.title).toBe('Pro-Questions - Copy Fail');
    expect(result.current.error).toBeNull();
  });

  it('ignores stale responses when the query changes mid-flight', () => {
    let responder = (message: unknown): unknown => {
      const m = message as { q: string };
      return {
        ok: true,
        items: [
          {
            id: `stale:${m.q}`,
            threadId: 'thread:OLD',
            capturedAt: '2026-05-12T00:00:00.000Z',
            score: 0.5,
            title: `STALE for ${m.q}`,
          },
        ],
      };
    };
    stubChrome((m) => responder(m));
    const { result, rerender } = renderHook(({ q }) => useRecallSearch(q, { debounceMs: 100 }), {
      initialProps: { q: 'aaa' },
    });
    rerender({ q: 'bbb' }); // change before the first debounce fires
    responder = (message: unknown): unknown => {
      const m = message as { q: string };
      return {
        ok: true,
        items: [
          {
            id: `fresh:${m.q}`,
            threadId: 'thread:NEW',
            capturedAt: '2026-05-12T00:01:00.000Z',
            score: 0.9,
            title: `FRESH for ${m.q}`,
          },
        ],
      };
    };
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.items[0]?.title).toBe('FRESH for bbb');
  });
});
