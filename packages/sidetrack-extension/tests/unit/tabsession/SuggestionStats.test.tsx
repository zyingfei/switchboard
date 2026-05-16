import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SuggestionStats } from '../../../src/sidepanel/tabsession/SuggestionStats';
import type {
  TabSessionResolutionResult,
  TabSessionWorkstreamOption,
} from '../../../src/sidepanel/tabsession/types';

const workstreams: TabSessionWorkstreamOption[] = [
  { bac_id: 'ws_homelab', path: 'homelab' },
  { bac_id: 'ws_sideproject', path: 'sideproject' },
  { bac_id: 'ws_cloud', path: 'cloud' },
];

const suggestion = (overrides: {
  topLogit: number;
  topWs?: string;
  margin?: number;
  alts?: readonly { ws: string; logit: number }[];
}): TabSessionResolutionResult => ({
  tabSessionId: 'https://example.test/page',
  dryRun: true,
  decision: {
    action: 'suggest',
    workstreamId: overrides.topWs ?? 'ws_homelab',
    margin: overrides.margin ?? 1.2,
  },
  fusedCandidates: [
    {
      workstreamId: overrides.topWs ?? 'ws_homelab',
      rawFusionLogit: overrides.topLogit,
      dominantSource: 'ppr',
      reasons: [],
    },
    ...(overrides.alts ?? []).map((a) => ({
      workstreamId: a.ws,
      rawFusionLogit: a.logit,
      dominantSource: 'similarity' as const,
      reasons: [],
    })),
  ],
});

describe('SuggestionStats', () => {
  it('renders highly-likely bucket for logit ≥ 1.4', () => {
    render(
      <SuggestionStats suggestion={suggestion({ topLogit: 2.0 })} workstreams={workstreams} />,
    );
    // sigmoid(2.0) ≈ 0.881 → >80% → "Highly likely"
    expect(screen.getByText(/Highly likely/)).toBeInTheDocument();
    expect(screen.getByText(/88%/)).toBeInTheDocument();
  });

  it('renders not-likely bucket for negative logit', () => {
    render(
      <SuggestionStats suggestion={suggestion({ topLogit: -2.0 })} workstreams={workstreams} />,
    );
    expect(screen.getByText(/Not likely/)).toBeInTheDocument();
  });

  it('tooltip exposes the raw logit + margin + source', () => {
    render(
      <SuggestionStats
        suggestion={suggestion({ topLogit: 0.5, margin: 0.8 })}
        workstreams={workstreams}
      />,
    );
    const infoTip = screen.getByText('ⓘ');
    expect(infoTip.getAttribute('title')).toContain('logit 0.50');
    expect(infoTip.getAttribute('title')).toContain('Margin to runner-up: 0.80');
    expect(infoTip.getAttribute('title')).toContain('Dominant signal: ppr');
  });

  it('shows alternatives when showAlternatives is true', () => {
    render(
      <SuggestionStats
        suggestion={suggestion({
          topLogit: 2.0,
          alts: [
            { ws: 'ws_sideproject', logit: 0.0 },
            { ws: 'ws_cloud', logit: -1.5 },
          ],
        })}
        workstreams={workstreams}
        showAlternatives
      />,
    );
    expect(screen.getByText(/Other candidates/)).toBeInTheDocument();
    expect(screen.getByText(/sideproject/)).toBeInTheDocument();
    expect(screen.getByText(/cloud/)).toBeInTheDocument();
  });

  it('returns null when no suggestion is provided (default)', () => {
    const { container } = render(<SuggestionStats workstreams={workstreams} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders loading placeholder when showEmptyPlaceholder + no suggestion', () => {
    // No suggestion = the companion hasn't returned yet. Show
    // "Checking signals…" so the user knows the resolver is in
    // flight; the "No signal yet" copy is reserved for the
    // suggestion-arrived-but-empty case below.
    render(<SuggestionStats workstreams={workstreams} showEmptyPlaceholder />);
    expect(screen.getByText('Checking signals…')).toBeInTheDocument();
    expect(
      screen.getByText(/Asking the companion for related visits, similarity, and topic membership/),
    ).toBeInTheDocument();
  });

  it('renders empty placeholder when showEmptyPlaceholder + suggestion with no candidates', () => {
    const empty: TabSessionResolutionResult = {
      tabSessionId: 'https://cold-start.example/page',
      dryRun: true,
      decision: { action: 'inbox', margin: 0 },
      fusedCandidates: [],
    };
    render(<SuggestionStats suggestion={empty} workstreams={workstreams} showEmptyPlaceholder />);
    expect(screen.getByText('No signal yet')).toBeInTheDocument();
  });

  it('hides alternatives by default (showAlternatives undefined)', () => {
    render(
      <SuggestionStats
        suggestion={suggestion({
          topLogit: 2.0,
          alts: [{ ws: 'ws_sideproject', logit: 0.5 }],
        })}
        workstreams={workstreams}
      />,
    );
    expect(screen.queryByText(/Other candidates/)).toBeNull();
  });
});
