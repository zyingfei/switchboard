import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HealthPanel } from '../../../entrypoints/sidepanel/components/HealthPanel';

const mkHealth = () => ({
  uptimeSec: 12,
  vault: { root: '/tmp/vault', writable: true, sizeBytes: 12_345 },
  capture: {
    lastByProvider: { chatgpt: '2026-05-12T20:00:00.000Z' },
    queueDepthHint: 0,
    droppedHint: 0,
    providers: [],
    recentWarnings: [],
  },
  recall: {
    indexExists: true,
    entryCount: 10,
    modelId: 'Xenova/multilingual-e5-small',
    sizeBytes: 1000,
    status: 'ready' as const,
  },
  service: { installed: true, running: true },
});

const criterion = (
  id: string,
  label: string,
  value: number,
  threshold: number,
  unit: 'fraction' | 'count' | 'days',
  met: boolean,
) => ({ id, label, observable: id, value, threshold, unit, met, detail: `${id} detail` });

const stubFetch = (section15: unknown) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/v1/system/section15')) {
        return { ok: true, status: 200, json: async () => ({ data: section15 }) };
      }
      if (url.includes('/v1/system/focus-health')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { availability: 'unavailable', asOf: null, digest: null, history: [] } }),
        };
      }
      if (url.includes('/v1/system/hygiene-status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { asOf: null, availability: { gc: 'unavailable', pageContent: 'unavailable' }, gc: null, pageContent: null },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ data: mkHealth() }) };
    }),
  );
};

describe('HealthPanel §15 falsifiability table', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders each criterion with met/pending and value vs threshold', async () => {
    stubFetch({
      availability: 'ok',
      generatedAt: '2026-07-11T12:00:00.000Z',
      report: {
        freezeLiftEligible: false,
        criteria: [
          criterion('trackedSessionsFraction', '≥80% tracked', 0.6, 0.8, 'fraction', false),
          criterion('packetsDispatched', '≥5 packets dispatched', 5, 5, 'count', true),
          criterion('losslessReorgs', '≥3 lossless reorgs', 3, 3, 'count', true),
          criterion('tabRecoveries', '≥1 tab recovery', 1, 1, 'count', true),
          criterion('mcpContextPackSessions', '≥1 MCP context-pack session', 0, 1, 'count', false),
          criterion('consecutiveCleanDays', '≥7 days zero data loss', 4, 7, 'days', false),
        ],
      },
    });

    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);

    const table = await screen.findByTestId('hp-section15-table');
    expect(table).not.toBeNull();

    // A met criterion renders "met"; a pending one renders "pending".
    const met = screen.getByTestId('hp-section15-tabRecoveries');
    expect(met.getAttribute('data-met')).toBe('true');
    expect(met.textContent).toContain('1 / 1');

    const pending = screen.getByTestId('hp-section15-consecutiveCleanDays');
    expect(pending.getAttribute('data-met')).toBe('false');
    expect(pending.textContent).toContain('4d / 7d');

    // Fraction row is rendered as a percentage vs its percentage threshold.
    const fraction = screen.getByTestId('hp-section15-trackedSessionsFraction');
    expect(fraction.textContent).toContain('60% / 80%');

    // Overall summary: 3/6 met.
    expect(screen.getByTestId('hp-section15').textContent).toContain('3/6 met');
  });

  it('does not render the table when the companion has no §15 route (older build)', async () => {
    // section15 responds with a health-shaped body (route missing → the
    // fallthrough); isSection15Response rejects it and the section is
    // simply absent — never a fabricated pass.
    stubFetch(mkHealth());
    render(<HealthPanel onClose={vi.fn()} companionPort={17373} bridgeKey="key" />);
    // Wait for the board to render, then assert the §15 block is absent.
    await waitFor(() => {
      expect(screen.queryByTestId('hp-pipeline')).not.toBeNull();
    });
    expect(screen.queryByTestId('hp-section15')).toBeNull();
  });
});
