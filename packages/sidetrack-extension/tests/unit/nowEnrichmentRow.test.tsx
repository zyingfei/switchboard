import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ContentEnrichmentAction,
  type EnrichmentTarget,
} from '../../src/sidepanel/nano/ContentEnrichmentAction';
import {
  __resetWebGpuEngineForTest,
  loadWebGpuEngine,
  type PipelineFactory,
} from '../../src/sidepanel/nano/engine';
import type { EngineAvailability } from '../../src/sidepanel/nano/language';

// The Now card's on-device AI row. THE BUG IT FIXES: on a browser without
// built-in Nano the "Enrich content" button was permanently grey with no
// explanation — the WebGPU model must be explicitly loaded from Health and
// unloads on every panel reload. So every state here must SAY something, and a
// disabled button must carry the same reason the row states.

const TARGET: EnrichmentTarget = { kind: 'url', canonicalUrl: 'https://example.com/a' };

const EN_TEXT =
  'User: how do I analyze CloudTrail logs across many AWS accounts? The organization trail ' +
  'writes into one central bucket and Athena queries it with a partition projection table.';

// Repeated so it clears MIN_CONTENT_CHARS (80) — Chinese is dense, one
// paragraph is fewer characters than its English equivalent.
const ZH_TEXT =
  '用户：如何在多个账户之间分析云端审计日志？组织级追踪会把事件写入中心化的存储桶，' +
  '然后使用查询引擎按分区投影表进行检索，这样能显著降低扫描成本与查询延迟。'.repeat(3);

// A Chinese gist for the Chinese-routing case.
const ZH_GIST =
  '这篇文档讲述了如何跨多个账户分析审计日志，并使用分区投影表降低扫描成本。' +
  '关键实体：组织级追踪、中心化存储桶、查询引擎。';

const availability = (over: Partial<EngineAvailability> = {}): EngineAvailability => ({
  nanoReady: false,
  webGpuLoaded: false,
  webGpuLoading: false,
  webGpuSupported: true,
  ...over,
});

const installNano = (reply = 'A factual gist about CloudTrail. Entities: CloudTrail, S3, Athena.'): void => {
  (globalThis as { LanguageModel?: unknown }).LanguageModel = {
    availability: async () => 'available',
    create: vi.fn(async () => ({ prompt: async () => reply, destroy: vi.fn() })),
  };
};

const fakePipeline =
  (generated = 'WebGPU gist of the page. Entities: storage, queries.'): PipelineFactory =>
  async () => ({ generate: async () => [{ generated_text: generated }] });

const okPost = () =>
  vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith('/v1/enrichment/content')
      ? { ok: true, status: 200, json: async () => ({ accepted: 1 }) }
      : { ok: false, status: 404, json: async () => ({}) },
  );

const renderRow = (
  props: Partial<React.ComponentProps<typeof ContentEnrichmentAction>> = {},
) =>
  render(
    <ContentEnrichmentAction
      target={TARGET}
      port={17_373}
      bridgeKey="k"
      fetchText={async () => EN_TEXT}
      {...props}
    />,
  );

afterEach(() => {
  cleanup();
  __resetWebGpuEngineForTest();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  __resetWebGpuEngineForTest();
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
});

describe('Now-card enrichment row — every state is stated, never a dead control', () => {
  it('Nano ready: names the engine and enables the action', () => {
    renderRow({ availability: availability({ nanoReady: true }) });
    expect(screen.getByTestId('now-enrich-engine-state')).toHaveTextContent('AI: Nano ready');
    expect(screen.getByTestId('now-enrich-content-btn')).toBeEnabled();
    expect(screen.getByTestId('now-enrich-content-btn')).toHaveTextContent('Enrich content · Nano');
  });

  it('local model loaded: names WebGPU as the engine', () => {
    renderRow({ availability: availability({ webGpuLoaded: true }) });
    expect(screen.getByTestId('now-enrich-engine-state')).toHaveTextContent(
      'AI: local model ready (WebGPU)',
    );
    expect(screen.getByTestId('now-enrich-content-btn')).toBeEnabled();
  });

  it('nothing loaded: states the reason, offers Load in Health, and the disabled button repeats it', () => {
    const onOpenHealth = vi.fn();
    renderRow({ availability: availability(), onOpenHealth });
    expect(screen.getByTestId('now-enrich-engine-state')).toHaveTextContent(
      'AI: model not loaded — Load in Health',
    );
    const btn = screen.getByTestId('now-enrich-content-btn');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toContain('Open Health → Experiments');
    // The disabled control is described by the state line (screen readers get
    // the reason, not just "dimmed").
    expect(btn.getAttribute('aria-describedby')).toBe('now-enrich-engine-state');
    fireEvent.click(screen.getByTestId('now-enrich-open-health'));
    expect(onOpenHealth).toHaveBeenCalledTimes(1);
  });

  it('downloading: shows the live percent, and the row NEVER offers to start a load', () => {
    renderRow({
      availability: availability({ webGpuLoading: true, webGpuPercent: 41 }),
      onOpenHealth: vi.fn(),
    });
    expect(screen.getByTestId('now-enrich-engine-state')).toHaveTextContent('AI: downloading 41%');
    expect(screen.getByTestId('now-enrich-content-btn')).toBeDisabled();
    expect(screen.queryByTestId('now-enrich-open-health')).toBeNull();
  });

  it('no built-in AI and no WebGPU adapter: says unavailable in this browser, with no false action', () => {
    renderRow({
      availability: availability({ webGpuSupported: false }),
      onOpenHealth: vi.fn(),
    });
    expect(screen.getByTestId('now-enrich-engine-state')).toHaveTextContent(
      'AI: unavailable in this browser',
    );
    // Nothing to load here — offering "Load in Health" would be a lie.
    expect(screen.queryByTestId('now-enrich-open-health')).toBeNull();
    expect(screen.getByTestId('now-enrich-content-btn')).toBeDisabled();
  });

  it('Chinese page with only Nano: language-blocked, named as such, with the fix offered', () => {
    const onOpenHealth = vi.fn();
    renderRow({
      availability: availability({ nanoReady: true }),
      contentLanguage: 'zh',
      onOpenHealth,
    });
    expect(screen.getByTestId('now-enrich-engine-state')).toHaveTextContent(
      'AI: Chinese needs the local model',
    );
    const btn = screen.getByTestId('now-enrich-content-btn');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toContain('does not support Chinese');
    expect(screen.getByTestId('now-enrich-open-health')).toBeInTheDocument();
    expect(onOpenHealth).not.toHaveBeenCalled();
  });

  it('before the probe resolves: says it is checking, never flashes a wrong reason', () => {
    renderRow({ onOpenHealth: vi.fn() });
    expect(screen.getByTestId('now-enrich-engine-state')).toHaveTextContent(
      'AI: checking the on-device model…',
    );
    expect(screen.getByTestId('now-enrich-content-btn')).toBeDisabled();
    // No "Load in Health" until we actually know something is missing.
    expect(screen.queryByTestId('now-enrich-open-health')).toBeNull();
  });

  it('no state renders an empty or unexplained control', () => {
    const cases: readonly Partial<EngineAvailability>[] = [
      { nanoReady: true },
      { webGpuLoaded: true },
      {},
      { webGpuLoading: true },
      { webGpuSupported: false },
    ];
    for (const over of cases) {
      const { unmount } = renderRow({
        availability: availability(over),
        contentLanguage: 'en',
        onOpenHealth: vi.fn(),
      });
      expect(screen.getByTestId('now-enrich-engine-state').textContent ?? '').not.toBe('');
      const btn = screen.getByTestId('now-enrich-content-btn');
      expect(btn.textContent ?? '').not.toBe('');
      expect(btn.getAttribute('title') ?? '').not.toBe('');
      unmount();
      cleanup();
    }
    // …and the same for the language-blocked case.
    renderRow({ availability: availability({ nanoReady: true }), contentLanguage: 'zh' });
    expect(screen.getByTestId('now-enrich-engine-state').textContent ?? '').not.toBe('');
    expect(screen.getByTestId('now-enrich-content-btn').getAttribute('title') ?? '').not.toBe('');
  });
});

describe('Now-card enrichment row — a run is legible from start to finish', () => {
  it('shows the live phase with an indeterminate indicator while generating', async () => {
    installNano();
    vi.stubGlobal('fetch', okPost());
    // A holder object, not a bare `let` — TS narrows an assigned-in-executor
    // variable to `never` at the call site.
    const gate: { release: (v: string) => void } = { release: () => undefined };
    const pending = new Promise<string>((resolve) => {
      gate.release = resolve;
    });
    renderRow({
      availability: availability({ nanoReady: true }),
      fetchText: async () => await pending,
    });
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('fetching text…');
    });
    // Indeterminate progress — on-device generation reports no percent.
    const bar = screen.getByTestId('now-enrich-progress');
    expect(bar).toHaveAttribute('role', 'progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByTestId('now-enrich-content-btn')).toBeDisabled();
    gate.release(EN_TEXT);
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('gist saved');
    });
  });

  it('success names the engine and the elapsed time, and keeps the gist', async () => {
    installNano();
    vi.stubGlobal('fetch', okPost());
    const onEnriched = vi.fn();
    renderRow({ availability: availability({ nanoReady: true }), onEnriched });
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent(
        'done — gist saved',
      );
    });
    const status = screen.getByTestId('now-enrich-content-status').textContent ?? '';
    expect(status).toContain('Nano');
    expect(status).toMatch(/\d+\.\d+s/u);
    expect(screen.getByTestId('now-enrich-content-gist')).toHaveTextContent('CloudTrail');
    expect(onEnriched).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('now-enrich-progress')).toBeNull();
  });

  it('Chinese text routes to the loaded WebGPU model — never to Nano', async () => {
    installNano('THIS NANO REPLY MUST NEVER BE SAVED');
    const fetchMock = okPost();
    vi.stubGlobal('fetch', fetchMock);
    // The stubbed model must answer IN CHINESE: validateGeneration() now
    // rejects an English gist for Chinese source outright (wrong-language),
    // so a lazy English fixture here would test the validator, not routing.
    await loadWebGpuEngine({
      port: 17_373,
      pipelineFactory: fakePipeline(ZH_GIST),
    });
    renderRow({
      availability: availability({ nanoReady: true, webGpuLoaded: true }),
      contentLanguage: 'zh',
      fetchText: async () => ZH_TEXT,
    });
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('gist saved');
    });
    expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('WebGPU');
    const post = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/v1/enrichment/content'),
    ) as unknown as [string, RequestInit];
    const body = JSON.parse(post[1].body as string) as {
      items: readonly { gist: string; model: string }[];
    };
    expect(body.items[0]?.model).toBe('gemma-3-1b-it');
    expect(body.items[0]?.gist).not.toContain('NEVER BE SAVED');
  });

  it('failure: thin content is reported as thin, nothing is saved', async () => {
    installNano();
    const fetchMock = okPost();
    vi.stubGlobal('fetch', fetchMock);
    renderRow({
      availability: availability({ nanoReady: true }),
      fetchText: async () => 'tiny',
    });
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

  it('failure: no obtainable text names the real fix (index the page)', async () => {
    installNano();
    vi.stubGlobal('fetch', okPost());
    renderRow({
      availability: availability({ nanoReady: true }),
      fetchText: async () => null,
    });
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent(
        'no page text — index this page first',
      );
    });
  });

  it('failure: a save rejection shows the status code, not a silent nothing', async () => {
    installNano();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    renderRow({ availability: availability({ nanoReady: true }) });
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent(
        'save failed (503)',
      );
    });
  });

  it('failure: an engine throw is reported as a model error', async () => {
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: async () => 'available',
      create: vi.fn(async () => ({
        prompt: async () => {
          throw new Error('kaboom');
        },
        destroy: vi.fn(),
      })),
    };
    vi.stubGlobal('fetch', okPost());
    renderRow({ availability: availability({ nanoReady: true }) });
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('model error');
    });
  });

  it('failure: a run superseded by a page change reports cancelled, and does not save', async () => {
    installNano();
    const fetchMock = okPost();
    vi.stubGlobal('fetch', fetchMock);
    // A holder object, not a bare `let` — TS narrows an assigned-in-executor
    // variable to `never` at the call site.
    const gate: { release: (v: string) => void } = { release: () => undefined };
    const pending = new Promise<string>((resolve) => {
      gate.release = resolve;
    });
    const { rerender } = render(
      <ContentEnrichmentAction
        target={TARGET}
        port={17_373}
        bridgeKey="k"
        availability={availability({ nanoReady: true })}
        fetchText={async () => await pending}
      />,
    );
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent('fetching text…');
    });
    rerender(
      <ContentEnrichmentAction
        target={{ kind: 'url', canonicalUrl: 'https://example.com/b' }}
        port={17_373}
        bridgeKey="k"
        availability={availability({ nanoReady: true })}
        fetchText={async () => await pending}
      />,
    );
    gate.release(EN_TEXT);
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent(
        'cancelled — the page changed',
      );
    });
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).endsWith('/v1/enrichment/content')),
    ).toBe(false);
  });

  it('a run that starts with nothing loaded ends with the typed reason, not silence', async () => {
    // Availability said "ready" (a stale snapshot) but nothing is actually
    // loaded — the run re-routes against reality and must still terminate in a
    // stated reason rather than failing silently.
    vi.stubGlobal('fetch', okPost());
    renderRow({ availability: availability({ nanoReady: true }) });
    fireEvent.click(screen.getByTestId('now-enrich-content-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('now-enrich-content-status')).toHaveTextContent(
        'no on-device model in this browser',
      );
    });
  });
});
