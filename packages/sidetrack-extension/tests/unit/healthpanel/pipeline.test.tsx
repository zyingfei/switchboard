import { render, screen, waitFor } from '@testing-library/react';
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

describe('HealthPanel pipeline strip', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: mkHealth() }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders all seven pipeline stages with the right status dots', async () => {
    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    const pipeline = await screen.findByTestId('hp-pipeline');
    for (const id of ['capture', 'vault', 'materializers', 'recall', 'topics', 'ranker', 'sync']) {
      expect(pipeline.querySelector(`[data-testid="hp-pipeline-stage-${id}"]`)).not.toBeNull();
    }
  });

  it('shows the topic stage detail when workGraph.topicProducer reports clusters', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          ({
            data: mkHealth({
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
          }),
      })),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-topics');
      expect(stage.className).toContain('is-ok');
      expect(stage.textContent).toContain('4 topics');
      expect(stage.textContent).toContain('2 lineage');
    });
  });

  it('flags the recall stage warn when status=rebuilding', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          ({
            data: mkHealth({
              recall: {
                indexExists: false,
                entryCount: 30,
                modelId: 'Xenova/multilingual-e5-small',
                sizeBytes: null,
                status: 'rebuilding' as const,
                rebuildEmbedded: 30,
                rebuildTotal: 120,
              },
            }),
          }),
      })),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-recall');
      expect(stage.className).toContain('is-warn');
      expect(stage.textContent).toContain('rebuilding 30/120');
    });
  });

  it('shows the ranker snapshot age when workGraph.ranker.loadStatus=ready', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          ({
            data: mkHealth({
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
          }),
      })),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-ranker');
      expect(stage.className).toContain('is-ok');
      expect(stage.textContent).toContain('snapshot');
    });
  });

  it('marks ranker stage warn when loadStatus=missing with a skip reason', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          ({
            data: mkHealth({
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
          }),
      })),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-ranker');
      expect(stage.className).toContain('is-warn');
      expect(stage.textContent).toContain('no-labels');
    });
  });

  it('renders an explicit capture-unavailable state and NOT a zero-count provider row when observability says capture is unavailable', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          ({
            data: mkHealth({
              observability: {
                asOf: '2026-05-15T00:00:00.000Z',
                status: 'degraded' as const,
                sections: { capture: 'unavailable' as const, vault: 'ok' as const },
              },
              // A timed-out collector still leaves lastByProvider
              // present — the panel must NOT synthesize zero rows.
              capture: {
                lastByProvider: { chatgpt: '2026-05-12T20:00:00.000Z' },
                queueDepthHint: null,
                droppedHint: null,
                recentWarnings: [],
              },
            }),
          }),
      })),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      expect(screen.getByTestId('hp-capture-unavailable')).toBeInTheDocument();
    });
    // No synthesized "0 ok / 0 warn / 0 fail" provider row.
    expect(screen.queryByText('seen')).not.toBeInTheDocument();
    // Overall light uses the server-derived status.
    const overall = screen.getByTestId('hp-overall-status');
    expect(overall.textContent).toBe('degraded');
    // Pipeline capture node is the unavailable state, not a 0/idle.
    const stage = screen.getByTestId('hp-pipeline-stage-capture');
    expect(stage.className).toContain('is-unavailable');
    expect(stage.textContent).toContain('unavailable');
    expect(stage.textContent).not.toContain('no captures yet');
  });

  it('shows the labeled training mix and "data changed" when datasetChangedSinceTrain', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          ({
            data: mkHealth({
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
          }),
      })),
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
  });

  it('shows the last-capture title and 1h window on the capture node and provider row', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          ({
            data: mkHealth({
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
          }),
      })),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      expect(screen.getAllByText(/Fixing Focus collapse/).length).toBeGreaterThan(0);
    });
    const stage = screen.getByTestId('hp-pipeline-stage-capture');
    expect(stage.textContent).toContain('6 in 1h');
    // 1h window also surfaces on the last-capture card.
    expect(screen.getAllByText(/6 in 1h/).length).toBeGreaterThan(0);
  });

  it('flags the vault stage err when writable=false', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () =>
          ({
            data: mkHealth({
              vault: { root: '/tmp/vault', writable: false, sizeBytes: null },
            }),
          }),
      })),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-vault');
      expect(stage.className).toContain('is-err');
      expect(stage.textContent).toContain('not writable');
    });
  });
});
