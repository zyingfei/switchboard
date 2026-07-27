import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ContentEnrichmentAction,
  type EnrichmentTarget,
} from '../../src/sidepanel/nano/ContentEnrichmentAction';
import { FEATURES_SOURCE_NOTE } from '../../src/sidepanel/nano/enrichmentInput';
import type { EngineAvailability } from '../../src/sidepanel/nano/language';

// DEFECT 3, the visible half — "the button is also ugly", and the "index this
// page first" dead end. The control keeps the action as the label and demotes
// the engine to a subordinate suffix inside the same button; a features-derived
// gist is LABELLED as such; and the index action is offered inline, only when
// nothing at all was available.

const TARGET: EnrichmentTarget = { kind: 'url', canonicalUrl: 'https://example.com/a' };
const FEATURE_BRIEF =
  'Page title: Partition projection tables in Athena\n' +
  'Site: docs.aws.amazon.com\n' +
  'Words in the page address: athena partition projection tables\n' +
  'Extracted page features on file: 42 terms, 8 key phrases, 5 entities. ' +
  "The page's raw text was not stored.";

const availability = (over: Partial<EngineAvailability> = {}): EngineAvailability => ({
  nanoReady: true,
  webGpuLoaded: false,
  webGpuLoading: false,
  webGpuSupported: true,
  ...over,
});

const installNano = (
  reply = 'Athena partition projection tables reduce scan cost. Entities: Athena, partitions.',
): void => {
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

const installEmptyStorage = (): void => {
  const data: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
        set: async (entries: Record<string, unknown>) => {
          Object.assign(data, entries);
        },
        remove: async () => undefined,
      },
    },
  });
};

const renderRow = (props: Partial<React.ComponentProps<typeof ContentEnrichmentAction>> = {}) =>
  render(
    <ContentEnrichmentAction
      target={TARGET}
      port={17_373}
      bridgeKey="k"
      availability={availability()}
      fetchText={async () => ({ text: FEATURE_BRIEF, source: 'features' as const })}
      {...props}
    />,
  );

beforeEach(() => {
  installNano();
  installEmptyStorage();
});

afterEach(() => {
  cleanup();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the enrichment button', () => {
  it('reads as one action with the engine as a subordinate suffix', () => {
    vi.stubGlobal('fetch', okPost());
    renderRow();
    const btn = screen.getByTestId('now-enrich-content-btn');
    // The action leads; the engine name is a separate, smaller element inside
    // the same control (styling is CSS, the SUBORDINATION is structural).
    expect(btn).toHaveTextContent('Enrich content · Nano');
    const label = btn.querySelector('.enrich-run-btn-label');
    const engine = btn.querySelector('.enrich-run-btn-engine');
    expect(label?.textContent).toBe('Enrich content');
    expect(engine?.textContent).toContain('Nano');
    expect(engine).not.toBe(label);
    // A pill in the row's own idiom, not the generic bordered mini-button.
    expect(btn.className).toContain('enrich-run-btn');
    expect(btn.className).not.toContain('cx-mini-btn');
  });

  it('keeps the reason on the disabled control', () => {
    vi.stubGlobal('fetch', okPost());
    renderRow({ availability: availability({ nanoReady: false, webGpuSupported: false }) });
    const btn = screen.getByTestId('now-enrich-content-btn');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title') ?? '').toContain('no built-in AI');
    expect(btn.getAttribute('aria-describedby')).toBe('now-enrich-engine-state');
    // Still says something — a disabled control with no words was the old bug.
    expect(btn.textContent ?? '').not.toBe('');
  });

  it('offers to regenerate once a gist is on screen', async () => {
    vi.stubGlobal('fetch', okPost());
    renderRow();
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-gist')).toBeInTheDocument();
    });
    expect(screen.getByTestId('now-enrich-content-btn')).toHaveTextContent('Regenerate gist');
  });
});

describe('the enrichment row — a thinner input is labelled, never disguised', () => {
  it('generates from page features and says so', async () => {
    vi.stubGlobal('fetch', okPost());
    renderRow();
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('done — gist saved');
    });
    expect(screen.getByTestId('now-enrich-gist-origin')).toHaveTextContent(FEATURES_SOURCE_NOTE);
  });

  it('does NOT label a gist generated from the indexed full text', async () => {
    vi.stubGlobal('fetch', okPost());
    renderRow({
      fetchText: async () => ({
        text: 'The full indexed page text about Athena partition projection, at length. '.repeat(3),
        source: 'indexed' as const,
      }),
    });
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('done — gist saved');
    });
    expect(screen.getByTestId('now-enrich-gist-origin').textContent ?? '').not.toContain(
      'page features',
    );
  });
});

describe('the enrichment row — asking to index is the LAST resort', () => {
  it('offers the index action inline when nothing at all was available', async () => {
    vi.stubGlobal('fetch', okPost());
    const onIndexPage = vi.fn();
    renderRow({ fetchText: async () => ({ text: null, source: 'none' as const }), onIndexPage });
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent(
        'no page text — index this page first',
      );
    });
    const action = screen.getByTestId('now-enrich-index-page');
    expect(action).toHaveTextContent('Index this page');
    fireEvent.click(action);
    expect(onIndexPage).toHaveBeenCalledTimes(1);
  });

  it('never asks a features-only page to index — the run succeeds instead', async () => {
    vi.stubGlobal('fetch', okPost());
    const onIndexPage = vi.fn();
    renderRow({ onIndexPage });
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('done — gist saved');
    });
    expect(screen.queryByTestId('now-enrich-index-page')).toBeNull();
    expect(onIndexPage).not.toHaveBeenCalled();
  });

  it('does not offer to index a chat thread (there is no page to index)', async () => {
    vi.stubGlobal('fetch', okPost());
    renderRow({
      target: { kind: 'thread', bacId: 'bac_thread_42' },
      fetchText: async () => null,
      onIndexPage: vi.fn(),
    });
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent(
        'no captured conversation in this thread yet',
      );
    });
    expect(screen.queryByTestId('now-enrich-index-page')).toBeNull();
  });
});
