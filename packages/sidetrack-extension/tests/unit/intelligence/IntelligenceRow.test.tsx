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

const okFetch = (body: unknown) =>
  vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) } as Response);

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

  it('shows an unavailable state when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<IntelligenceRow companionPort={17374} bridgeKey="key" />);
    await waitFor(() => {
      expect(screen.getByTestId('intelligence-row').textContent).toContain('unavailable');
    });
  });
});
