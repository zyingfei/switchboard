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

  it('renders all eight pipeline stages', async () => {
    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    const pipeline = await screen.findByTestId('hp-pipeline');
    for (const id of [
      'capture',
      'vault',
      'materializers',
      'recall',
      'topics',
      'ranker',
      'experiments',
      'sync',
    ]) {
      expect(pipeline.querySelector(`[data-testid="hp-pipeline-stage-${id}"]`)).not.toBeNull();
    }
  });

  it('renders candidate lanes in the Experiments drill + the served-producer banner', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        workGraph: {
          ranker: {
            activeRevisionId: 'ranker-rev',
            loadStatus: 'ready' as const,
            trainedAt: Date.now() - 60_000,
            retrainSkipReason: null,
            retrainNewLabelCount: 0,
          },
          topicProducer: {
            activeRevisionId: 'topic-active',
            algorithmVersion: 'topic-revision:shadow:idf-rkn-split',
            topicCount: 4,
            lineageCount: 1,
          },
          candidates: [
            {
              id: 'topic.active-producer',
              family: 'topic',
              lane: 'active',
              servingImpact: 'serving',
              status: 'ok',
              reason: null,
              revisionId: 'topic-active',
              asOf: '2026-05-12T20:00:00.000Z',
              metrics: { topicCount: 4, lineageCount: 1 },
            },
            {
              id: 'topic.hdbscan-standby',
              family: 'topic',
              lane: 'standby',
              servingImpact: 'not-serving',
              status: 'off',
              reason: 'no-production-selector',
              revisionId: null,
              asOf: '2026-05-12T20:00:00.000Z',
              metrics: { algorithmVersion: 'topic-revision:v2:hdbscan' },
            },
            {
              id: 'topic.shadow-idf-rkn-split',
              family: 'topic',
              lane: 'shadow',
              servingImpact: 'observe-only',
              status: 'warning',
              reason: 'shadow-collapse-boundary-changed',
              revisionId: 'shadow-rev',
              asOf: '2026-05-12T20:00:00.000Z',
              metrics: {
                shadowTopicCount: 3,
                shadowMaxTopicShare: 0.42,
                noiseShare: 0.12,
                adjacentPerVisitChurn: 0.33,
              },
            },
            {
              id: 'diagnostic.drift-sidecar',
              family: 'similarity',
              lane: 'diagnostic',
              servingImpact: 'observe-only',
              status: 'warning',
              reason: 'drift-warning',
              revisionId: 'topic-active',
              asOf: '2026-05-12T20:00:00.000Z',
              metrics: { driftStatus: 'warning', trippedSignalCount: 0, warningSignalCount: 1 },
            },
            {
              id: 'content-lane.dirty-source-queue',
              family: 'content-lane',
              lane: 'standby',
              servingImpact: 'not-serving',
              status: 'pending',
              reason: 'dirty-source-pending',
              revisionId: null,
              asOf: '2026-05-12T20:00:00.000Z',
              metrics: {
                dirtySourceCount: 2,
                tombstonedSourceCount: 1,
                oldestDirtySourceAgeMs: null,
              },
            },
          ],
        },
      }),
      {
        focus: {
          availability: 'ok',
          asOf: '2026-05-12T20:00:00.000Z',
          digest: null,
          history: [
            {
              at: '2026-05-12T20:00:00.000Z',
              adjacentPerVisitChurn: 0.33,
              shadowMaxTopicShare: 0.42,
              noiseShare: 0.12,
              shadowTopicCount: 3,
            },
          ],
        },
      },
    );

    const { container } = render(
      <HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />,
    );

    await waitFor(() => {
      const stage = screen.getByTestId('hp-pipeline-stage-experiments');
      expect(stage.className).toContain('warn');
      expect(stage.textContent).toContain('1 shadow');
      expect(stage.textContent).toContain('2 standby');
    });

    fireEvent.click(screen.getByTestId('hp-pipeline-stage-experiments'));
    await waitFor(() => {
      expect(screen.getByTestId('hp-experiments-table')).toBeInTheDocument();
      expect(screen.getByText('topic.hdbscan-standby')).toBeInTheDocument();
      expect(screen.getByText('disabled')).toBeInTheDocument();
      expect(screen.getAllByText('observe-only').length).toBeGreaterThan(0);
      expect(screen.getByText('dirty-source-pending')).toBeInTheDocument();
      expect(screen.getByText(/oldest no signal yet/)).toBeInTheDocument();
    });
    // W3 — post-W2 there is ONE served producer (no A/B). The
    // always-visible banner shows the served clustering truthfully
    // from workGraph.topicProducer (here the fixture's idf-rkn-split).
    const served = screen.getByTestId('hp-served-topics');
    expect(served).toBeInTheDocument();
    expect(served.textContent).toMatch(/Served topic clustering/);
    expect(served.textContent).toMatch(/idf-rkn-split/);
  });

  it('routes diagnostic candidate warnings to amber alarms, not red signals', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        workGraph: {
          ranker: {
            activeRevisionId: 'ranker-rev',
            loadStatus: 'ready' as const,
            trainedAt: Date.now() - 60_000,
            retrainSkipReason: null,
            retrainNewLabelCount: 0,
          },
          topicProducer: {
            activeRevisionId: 'topic-active',
            algorithmVersion: 'topic-revision:v1:union-find',
            topicCount: 2,
            lineageCount: 0,
          },
          candidates: [
            {
              id: 'diagnostic.drift-sidecar',
              family: 'similarity',
              lane: 'diagnostic',
              servingImpact: 'observe-only',
              status: 'warning',
              reason: 'drift-warning',
              revisionId: 'topic-active',
              asOf: '2026-05-12T20:00:00.000Z',
              metrics: { driftStatus: 'warning', trippedSignalCount: 0, warningSignalCount: 1 },
            },
          ],
        },
      }),
    );

    const { container } = render(
      <HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('hp-pipeline-stage-experiments').className).toContain('warn');
      expect(screen.getByText(/diagnostic\.drift-sidecar/)).toBeInTheDocument();
    });
    expect(container.querySelector('.sx-alarm.amber')).not.toBeNull();
    expect(container.querySelector('.sx-alarm.signal')).toBeNull();
  });

  it('routes invalid active ranker model alarms to red even when not serving', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        workGraph: {
          ranker: {
            activeRevisionId: 'ranker-rev',
            loadStatus: 'ready' as const,
            trainedAt: Date.now() - 60_000,
            retrainSkipReason: null,
            retrainNewLabelCount: 0,
          },
          topicProducer: {
            activeRevisionId: 'topic-active',
            algorithmVersion: 'topic-revision:v1:union-find',
            topicCount: 2,
            lineageCount: 0,
          },
          candidates: [
            {
              id: 'ranker.active-model',
              family: 'ranker',
              lane: 'active',
              servingImpact: 'not-serving',
              status: 'alarm',
              reason: 'invalid-active-model',
              revisionId: 'ranker-rev',
              asOf: '2026-05-12T20:00:00.000Z',
              metrics: { loadStatus: 'invalid-model' },
            },
          ],
        },
      }),
    );

    const { container } = render(
      <HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('hp-pipeline-stage-experiments').className).toContain('alarm');
      expect(screen.getByText(/ranker\.active-model/)).toBeInTheDocument();
    });
    expect(container.querySelector('.sx-alarm.signal')).not.toBeNull();
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
      expect(stage.textContent).toContain('18 pos');
      expect(stage.textContent).toContain('0 user-neg');
      expect(stage.textContent).toContain('unknown synth-neg');
      expect(stage.textContent).not.toContain('0 synth-neg');
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

  it('surfaces methodologySpine ship-gate fail + augmentation status in the Ranker drill', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        workGraph: {
          ranker: {
            activeRevisionId: 'rev_42',
            loadStatus: 'ready' as const,
            trainedAt: Date.now() - 60_000,
            retrainSkipReason: 'below-threshold',
            retrainNewLabelCount: 0,
            activeModelVersion: 'lightgbm-lambdamart-v4',
            expectedModelVersion: 'lightgbm-lambdamart-v4',
            activeFeatureSchemaVersion: 4,
            expectedFeatureSchemaVersion: 4,
            needsRetrain: false,
            methodologySpine: {
              servingGateEnforced: false,
              shipGate: {
                status: 'fail' as const,
                candidate: 'lightgbm-lambdamart-v4',
                reason: 'active-model-does-not-beat-comparison-baseline',
              },
            },
            augmentation: {
              status: 'skipped' as const,
              reason: 'scopedTimelineDelta',
              activeRevisionId: null,
              activeModelVersion: null,
              expectedModelVersion: 'lightgbm-lambdamart-v4',
              needsRetrain: false,
              modelFreshness: 'unknown' as const,
              closestVisitEdgeCount: 3322,
              rankerSourceEdgeCount: 3322,
              asOf: '2026-05-26T10:22:27.318Z',
            },
          },
          topicProducer: {
            activeRevisionId: 'topic-rev',
            algorithmVersion: 'topic-revision:v3:leiden-cpm',
            topicCount: 87,
            lineageCount: 90,
          },
        },
      }),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      expect(screen.getByTestId('hp-pipeline-stage-ranker')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('hp-pipeline-stage-ranker'));

    await waitFor(() => {
      // Ship-gate fail callout — visible warning, not buried in a receipt row.
      const gate = screen.getByTestId('hp-ranker-shipgate-fail');
      expect(gate.textContent).toMatch(/Ship gate · fail/);
      expect(gate.textContent).toMatch(/active-model-does-not-beat-comparison-baseline/);
      expect(gate.textContent).toMatch(/lightgbm-lambdamart-v4/);
    });

    // Augmentation receipt — closest-visit ranker edge counts, status, reason.
    const aug = screen.getByTestId('hp-ranker-augmentation');
    expect(aug.textContent).toMatch(/Skipped/);
    expect(aug.textContent).toMatch(/scopedTimelineDelta/);
    expect(aug.textContent).toMatch(/3322 \/ 3322/);
  });

  it('surfaces next-retrain progress + online-head status in the Ranker drill', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        workGraph: {
          ranker: {
            activeRevisionId: 'rev_online',
            loadStatus: 'ready' as const,
            trainedAt: Date.now() - 26 * 24 * 60 * 60_000,
            retrainSkipReason: 'insufficient_groups',
            retrainNewLabelCount: 3,
            // Neither gate met → blocked; meters show progress toward each.
            nextRetrain: {
              eligible: false,
              positiveGroups: { current: 16, required: 50 },
              newLabels: { current: 3, required: 5 },
              cooldownMs: 600_000,
            },
            // Online head live: enabled + present + base matches active.
            onlineHead: {
              enabled: true,
              present: true,
              inUse: true,
              baseRevisionId: 'rev_online',
              updateCount: 5,
              activeWeightCount: 4,
              updatedAtMs: Date.now() - 30_000,
            },
          },
          topicProducer: {
            activeRevisionId: 'topic-rev',
            algorithmVersion: 'topic-revision:v3:leiden-cpm',
            topicCount: 87,
            lineageCount: 90,
          },
        },
      }),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      expect(screen.getByTestId('hp-pipeline-stage-ranker')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('hp-pipeline-stage-ranker'));

    await waitFor(() => {
      // Next-retrain card — blocked, with both gate meters + binding reason.
      const next = screen.getByTestId('hp-ranker-next-retrain');
      expect(next.textContent).toMatch(/Retrain blocked/);
      expect(next.textContent).toMatch(/16 \/ 50/); // impression-groups meter
      expect(next.textContent).toMatch(/3 \/ 5/); // new-labels meter
      expect(next.textContent).toMatch(/insufficient_groups/);
    });

    // Online-head card — live, blending, nudge count, base revision.
    const online = screen.getByTestId('hp-ranker-online-head');
    expect(online.textContent).toMatch(/Live/);
    expect(online.textContent).toMatch(/blending into serving/);
    expect(online.textContent).toMatch(/5/);
    expect(online.textContent).toMatch(/rev_online/);
  });

  it('does not crash when shipGate.reason or augmentation.reason are null (live server emits null, not undefined)', async () => {
    // Live CfT crash report: Cannot read properties of null (reading
    // 'length'). The earlier `!== undefined && X.length > 0` guards
    // missed null. The server returns null (not undefined) for
    // unpopulated string IDs, so a fail-status shipGate with a null
    // reason crashed the entire panel render. Cover with explicit
    // null fixtures.
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        workGraph: {
          ranker: {
            activeRevisionId: 'rev_42',
            loadStatus: 'ready' as const,
            trainedAt: Date.now() - 60_000,
            retrainSkipReason: null,
            retrainNewLabelCount: 0,
            methodologySpine: {
              shipGate: {
                status: 'fail' as const,
                // Explicit null — earlier guards crashed here.
                reason: null as unknown as string,
              },
            },
            augmentation: {
              status: 'skipped' as const,
              // Explicit null — same shape on the augmentation path.
              reason: null as unknown as string,
              activeRevisionId: null,
              activeModelVersion: null,
              expectedModelVersion: 'lightgbm-lambdamart-v4',
              needsRetrain: false,
              modelFreshness: 'unknown' as const,
              closestVisitEdgeCount: 0,
              rankerSourceEdgeCount: 0,
              asOf: null,
            },
          },
          topicProducer: {
            activeRevisionId: 'topic-rev',
            algorithmVersion: 'topic-revision:v3:leiden-cpm',
            topicCount: 87,
            lineageCount: 90,
          },
        },
      }),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      expect(screen.getByTestId('hp-pipeline-stage-ranker')).toBeInTheDocument();
    });
    // The Ranker drill must render without throwing — the actual
    // content correctness is covered by the prior tests; the
    // assertion here is just "no crash on null reasons".
    fireEvent.click(screen.getByTestId('hp-pipeline-stage-ranker'));
    await waitFor(() => {
      const gate = screen.getByTestId('hp-ranker-shipgate-fail');
      // Ship-gate callout still renders the candidate even without
      // a reason string — fallback to `r?.activeModelVersion` or
      // 'unknown'.
      expect(gate.textContent).toMatch(/Ship gate · fail/);
    });
  });

  it('warns when active vs expected ranker model/schema versions diverge', async () => {
    vi.unstubAllGlobals();
    stubFetch(
      mkHealth({
        workGraph: {
          ranker: {
            activeRevisionId: 'rev_old',
            loadStatus: 'ready' as const,
            trainedAt: Date.now() - 60 * 60_000,
            retrainSkipReason: null,
            retrainNewLabelCount: 0,
            activeModelVersion: 'lightgbm-lambdamart-v3',
            expectedModelVersion: 'lightgbm-lambdamart-v4',
            activeFeatureSchemaVersion: 3,
            expectedFeatureSchemaVersion: 4,
            needsRetrain: true,
          },
        },
      }),
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      expect(screen.getByTestId('hp-pipeline-stage-ranker')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('hp-pipeline-stage-ranker'));

    await waitFor(() => {
      const drift = screen.getByTestId('hp-ranker-model-drift');
      expect(drift.textContent).toMatch(/lightgbm-lambdamart-v3/);
      expect(drift.textContent).toMatch(/lightgbm-lambdamart-v4/);
      expect(drift.textContent).toMatch(/Feature schema v3/);
      expect(drift.textContent).toMatch(/expected v4/);
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

  // F2 — the Topics drill repoints off the retired idf-rkn shadow
  // (perpetually null post-W2) onto the SERVED producer's per-drain
  // report + ring series.
  it('renders the served producer in the Topics drill (stability tile, receipt, drain trend)', async () => {
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
            activeRevisionId: 'bWTFkVzGSOCmyj_1',
            algorithmVersion: 'topic-revision:v3:leiden-cpm',
            topicCount: 87,
            lineageCount: 90,
          },
        },
      }),
      {
        focus: {
          availability: 'ok',
          asOf: '2026-05-18T04:32:15.210Z',
          digest: {
            servedTopicProducer: {
              producer: 'leiden-cpm',
              algorithmId: 'topic-revision:v3:leiden-cpm',
              cosineThreshold: 0.9,
              topicCount: 87,
              coveredPages: 410,
              lineageContinue: 82,
              lineageSplit: 4,
              lineageMerge: 4,
              churnP50: 0,
              churnP90: 0.25,
              revisionId: 'bWTFkVzGSOCmyj_1',
              previousRevisionId: 'bV_prev_rev',
            },
          },
          history: [
            {
              at: '2026-05-18T04:12:11.190Z',
              adjacentPerVisitChurn: null,
              shadowMaxTopicShare: null,
              noiseShare: null,
              shadowTopicCount: null,
              servedTopicCount: 86,
              servedChurnP50: 0,
              servedChurnP90: 0.2,
              servedLineageContinue: 80,
              servedLineageSplit: 3,
              servedLineageMerge: 2,
            },
            {
              at: '2026-05-18T04:32:15.210Z',
              adjacentPerVisitChurn: null,
              shadowMaxTopicShare: null,
              noiseShare: null,
              shadowTopicCount: null,
              servedTopicCount: 87,
              servedChurnP50: 0,
              servedChurnP90: 0.25,
              servedLineageContinue: 82,
              servedLineageSplit: 4,
              servedLineageMerge: 4,
            },
          ],
        },
      },
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      expect(screen.getByTestId('hp-pipeline-stage-topics')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('hp-pipeline-stage-topics'));

    await waitFor(() => {
      const tile = screen.getByTestId('hp-topics-served-stability');
      expect(tile.textContent).not.toMatch(/no signal yet/);
      expect(tile.textContent).toMatch(/churn p50/);
      expect(tile.textContent).toMatch(/410 pages/);
      expect(tile.textContent).toMatch(/82\/4\/4/);
    });
    // Receipt is now the served-producer report, not the dead shadow.
    // (the algorithm id also appears in the active-revision tile foot)
    expect(screen.getAllByText('topic-revision:v3:leiden-cpm').length).toBeGreaterThan(1);
    expect(screen.getByText('87 (410 pages covered)')).toBeInTheDocument();
    expect(screen.getByText('bV_prev_rev')).toBeInTheDocument();
    expect(screen.queryByText('Shadow comparison')).not.toBeInTheDocument();
    expect(screen.queryByText('Adjacent churn')).not.toBeInTheDocument();
    // Drain-trend table carries the served series + columns.
    const trend = screen.getByTestId('hp-topics-drain-trend');
    expect(trend.textContent).toMatch(/Churn p50/);
    expect(trend.textContent).toMatch(/Lineage c\/s\/m/);
    expect(trend.textContent).not.toMatch(/Shadow topics/);
    expect(trend.textContent).toMatch(/87/);
    expect(trend.textContent).toMatch(/0\.250/);
  });

  it('renders an honest "no signal yet" Topics drill when the served report is absent', async () => {
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
            activeRevisionId: 'rev_x',
            algorithmVersion: 'topic-revision:v3:leiden-cpm',
            topicCount: 12,
            lineageCount: 3,
          },
        },
      }),
      {
        // Digest loaded, but no servedTopicProducer block yet (e.g. a
        // drain before the F2 companion writes it) → honest blank.
        focus: {
          availability: 'ok',
          asOf: '2026-05-18T04:32:15.210Z',
          digest: { schemaVersion: 1 },
          history: [],
        },
      },
    );

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    await waitFor(() => {
      expect(screen.getByTestId('hp-pipeline-stage-topics')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('hp-pipeline-stage-topics'));

    await waitFor(() => {
      const tile = screen.getByTestId('hp-topics-served-stability');
      expect(tile.textContent).toMatch(/no signal yet/);
    });
    expect(screen.getAllByText('no signal yet').length).toBeGreaterThan(0);
  });
});
