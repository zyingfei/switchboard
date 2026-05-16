import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HealthPanel } from '../../../entrypoints/sidepanel/components/HealthPanel';

const mkHealth = (overrides: Record<string, unknown> = {}) => ({
  uptimeSec: 12,
  vault: { root: '/tmp/vault', writable: true, sizeBytes: 12_345 },
  capture: {
    lastByProvider: { chatgpt: '2026-05-12T20:00:00.000Z' },
    queueDepthHint: 3,
    droppedHint: 0,
    providers: [
      {
        provider: 'chatgpt',
        lastCaptureAt: '2026-05-12T20:00:00.000Z',
        lastStatus: 'ok' as const,
        ok24h: 5,
        warn24h: 0,
        fail24h: 0,
      },
    ],
    recentWarnings: [],
  },
  recall: {
    indexExists: true,
    entryCount: 120,
    modelId: 'Xenova/multilingual-e5-small',
    sizeBytes: 50_000,
    status: 'ready' as const,
  },
  service: { installed: true, running: true },
  ...overrides,
});

// The component now issues three GETs — /v1/system/health,
// /v1/system/focus-health, /v1/system/hygiene-status — plus a POST to
// /v1/connections/ranker/retrain on "Force retrain". This helper routes
// by URL so a test can stub the health body and let the two best-effort
// drill-down fetches resolve to honest "no data" (so drills render the
// unavailable state rather than fabricating values).
const stubFetch = (
  healthData: unknown,
  opts: {
    focus?: unknown;
    hygiene?: unknown;
    retrain?: unknown;
  } = {},
) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/v1/system/focus-health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: opts.focus ?? {
              availability: 'unavailable',
              asOf: null,
              digest: null,
              history: [],
            },
          }),
        };
      }
      if (url.includes('/v1/system/hygiene-status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: opts.hygiene ?? {
              asOf: null,
              availability: { gc: 'unavailable', pageContent: 'unavailable' },
              gc: null,
              pageContent: null,
            },
          }),
        };
      }
      if (url.includes('/v1/connections/ranker/retrain')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: opts.retrain ?? { status: 'skipped', reason: 'unchanged' } }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: healthData }) };
    }),
  );
};

describe('HealthPanel pipeline strip', () => {
  beforeEach(() => {
    stubFetch(mkHealth());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders all seven pipeline stages', async () => {
    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    const pipeline = await screen.findByTestId('hp-pipeline');
    for (const id of ['capture', 'vault', 'materializers', 'recall', 'topics', 'ranker', 'sync']) {
      expect(pipeline.querySelector(`[data-testid="hp-pipeline-stage-${id}"]`)).not.toBeNull();
    }
  });

  it('shows the topic stage detail when workGraph.topicProducer reports clusters', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        workGraph: {
          ranker: {
            activeRevisionId: null,
            loadStatus: 'missing' as const,
            trainedAt: null,
            retrainSkipReason: null,
            retrainNewLabelCount: 0,
          },
          topicProducer: {
            activeRevisionId: 'rev_topic_42',
            algorithmVersion: 'topic-revision:v1:union-find',
            topicCount: 4,
            lineageCount: 2,
          },
        },
      }),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-topics');
      // Healthy topic node carries no warn/alarm/unavail variant class.
      expect(stage.className).not.toContain('warn');
      expect(stage.className).not.toContain('alarm');
      expect(stage.textContent).toContain('4 topics');
      expect(stage.textContent).toContain('2 lineage');
    });
  });

  it('flags the recall stage warn and surfaces the rebuild phase when status=rebuilding', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        recall: {
          indexExists: false,
          entryCount: 30,
          modelId: 'Xenova/multilingual-e5-small',
          sizeBytes: null,
          status: 'rebuilding' as const,
          rebuildEmbedded: 30,
          rebuildTotal: 120,
          rebuildPhase: 'embedding',
        },
      }),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-recall');
      expect(stage.className).toContain('warn');
      expect(stage.textContent).toContain('rebuilding [embedding] 30/120');
    });

    // Embedding drill shows the rebuild phase explicitly.
    fireEvent.click(screen.getByTestId('hp-pipeline-stage-recall'));
    await waitFor(() => {
      expect(screen.getAllByText(/embedding/).length).toBeGreaterThan(0);
      expect(screen.getByText(/30\/120 embedded/)).toBeInTheDocument();
    });
  });

  it('shows the ranker snapshot age when workGraph.ranker.loadStatus=ready', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        workGraph: {
          ranker: {
            activeRevisionId: 'rev_42',
            loadStatus: 'ready' as const,
            trainedAt: Date.now() - 60 * 60_000,
            retrainSkipReason: null,
            retrainNewLabelCount: 0,
          },
        },
      }),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-ranker');
      expect(stage.className).not.toContain('alarm');
      expect(stage.className).not.toContain('warn');
      expect(stage.textContent).toContain('snapshot');
    });
  });

  it('marks ranker stage warn when loadStatus=missing with a skip reason', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        workGraph: {
          ranker: {
            activeRevisionId: null,
            loadStatus: 'missing' as const,
            trainedAt: null,
            retrainSkipReason: 'no-labels',
            retrainNewLabelCount: 0,
          },
        },
      }),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-ranker');
      expect(stage.className).toContain('warn');
      expect(stage.textContent).toContain('no-labels');
    });
  });

  it('renders an explicit capture-unavailable state and NOT a zero-count provider row when observability says capture is unavailable', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        observability: {
          asOf: '2026-05-15T00:00:00.000Z',
          status: 'degraded' as const,
          sections: { capture: 'unavailable' as const, vault: 'ok' as const },
        },
        // A timed-out collector still leaves lastByProvider present —
        // the panel must NOT synthesize zero rows.
        capture: {
          lastByProvider: { chatgpt: '2026-05-12T20:00:00.000Z' },
          queueDepthHint: null,
          droppedHint: null,
          recentWarnings: [],
        },
      }),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    // Pipeline capture node is the unavailable state, not a 0/idle.
    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-capture');
      expect(stage.className).toContain('unavail');
      expect(stage.textContent).toContain('unavailable');
      expect(stage.textContent).not.toContain('no captures yet');
    });

    // Overall light uses the server-derived status (degraded → warn pill).
    const overall = screen.getByTestId('hp-overall-status');
    expect(overall.className).toContain('warn');
    expect(overall.textContent).toContain('Degraded');

    // Drill into the capture node — explicit unavailable callout, and
    // no synthesized "seen" provider-status row.
    fireEvent.click(screen.getByTestId('hp-pipeline-stage-capture'));
    await waitFor(() => {
      expect(screen.getByTestId('hp-capture-unavailable')).toBeInTheDocument();
    });
    expect(screen.queryByText('seen')).not.toBeInTheDocument();
  });

  it('shows the labeled training mix and "data changed" on the ranker node + drill', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        workGraph: {
          ranker: {
            activeRevisionId: 'rev_42',
            loadStatus: 'ready' as const,
            trainedAt: Date.now() - 2 * 60 * 60_000,
            retrainSkipReason: 'cooldown-active',
            retrainNewLabelCount: 7,
            trainingMix: {
              positivesAtTrain: 18,
              userFeedbackNegativesAtTrain: 0,
              trainingNegatives: null,
            },
            datasetChangedSinceTrain: true,
          },
          topicProducer: {
            activeRevisionId: 'rev_topic_42',
            algorithmVersion: 'topic-revision:shadow:idf-rkn-split',
            topicCount: 4,
            lineageCount: 2,
          },
        },
      }),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-ranker');
      // Labeled triple — positives / user-feedback negatives /
      // training negatives (null → "unknown", never 0).
      expect(stage.textContent).toContain('+18');
      expect(stage.textContent).toContain('uf-0');
      expect(stage.textContent).toContain('neg-unknown');
      expect(stage.textContent).not.toContain('neg-0');
      // Behind-model surfaced with the skip reason explaining why.
      expect(stage.textContent).toContain('data changed since train');
      expect(stage.textContent).toContain('cooldown-active');
    });

    // Topics node uses algorithmVersion as the authoritative label.
    const topics = screen.getByTestId('hp-pipeline-stage-topics');
    expect(topics.textContent).toContain('topic-revision:shadow:idf-rkn-split');

    // Ranker drill — the three labeled tiles + dataset-changed callout,
    // and trainingNegatives null renders "unknown", never 0.
    fireEvent.click(screen.getByTestId('hp-pipeline-stage-ranker'));
    await waitFor(() => {
      expect(screen.getByText('User-feedback neg')).toBeInTheDocument();
      expect(screen.getByText('unknown')).toBeInTheDocument();
      expect(screen.getByText(/the active model is behind/)).toBeInTheDocument();
    });
  });

  it('shows the last-capture title and 1h window on the capture node and drill table', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        capture: {
          lastByProvider: { chatgpt: '2026-05-12T20:00:00.000Z' },
          queueDepthHint: 1,
          droppedHint: 0,
          providers: [
            {
              provider: 'chatgpt',
              lastCaptureAt: '2026-05-12T20:00:00.000Z',
              lastStatus: 'ok' as const,
              ok24h: 5,
              warn24h: 0,
              fail24h: 0,
              lastCaptureTitle: 'Fixing Focus collapse',
              lastCaptureThreadId: 'bac_thread_9',
            },
          ],
          recentWarnings: [],
          window1h: { captures: 6, warnings: 1, fails: 0 },
        },
      }),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-capture');
      expect(stage.textContent).toContain('6 in 1h');
    });

    // Capture drill carries the lastCaptureTitle in the provider table.
    fireEvent.click(screen.getByTestId('hp-pipeline-stage-capture'));
    await waitFor(() => {
      expect(screen.getByText(/Fixing Focus collapse/)).toBeInTheDocument();
    });
    // 1h window also surfaces on the capture drill tiles.
    expect(screen.getByText('Captures · 1h')).toBeInTheDocument();
  });

  it('flags the vault stage err when writable=false', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        vault: { root: '/tmp/vault', writable: false, sizeBytes: null },
      }),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-vault');
      expect(stage.className).toContain('alarm');
      expect(stage.textContent).toContain('not writable');
    });
  });

  it('summarizes recall activity as an honest rate header in the Embedding drill', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        recall: {
          indexExists: true,
          entryCount: 120,
          modelId: 'Xenova/multilingual-e5-small',
          sizeBytes: 50_000,
          status: 'ready' as const,
          activity: {
            lastIndexedAt: '2026-05-12T20:00:00.000Z',
            lastIndexedCount: 3,
            lastIndexedThreadIds: [],
            lastRecallQueryAt: null,
            lastRecallQueryResultCount: null,
            lastSuggestionAt: null,
            lastSuggestionThreadId: null,
            recent: [
              {
                kind: 'query' as const,
                at: '2026-05-12T20:00:00.000Z',
                resultCount: 0,
                queryLength: 12,
              },
              {
                kind: 'query' as const,
                at: '2026-05-12T19:00:00.000Z',
                resultCount: 2,
                queryLength: 8,
              },
            ],
          },
        },
      }),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      expect(screen.getByTestId('hp-pipeline-stage-recall')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('hp-pipeline-stage-recall'));
    await waitFor(() => {
      // Rate header: N events this run + honest zero-result framing.
      expect(screen.getByText(/2 recall events this run/)).toBeInTheDocument();
      expect(screen.getByText(/1\/2 zero-result \(expected/)).toBeInTheDocument();
    });
  });
});
