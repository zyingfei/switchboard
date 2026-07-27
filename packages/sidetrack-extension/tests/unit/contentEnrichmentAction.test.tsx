import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ContentEnrichmentAction,
  type EnrichmentTarget,
} from '../../src/sidepanel/nano/ContentEnrichmentAction';

// Make Nano 'available' so resolveReadyEngine() (called inside the action)
// returns a real nano engine whose prompt we control. The gist prompt returns a
// long enough summary to pass the thin-content gate.
const installNano = (
  reply = 'CloudTrail stores API activity across accounts. Key entities: AWS CloudTrail, S3, cross-account access.',
): void => {
  (globalThis as { LanguageModel?: unknown }).LanguageModel = {
    availability: async () => 'available',
    create: vi.fn(async () => ({ prompt: async () => reply, destroy: vi.fn() })),
  };
};

const LONG_TEXT = 'User: how do I analyze CloudTrail logs across many accounts?\n'.repeat(4);

afterEach(() => {
  cleanup();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  installNano();
});

const enrichPostMock = () =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/v1/enrichment/content')) {
      return { ok: true, status: 200, json: async () => ({ accepted: 1, skipped: 0 }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });

describe('ContentEnrichmentAction', () => {
  it('runs fetching → generating → saving → done, showing the gist, for a URL target (kind url)', async () => {
    const fetchMock = enrichPostMock();
    vi.stubGlobal('fetch', fetchMock);
    const onEnriched = vi.fn();
    const target: EnrichmentTarget = { kind: 'url', canonicalUrl: 'https://example.com/a' };
    render(
      <ContentEnrichmentAction
        target={target}
        port={17_373}
        bridgeKey="k"
        engineReady
        activeEngineLabel="Nano"
        fetchText={async () => LONG_TEXT}
        onEnriched={onEnriched}
      />,
    );
    const btn = screen.getByTestId('now-enrich-content-btn');
    expect(btn).toHaveTextContent('Enrich content · Nano');
    fireEvent.click(btn);
    // Terminal state: done, gist shown, host asked to re-resolve.
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('done — gist saved');
    });
    expect(screen.getByTestId('now-enrich-content-gist')).toHaveTextContent('CloudTrail');
    expect(onEnriched).toHaveBeenCalledTimes(1);

    // POST shape: exactly one POST to /v1/enrichment/content with kind 'url',
    // the canonical URL as id, the bridge key header, and a gist.
    const post = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/v1/enrichment/content'),
    ) as unknown as [string, RequestInit];
    expect(post).toBeDefined();
    expect(post[1].method).toBe('POST');
    expect((post[1].headers as Record<string, string>)['x-bac-bridge-key']).toBe('k');
    const body = JSON.parse(post[1].body as string) as {
      items: readonly { kind: string; id: string; gist: string; model: string }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.kind).toBe('url');
    expect(body.items[0]?.id).toBe('https://example.com/a');
    expect(body.items[0]?.model).toBe('gemini-nano');
    expect(body.items[0]?.gist.length).toBeGreaterThan(0);
  });

  it('POSTs kind thread with the bac id for a chat-thread target', async () => {
    const fetchMock = enrichPostMock();
    vi.stubGlobal('fetch', fetchMock);
    const target: EnrichmentTarget = { kind: 'thread', bacId: 'bac_thread_42' };
    render(
      <ContentEnrichmentAction
        target={target}
        port={17_373}
        bridgeKey="k"
        engineReady
        activeEngineLabel="Nano"
        fetchText={async () => LONG_TEXT}
      />,
    );
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('done — gist saved');
    });
    const post = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/v1/enrichment/content'),
    ) as unknown as [string, RequestInit];
    const body = JSON.parse(post[1].body as string) as {
      items: readonly { kind: string; id: string }[];
    };
    expect(body.items[0]?.kind).toBe('thread');
    expect(body.items[0]?.id).toBe('bac_thread_42');
  });

  it('is disabled with a Health hint when no engine is ready — never generates', async () => {
    const fetchMock = enrichPostMock();
    vi.stubGlobal('fetch', fetchMock);
    const fetchText = vi.fn(async () => LONG_TEXT);
    render(
      <ContentEnrichmentAction
        target={{ kind: 'url', canonicalUrl: 'https://example.com/a' }}
        port={17_373}
        bridgeKey="k"
        engineReady={false}
        activeEngineLabel={null}
        fetchText={fetchText}
      />,
    );
    const btn = screen.getByTestId('now-enrich-content-btn');
    expect(btn).toBeDisabled();
    // The disabled control now carries the SAME reason the row states — a grey
    // button with no explanation was the bug.
    expect(btn).toHaveAttribute(
      'title',
      'No on-device model is loaded. Open Health → Experiments and load the local model.',
    );
    // Clicking a disabled button does nothing — no text fetch, no POST.
    fireEvent.click(btn);
    expect(fetchText).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/v1/enrichment/content')),
    ).toBe(false);
  });

  it('skips (nothing saved) when the model abstains on thin content', async () => {
    const fetchMock = enrichPostMock();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ContentEnrichmentAction
        target={{ kind: 'url', canonicalUrl: 'https://example.com/a' }}
        port={17_373}
        bridgeKey="k"
        engineReady
        activeEngineLabel="Nano"
        // Text below MIN_CONTENT_CHARS → the gist gate returns null → skipped.
        fetchText={async () => 'tiny'}
      />,
    );
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent(
        'content too thin',
      );
    });
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/v1/enrichment/content')),
    ).toBe(false);
  });
});
