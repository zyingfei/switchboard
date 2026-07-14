import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IntelligenceRow } from '../../../entrypoints/sidepanel/components/IntelligenceRow';

const HEALTH = {
  data: {
    workGraph: {
      recall: { canonicalVectorCounts: { documentVectorCount: 1275, chunkVectorCount: 1234 } },
      ranker: { augmentation: { rankerSourceEdgeCount: 0, closestVisitEdgeCount: 0 } },
      feedback: { actionCount: 746 },
      impressionLog: { servedCount: 1442, actionCount: 65 },
    },
    sync: {
      materializers: {
        connections: { status: 'healthy', lastSuccessAt: '2026-07-13T07:18:33.144Z' },
      },
    },
  },
};

const RELIABILITY = {
  data: {
    availability: 'ok',
    generatedAt: '2026-07-13T12:00:00.000Z',
    report: {
      numBins: 10,
      totalSamples: 20,
      surfaces: [{ surface: 'search', fit: { plattReliability: { ece: 0.08 } } }],
    },
  },
};

const okFetch = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) } as Response);

// Route health vs reliability to their respective bodies so the appended
// Calibration metric renders from the reliability endpoint.
const routedFetch = (health: unknown, reliability: unknown) =>
  vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = url.includes('/reliability') ? reliability : health;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IntelligenceRow', () => {
  it('prompts to connect when the companion is not configured', () => {
    render(<IntelligenceRow companionPort={null} bridgeKey={null} />);
    expect(screen.getByTestId('intelligence-row').textContent).toContain('Connect a companion');
  });

  it('renders the four metrics from a live health payload', async () => {
    vi.stubGlobal('fetch', okFetch(HEALTH));
    render(<IntelligenceRow companionPort={17374} bridgeKey="key" />);

    await waitFor(() => {
      expect(screen.getByText('1,275')).toBeDefined();
    });
    expect(screen.getByText('1,442')).toBeDefined();
    expect(screen.getByText('65 actions')).toBeDefined();
    const doc = screen.getByTestId('intelligence-row').querySelector('[data-metric="docVectors"]');
    expect(doc?.className).toContain('is-live');
    const sim = screen.getByTestId('intelligence-row').querySelector('[data-metric="simEdges"]');
    expect(sim?.className).toContain('is-idle');
  });

  it('appends the S1 Calibration metric from the reliability endpoint', async () => {
    vi.stubGlobal('fetch', routedFetch(HEALTH, RELIABILITY));
    render(<IntelligenceRow companionPort={17374} bridgeKey="key" />);
    await waitFor(() => {
      expect(screen.getByText('ECE 0.080')).toBeDefined();
    });
    const cal = screen
      .getByTestId('intelligence-row')
      .querySelector('[data-metric="calibration"]');
    expect(cal).not.toBeNull();
    // ECE 0.08 ≤ 0.1 → well-calibrated → live dot.
    expect(cal?.className).toContain('is-live');
  });

  it('omits the Calibration metric when reliability is unavailable (older companion)', async () => {
    // Health OK, reliability 404s → the four health metrics still render,
    // no Calibration metric appended.
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/reliability')) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(HEALTH) } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<IntelligenceRow companionPort={17374} bridgeKey="key" />);
    await waitFor(() => {
      expect(screen.getByText('1,275')).toBeDefined();
    });
    const cal = screen
      .getByTestId('intelligence-row')
      .querySelector('[data-metric="calibration"]');
    expect(cal).toBeNull();
  });

  it('shows an unavailable state when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<IntelligenceRow companionPort={17374} bridgeKey="key" />);
    await waitFor(() => {
      expect(screen.getByTestId('intelligence-row').textContent).toContain('unavailable');
    });
  });
});
