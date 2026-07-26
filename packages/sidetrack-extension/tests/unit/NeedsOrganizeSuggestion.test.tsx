import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NeedsOrganizeSuggestion } from '../../entrypoints/sidepanel/components/NeedsOrganizeSuggestion';
import type {
  GuessLaneResult,
  ResolveOutcomeError,
  TabSessionWorkstreamOption,
} from '../../src/sidepanel/tabsession/types';

// The presentational half of the thread card's self-heal contract. The busy
// flip + retry loop live in NeedsOrganizeSuggestionRow (App.tsx); this proves
// the RENDER honours the same populated-wins precedence the URL surface uses:
//   - a failed/hung fetch (error set, no confident pick) → amber "busy —
//     retrying", never the confident "pick a workstream…" falsehood.
//   - a late success (confidence > 0) → the pick, busy copy gone (heals).

const base = (overrides: Record<string, unknown> = {}) => ({
  suggestedLabel: 'Shadow v2',
  confidence: 0,
  onAccept: vi.fn(),
  onPickManual: vi.fn(),
  onDismiss: vi.fn(),
  ...overrides,
});

const busyError: ResolveOutcomeError = { kind: 'busy' };

afterEach(() => {
  cleanup();
});

describe('NeedsOrganizeSuggestion — thread busy/self-heal render', () => {
  it('renders the honest busy card when a fetch failed with no confident pick', () => {
    render(<NeedsOrganizeSuggestion {...base({ confidence: 0, error: busyError })} />);
    // The same amber "busy — retrying" language the URL surface uses.
    expect(screen.getByText('Companion is busy — retrying')).toBeInTheDocument();
    expect(
      screen.getByText('Retrying automatically — the resolver is catching up'),
    ).toBeInTheDocument();
    // NOT the confident "no auto-suggestion — pick a workstream" falsehood.
    expect(screen.queryByText(/No auto-suggestion/u)).not.toBeInTheDocument();
  });

  it('busy → successful fetch HEALS: a late populated pick supersedes the busy card', () => {
    const { rerender } = render(
      <NeedsOrganizeSuggestion {...base({ confidence: 0, error: busyError })} />,
    );
    expect(screen.getByText('Companion is busy — retrying')).toBeInTheDocument();

    // The retry loop's next probe succeeds: error cleared, a confident pick
    // arrives. The card must drop the busy copy and show the recommendation.
    rerender(
      <NeedsOrganizeSuggestion {...base({ confidence: 0.85, margin: 0.5, error: undefined })} />,
    );
    expect(screen.queryByText('Companion is busy — retrying')).not.toBeInTheDocument();
    expect(screen.getByText('Shadow v2')).toBeInTheDocument();
    expect(screen.getByText('Highly likely')).toBeInTheDocument();
    // Accept is offered again once a real pick lands.
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
  });

  it('populated wins over a stale error: a confident pick never shows the busy card', () => {
    // A later refresh errored but we already have a pick — show the pick, not
    // the busy state (mirrors suggestionStateFrom populated-wins precedence).
    render(
      <NeedsOrganizeSuggestion {...base({ confidence: 0.85, margin: 0.5, error: busyError })} />,
    );
    expect(screen.queryByText('Companion is busy — retrying')).not.toBeInTheDocument();
    expect(screen.getByText('Shadow v2')).toBeInTheDocument();
  });

  it('exposes a manual retry (↻) on the busy card so the user can force a probe', () => {
    const onRefresh = vi.fn();
    render(<NeedsOrganizeSuggestion {...base({ confidence: 0, error: busyError, onRefresh })} />);
    expect(screen.getByRole('button', { name: 'Recompute suggestion' })).toBeInTheDocument();
  });

  it('no error → the ordinary empty picker, not the busy card', () => {
    render(<NeedsOrganizeSuggestion {...base({ confidence: 0, error: undefined })} />);
    expect(screen.queryByText('Companion is busy — retrying')).not.toBeInTheDocument();
    expect(screen.getByText('No auto-suggestion — pick a workstream:')).toBeInTheDocument();
  });
});

describe('NeedsOrganizeSuggestion — guess-lanes on the thread surface', () => {
  const laneWorkstreams: readonly TabSessionWorkstreamOption[] = [
    { bac_id: 'ws-1', path: 'Research / Probability' },
    { bac_id: 'ws-2', path: 'Infra / Deploy' },
  ];
  const lanes: readonly GuessLaneResult[] = [
    {
      lane: 'graph',
      candidates: [{ workstreamId: 'ws-1', score: 0.4, why: 'linked from a Research thread' }],
    },
    { lane: 'similarity', candidates: [], emptyReason: 'no similar pages' },
    { lane: 'topic', candidates: [] },
    { lane: 'title', candidates: [] },
    { lane: 'domain', candidates: [] },
    {
      lane: 'recency',
      candidates: [{ workstreamId: 'ws-2', score: 0.2, why: 'recently filed to Deploy' }],
    },
  ];

  it('shows the lanes disclosure in the NO-suggestion state', () => {
    render(
      <NeedsOrganizeSuggestion {...base({ confidence: 0, lanes, laneWorkstreams })} />,
    );
    // Ordinary empty picker headline …
    expect(screen.getByText('No auto-suggestion — pick a workstream:')).toBeInTheDocument();
    // … PLUS the shared lanes disclosure (2 of 6 with signal).
    expect(screen.getByText('Guess lanes · 2 of 6 with signal')).toBeInTheDocument();
    expect(screen.getByText('linked from a Research thread')).toBeInTheDocument();
    expect(screen.getByText('recently filed to Deploy')).toBeInTheDocument();
  });

  it('does NOT show the lanes disclosure once there is a confident recommendation', () => {
    render(
      <NeedsOrganizeSuggestion
        {...base({ confidence: 0.85, margin: 0.5, lanes, laneWorkstreams })}
      />,
    );
    // With a confident pick the lanes are redundant noise → suppressed.
    expect(screen.queryByText(/Guess lanes/u)).not.toBeInTheDocument();
  });

  it('files a lane candidate through onFileLane (the EXISTING accept path)', () => {
    const onFileLane = vi.fn();
    render(
      <NeedsOrganizeSuggestion
        {...base({ confidence: 0, lanes, laneWorkstreams, onFileLane })}
      />,
    );
    const laneRow = screen.getByText('Infra / Deploy').closest('li');
    expect(laneRow).not.toBeNull();
    fireEvent.click(within(laneRow as HTMLElement).getByRole('button', { name: 'File here' }));
    expect(onFileLane).toHaveBeenCalledTimes(1);
    expect(onFileLane).toHaveBeenCalledWith('ws-2');
  });
});
