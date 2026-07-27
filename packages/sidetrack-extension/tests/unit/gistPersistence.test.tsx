import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ContentEnrichmentAction,
  type EnrichmentTarget,
} from '../../src/sidepanel/nano/ContentEnrichmentAction';
import type { EngineAvailability } from '../../src/sidepanel/nano/language';

// DEFECT 1 — "the gist just show for a few seconds? why?"
//
// The generated gist used to collapse into a subtle "gist saved" marker 8s
// after the run, taking the TEXT with it, and it never came back on a return
// visit. This file reads back the fix from the outside: the gist survives the
// settle timer, it comes back from device storage on mount without generating
// anything, and it follows the focused surface (swaps on a new page, clears
// when that page has none).

const STORE_KEY = 'sidetrack.enrichment.gists.v1';

const TARGET_A: EnrichmentTarget = { kind: 'url', canonicalUrl: 'https://example.com/a' };
const TARGET_B: EnrichmentTarget = { kind: 'url', canonicalUrl: 'https://example.com/b' };
const TARGET_C: EnrichmentTarget = { kind: 'url', canonicalUrl: 'https://example.com/c' };

const LONG_TEXT = 'User: how do I analyze CloudTrail logs across many accounts?\n'.repeat(4);
const GIST = 'CloudTrail stores API activity across accounts. Entities: CloudTrail, S3, Athena.';

const availability = (over: Partial<EngineAvailability> = {}): EngineAvailability => ({
  nanoReady: true,
  webGpuLoaded: false,
  webGpuLoading: false,
  webGpuSupported: true,
  ...over,
});

const installNano = (reply = GIST): void => {
  (globalThis as { LanguageModel?: unknown }).LanguageModel = {
    availability: async () => 'available',
    create: vi.fn(async () => ({ prompt: async () => reply, destroy: vi.fn() })),
  };
};

const okPost = () =>
  vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith('/v1/enrichment/content')
      ? { ok: true, status: 200, json: async () => ({ accepted: 1 }) }
      : { ok: false, status: 404, json: async () => ({}) },
  );

/** chrome.storage.local, in memory — the one area gistStore.ts writes to. */
const installStorage = (seed: Record<string, unknown> = {}) => {
  const data: Record<string, unknown> = { ...seed };
  const area = {
    get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (entries: Record<string, unknown>) => {
      Object.assign(data, entries);
    }),
    remove: vi.fn(async (key: string) => {
      delete data[key];
    }),
  };
  vi.stubGlobal('chrome', { storage: { local: area } });
  return { data, area };
};

const renderRow = (props: Partial<React.ComponentProps<typeof ContentEnrichmentAction>> = {}) =>
  render(
    <ContentEnrichmentAction
      target={TARGET_A}
      port={17_373}
      bridgeKey="k"
      availability={availability()}
      fetchText={async () => LONG_TEXT}
      {...props}
    />,
  );

beforeEach(() => {
  installNano();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('gist persistence — the generated text never auto-hides', () => {
  it('keeps the gist on screen long after the 8s settle timer fires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installStorage();
    vi.stubGlobal('fetch', okPost());
    renderRow();
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('done — gist saved');
    });
    expect(screen.getByTestId('now-enrich-content-gist')).toHaveTextContent('CloudTrail');

    // Well past RESULT_SETTLE_MS (8s). The STATUS line is allowed to settle
    // into its quiet marker; the gist body is not allowed to go anywhere.
    // Flush the passive effect that arms the settle timer, THEN run the clock
    // past it (a single advance would land before the timer even exists).
    await act(async () => undefined);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await waitFor(() => {
      // The settle DID happen — the run report is now the quiet marker.
      expect(screen.getByTestId('now-enrich-content-status').textContent ?? '').not.toContain(
        'done —',
      );
    });
    expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('gist saved');
    // THE REGRESSION: the text is still readable.
    expect(screen.getByTestId('now-enrich-content-gist')).toHaveTextContent('CloudTrail');
    expect(screen.getByTestId('now-enrich-gist-block')).toBeInTheDocument();
  });

  it('is collapsible rather than auto-hiding — more/less keeps the text mounted', async () => {
    installStorage();
    vi.stubGlobal('fetch', okPost());
    renderRow();
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-gist')).toHaveTextContent('CloudTrail');
    });
    const toggle = screen.getByTestId('now-enrich-gist-toggle');
    expect(toggle).toHaveTextContent('more');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByTestId('now-enrich-gist-toggle')).toHaveTextContent('less');
    expect(screen.getByTestId('now-enrich-gist-toggle')).toHaveAttribute('aria-expanded', 'true');
    // Collapsed or expanded, the gist is in the document either way.
    expect(screen.getByTestId('now-enrich-content-gist')).toHaveTextContent('CloudTrail');
  });

  it('writes the gist to device storage so a later visit can show it', async () => {
    const storage = installStorage();
    vi.stubGlobal('fetch', okPost());
    renderRow();
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('done — gist saved');
    });
    await waitFor(() => {
      expect(storage.area.set).toHaveBeenCalled();
    });
    const stored = storage.data[STORE_KEY] as Record<string, { gist: string; engine?: string }>;
    expect(stored['url:https://example.com/a']?.gist).toContain('CloudTrail');
    expect(stored['url:https://example.com/a']?.engine).toBe('Nano');
  });
});

describe('gist persistence — a remembered gist comes back', () => {
  it('renders the stored gist on mount, generating nothing', async () => {
    installStorage({
      [STORE_KEY]: {
        'url:https://example.com/a': {
          gist: 'Remembered gist about partition projection tables.',
          engine: 'WebGPU',
          source: 'indexed',
          savedAt: '2026-07-26T10:00:00.000Z',
        },
      },
    });
    const fetchMock = okPost();
    vi.stubGlobal('fetch', fetchMock);
    const fetchText = vi.fn(async () => LONG_TEXT);
    renderRow({ fetchText });
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-gist')).toHaveTextContent(
        'Remembered gist about partition projection tables.',
      );
    });
    // Nothing was generated to show it: no text fetch, no POST, no run status.
    expect(fetchText).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/v1/enrichment/content'))).toBe(
      false,
    );
    expect(screen.queryByTestId('now-enrich-content-status')).toBeNull();
    // …and it says it is a remembered one, on the engine that made it.
    expect(screen.getByTestId('now-enrich-gist-origin')).toHaveTextContent('saved earlier');
    expect(screen.getByTestId('now-enrich-gist-origin')).toHaveTextContent('WebGPU');
  });

  it('keeps the remembered gist when a regenerate fails — a failure takes nothing away', async () => {
    installStorage({
      [STORE_KEY]: {
        'url:https://example.com/a': {
          gist: 'Remembered gist about partition projection tables.',
          savedAt: '2026-07-26T10:00:00.000Z',
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    renderRow();
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-gist')).toHaveTextContent('Remembered gist');
    });
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('save failed (503)');
    });
    expect(screen.getByTestId('now-enrich-content-gist')).toHaveTextContent('Remembered gist');
  });

  it('swaps the gist when the focused surface changes, and clears it when the new one has none', async () => {
    installStorage({
      [STORE_KEY]: {
        'url:https://example.com/a': { gist: 'Gist for page A.', savedAt: '2026-07-26T10:00:00.000Z' },
        'url:https://example.com/b': { gist: 'Gist for page B.', savedAt: '2026-07-26T11:00:00.000Z' },
      },
    });
    vi.stubGlobal('fetch', okPost());
    const { rerender } = renderRow();
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-gist')).toHaveTextContent('Gist for page A.');
    });
    rerender(
      <ContentEnrichmentAction
        target={TARGET_B}
        port={17_373}
        bridgeKey="k"
        availability={availability()}
        fetchText={async () => LONG_TEXT}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-gist')).toHaveTextContent('Gist for page B.');
    });
    // A surface with no remembered gist shows NO gist — never the last page's.
    rerender(
      <ContentEnrichmentAction
        target={TARGET_C}
        port={17_373}
        bridgeKey="k"
        availability={availability()}
        fetchText={async () => LONG_TEXT}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId('now-enrich-gist-block')).toBeNull();
    });
    expect(screen.queryByTestId('now-enrich-content-gist')).toBeNull();
  });
});
