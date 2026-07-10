import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildFocusedRelatedItems,
  useFocusedRelatedPages,
} from '../../src/sidepanel/focusedRelated';
import {
  lookupByEntityId,
  lookupByUrl,
  resetImpressionRegistryForTests,
} from '../../src/sidepanel/recall/impressionRegistry';

// Pure-mapper contract for the Now-card Related strip. The hook around
// it is thin (debounce + cache + bridge message); the correctness
// surface is this mapping: self-suppression incl. slash-variant drift,
// dedupe, label fallback, cap, and garbage tolerance.

const SELF = 'https://example.com/page';

describe('buildFocusedRelatedItems', () => {
  it('maps canonicalUrl + title results to link items', () => {
    const items = buildFocusedRelatedItems(
      [
        { canonicalUrl: 'https://other.com/a', title: 'Other A' },
        { canonicalUrl: 'https://other.com/b', title: 'Other B' },
      ],
      SELF,
    );
    expect(items).toEqual([
      { url: 'https://other.com/a', label: 'Other A' },
      { url: 'https://other.com/b', label: 'Other B' },
    ]);
  });

  it('suppresses the focused url including trailing-slash variants', () => {
    const items = buildFocusedRelatedItems(
      [
        { canonicalUrl: SELF, title: 'Self exact' },
        { canonicalUrl: `${SELF}/`, title: 'Self slash variant' },
        { canonicalUrl: 'https://other.com/a', title: 'Keep me' },
      ],
      SELF,
    );
    expect(items).toEqual([{ url: 'https://other.com/a', label: 'Keep me' }]);
  });

  it('suppresses slash variants when the focused url has the slash', () => {
    const items = buildFocusedRelatedItems(
      [{ canonicalUrl: 'https://openfeature.dev', title: 'Self no slash' }],
      'https://openfeature.dev/',
    );
    expect(items).toEqual([]);
  });

  it('dedupes results that differ only by trailing slash', () => {
    const items = buildFocusedRelatedItems(
      [
        { canonicalUrl: 'https://other.com/a', title: 'First' },
        { canonicalUrl: 'https://other.com/a/', title: 'Duplicate' },
      ],
      SELF,
    );
    expect(items).toEqual([{ url: 'https://other.com/a', label: 'First' }]);
  });

  it('falls back to the url when title is missing or blank', () => {
    const items = buildFocusedRelatedItems(
      [
        { canonicalUrl: 'https://other.com/untitled' },
        { canonicalUrl: 'https://other.com/blank', title: '   ' },
      ],
      SELF,
    );
    expect(items).toEqual([
      { url: 'https://other.com/untitled', label: 'https://other.com/untitled' },
      { url: 'https://other.com/blank', label: 'https://other.com/blank' },
    ]);
  });

  it('caps at max items', () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      canonicalUrl: `https://other.com/${String(i)}`,
      title: `Item ${String(i)}`,
    }));
    expect(buildFocusedRelatedItems(results, SELF, 6)).toHaveLength(6);
    expect(buildFocusedRelatedItems(results, SELF, 3)).toHaveLength(3);
  });

  it('skips malformed rows and non-http urls', () => {
    const items = buildFocusedRelatedItems(
      [
        null,
        42,
        'string-row',
        {},
        { canonicalUrl: 17, title: 'numeric url' },
        { canonicalUrl: 'chrome-extension://abc/page.html', title: 'extension page' },
        { canonicalUrl: 'about:blank', title: 'about' },
        { canonicalUrl: 'https://other.com/ok', title: 'OK' },
      ],
      SELF,
    );
    expect(items).toEqual([{ url: 'https://other.com/ok', label: 'OK' }]);
  });

  it('keeps the SERVED entityId on items when the result carries one (P2)', () => {
    const items = buildFocusedRelatedItems(
      [
        {
          canonicalUrl: 'https://other.com/a',
          title: 'With entity',
          entityId: 'timeline-visit:https://other.com/a',
        },
        { canonicalUrl: 'https://other.com/b', title: 'Without entity' },
      ],
      SELF,
    );
    expect(items).toEqual([
      {
        url: 'https://other.com/a',
        label: 'With entity',
        entityId: 'timeline-visit:https://other.com/a',
      },
      { url: 'https://other.com/b', label: 'Without entity' },
    ]);
  });
});

// Hook-level: the response-parse layer must seed the impression
// registry (fresh responses AND cache hits, so a gesture after a
// panel remount still joins the original recall.served).
describe('useFocusedRelatedPages impression feeding (P2)', () => {
  type SendCb = (response: unknown) => void;
  const stubChrome = (responder: (request: unknown) => unknown): ReturnType<typeof vi.fn> => {
    const send = vi.fn((message: unknown, cb?: SendCb) => {
      cb?.(responder(message));
    });
    globalThis.chrome = {
      runtime: { sendMessage: send, lastError: undefined },
    } as unknown as typeof chrome;
    return send;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetImpressionRegistryForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetImpressionRegistryForTests();
    // @ts-expect-error — restore default
    delete globalThis.chrome;
  });

  // Unique URL per test run: the hook's negative cache is module-level
  // and deliberately survives across renders (and tests).
  const FOCUS_URL = 'https://focus.example/impression-page';

  it('records the full served set under meta.servedContextId, then re-records on cache hits', () => {
    stubChrome(() => ({
      ok: true,
      results: [
        {
          entityId: 'timeline-visit:https://rel.example/a/',
          canonicalUrl: 'https://rel.example/a/',
          title: 'Related A',
        },
        // Self-suppressed from the rendered strip but still part of
        // the impression — must land in the registry regardless.
        {
          entityId: `timeline-visit:${FOCUS_URL}`,
          canonicalUrl: FOCUS_URL,
          title: 'Self',
        },
      ],
      meta: { servedContextId: 'ctx-related-1' },
    }));
    const { unmount } = renderHook(() => useFocusedRelatedPages(FOCUS_URL));
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(lookupByEntityId('timeline-visit:https://rel.example/a/')).toEqual({
      servedContextId: 'ctx-related-1',
      servedEntityId: 'timeline-visit:https://rel.example/a/',
    });
    // Slash-variant URL join + the self-suppressed row.
    expect(lookupByUrl('https://rel.example/a')?.servedContextId).toBe('ctx-related-1');
    expect(lookupByEntityId(`timeline-visit:${FOCUS_URL}`)).not.toBeNull();

    // Remount → module cache serves without a network round-trip; the
    // registry is refreshed against the ORIGINAL servedContextId for
    // the rendered items.
    unmount();
    resetImpressionRegistryForTests();
    const second = renderHook(() => useFocusedRelatedPages(FOCUS_URL));
    expect(second.result.current).toEqual([
      {
        url: 'https://rel.example/a/',
        label: 'Related A',
        entityId: 'timeline-visit:https://rel.example/a/',
      },
    ]);
    expect(lookupByEntityId('timeline-visit:https://rel.example/a/')?.servedContextId).toBe(
      'ctx-related-1',
    );
  });
});
