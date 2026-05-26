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

  it('sends a recallV2Query request with intent=search', () => {
    const send = vi.fn((_msg: unknown, cb?: SendCb) =>
      cb?.({ ok: true, results: [] }),
    );
    globalThis.chrome = {
      runtime: { sendMessage: send, lastError: undefined },
    } as unknown as typeof chrome;
    renderHook(() => useRecallSearch('hello world', { debounceMs: 100 }));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(send).toHaveBeenCalled();
    const message = send.mock.calls[0]![0] as {
      readonly type: string;
      readonly req: { readonly q: string; readonly intent: string; readonly limit: number };
    };
    expect(message.type).toBe('sidetrack.recall.v2.query');
    expect(message.req.intent).toBe('search');
    expect(message.req.q).toBe('hello world');
    expect(message.req.limit).toBe(12);
  });

  it('debounces + maps v2 RecallCandidate responses into RecallHits', () => {
    stubChrome((message) => {
      const m = message as { req: { q: string } };
      if (m.req.q === 'copy fail') {
        return {
          ok: true,
          results: [
            {
              candidateId: 'cand:T1',
              entityId: 'entity:T1',
              sourceKind: 'chat_turn',
              threadId: 'thread:T1',
              title: 'Pro-Questions - Copy Fail',
              snippet: 'matched body chunk…',
              canonicalUrl: 'https://chatgpt.com/c/abc',
              fusedScore: 0.95,
              lastSeenAt: '2026-05-12T00:00:00.000Z',
              evidence: [{ retriever: 'fts5', sourceKind: 'chat_turn', rank: 1 }],
            },
          ],
        };
      }
      return { ok: true, results: [] };
    });
    const { result } = renderHook(() => useRecallSearch('copy fail', { debounceMs: 100 }));
    expect(result.current.loading).toBe(true);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.items.length).toBe(1);
    const hit = result.current.items[0]!;
    expect(hit.title).toBe('Pro-Questions - Copy Fail');
    expect(hit.threadId).toBe('thread:T1');
    expect(hit.canonicalUrl).toBe('https://chatgpt.com/c/abc');
    expect(hit.sourceKind).toBe('chat-turn');
    expect(hit.score).toBe(0.95);
    expect(result.current.error).toBeNull();
  });

  it('ignores stale responses when the query changes mid-flight', () => {
    let responder = (message: unknown): unknown => {
      const m = message as { req: { q: string } };
      return {
        ok: true,
        results: [
          {
            candidateId: `stale:${m.req.q}`,
            entityId: `stale:${m.req.q}`,
            sourceKind: 'chat_turn',
            threadId: 'thread:OLD',
            fusedScore: 0.5,
            title: `STALE for ${m.req.q}`,
            lastSeenAt: '2026-05-12T00:00:00.000Z',
            evidence: [],
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
      const m = message as { req: { q: string } };
      return {
        ok: true,
        results: [
          {
            candidateId: `fresh:${m.req.q}`,
            entityId: `fresh:${m.req.q}`,
            sourceKind: 'chat_turn',
            threadId: 'thread:NEW',
            fusedScore: 0.9,
            title: `FRESH for ${m.req.q}`,
            lastSeenAt: '2026-05-12T00:01:00.000Z',
            evidence: [],
          },
        ],
      };
    };
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.items[0]?.title).toBe('FRESH for bbb');
  });

  it('reports the error string when the v2 response is not ok', () => {
    stubChrome(() => ({ ok: false, error: 'companion unreachable' }));
    const { result } = renderHook(() => useRecallSearch('whatever', { debounceMs: 100 }));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.items.length).toBe(0);
    expect(result.current.error).toBe('companion unreachable');
  });

  it('treats null response as a clean empty (SW short-circuited)', () => {
    stubChrome(() => null);
    const { result } = renderHook(() => useRecallSearch('whatever', { debounceMs: 100 }));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.items.length).toBe(0);
    expect(result.current.error).toBeNull();
    expect(result.current.localFallback).toBe(false);
  });

  it('surfaces meta.flags.localFallback so the UI can warn "local results only"', () => {
    stubChrome(() => ({
      ok: true,
      results: [
        {
          candidateId: 'local:0',
          entityId: 'local:0',
          sourceKind: 'timeline_visit',
          canonicalUrl: 'https://example.com/cached',
          title: 'Cached page',
          fusedScore: 0.5,
          lastSeenAt: '2026-05-20T00:00:00.000Z',
          evidence: [{ retriever: 'fts5-local', sourceKind: 'timeline_visit' }],
        },
      ],
      meta: { flags: { localFallback: true } },
    }));
    const { result } = renderHook(() => useRecallSearch('cached', { debounceMs: 100 }));
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(result.current.items.length).toBe(1);
    expect(result.current.localFallback).toBe(true);
  });
});
