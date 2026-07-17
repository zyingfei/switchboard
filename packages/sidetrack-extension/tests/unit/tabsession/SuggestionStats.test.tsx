import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
  it('renders highly-likely bucket for logit ≥ 1.4 (qualitative lean only)', () => {
    render(
      <SuggestionStats suggestion={suggestion({ topLogit: 2.0 })} workstreams={workstreams} />,
    );
    // sigmoid(2.0) ≈ 0.881 → >80% → "Highly likely"
    expect(screen.getByText(/Highly likely/)).toBeInTheDocument();
    // The raw % is uncalibrated — it must NOT appear on the primary card
    // headline; it moved into the ⓘ tooltip (see below).
    expect(screen.queryByText(/88%/)).toBeNull();
    expect(screen.getByText('ⓘ').getAttribute('title')).toContain('88%');
  });

  it('renders not-likely bucket for negative logit', () => {
    render(
      <SuggestionStats suggestion={suggestion({ topLogit: -2.0 })} workstreams={workstreams} />,
    );
    expect(screen.getByText(/Not likely/)).toBeInTheDocument();
  });

  it('tooltip labels the raw logit + margin + source as UNCALIBRATED diagnostics', () => {
    render(
      <SuggestionStats
        suggestion={suggestion({ topLogit: 0.5, margin: 0.8 })}
        workstreams={workstreams}
      />,
    );
    const infoTip = screen.getByText('ⓘ');
    const title = infoTip.getAttribute('title') ?? '';
    // Honesty: framed as uncalibrated, not a calibrated probability.
    expect(title).toContain('Uncalibrated diagnostics');
    expect(title).toContain('logit 0.50');
    expect(title).toContain('margin to runner-up 0.80');
    expect(title).toContain('dominant signal ppr');
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

  it('shows an actionable page-access prompt when access is off (not the generic first-seen copy)', () => {
    const empty: TabSessionResolutionResult = {
      tabSessionId: 'https://cold-start.example/page',
      dryRun: true,
      decision: { action: 'inbox', margin: 0 },
      fusedCandidates: [],
    };
    const onGrantAccess = vi.fn();
    render(
      <SuggestionStats
        suggestion={empty}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted={false}
        onGrantAccess={onGrantAccess}
      />,
    );
    // When access is off the resolver can't produce signal for ANY page,
    // so the placeholder names the real reason + offers the fix.
    expect(screen.getByText('No signal — page access off')).toBeInTheDocument();
    expect(screen.queryByText('No signal yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));
    expect(onGrantAccess).toHaveBeenCalledTimes(1);
  });

  it('keeps the generic empty placeholder when page access IS granted', () => {
    const empty: TabSessionResolutionResult = {
      tabSessionId: 'https://cold-start.example/page',
      dryRun: true,
      decision: { action: 'inbox', margin: 0 },
      fusedCandidates: [],
    };
    render(
      <SuggestionStats
        suggestion={empty}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
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

  const emptyResolution = (): TabSessionResolutionResult => ({
    tabSessionId: 'https://revisit.example/page',
    dryRun: true,
    decision: { action: 'inbox', margin: 0 },
    fusedCandidates: [],
  });

  it('distinguishes a revisit ("seen N times — no connections yet") from a first visit', () => {
    render(
      <SuggestionStats
        suggestion={emptyResolution()}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
        visitCount={4}
      />,
    );
    // Revisit copy — honest about the repeat visit, no "first time" lie.
    expect(screen.getByText('No connections yet')).toBeInTheDocument();
    expect(
      screen.getByText(/Seen 4 times — no connections yet/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/First time seeing this URL/)).toBeNull();
    // Tooltip surfaces the count too.
    expect(screen.getByText('ⓘ').getAttribute('title')).toContain('Seen 4 times');
  });

  it('keeps the first-seen copy when visitCount is 1 (genuine first visit)', () => {
    render(
      <SuggestionStats
        suggestion={emptyResolution()}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
        visitCount={1}
      />,
    );
    expect(screen.getByText('No signal yet')).toBeInTheDocument();
    expect(screen.getByText(/First time seeing this URL/)).toBeInTheDocument();
    expect(screen.queryByText(/no connections yet/)).toBeNull();
  });

  it('keeps the first-seen copy when visitCount is undefined (older callers)', () => {
    render(
      <SuggestionStats
        suggestion={emptyResolution()}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    expect(screen.getByText('No signal yet')).toBeInTheDocument();
  });

  it('page-access-off prompt takes priority over the revisit copy', () => {
    // Even for a repeat visit, if page access is off the actionable
    // grant-access branch must win (the fix is the same either way).
    render(
      <SuggestionStats
        suggestion={emptyResolution()}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted={false}
        visitCount={7}
      />,
    );
    expect(screen.getByText('No signal — page access off')).toBeInTheDocument();
    expect(screen.queryByText('No connections yet')).toBeNull();
  });
});
