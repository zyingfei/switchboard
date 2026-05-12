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

  it('renders all six pipeline stages with the right status dots', async () => {
    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    const pipeline = await screen.findByTestId('hp-pipeline');
    for (const id of ['capture', 'vault', 'materializers', 'recall', 'ranker', 'sync']) {
      expect(pipeline.querySelector(`[data-testid="hp-pipeline-stage-${id}"]`)).not.toBeNull();
    }
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
