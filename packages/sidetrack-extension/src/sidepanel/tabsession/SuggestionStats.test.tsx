import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LANE_FALLBACK_WHY_PREFIX } from './laneFallbackPick';
import { SuggestionStats } from './SuggestionStats';
import type {
  TabSessionResolutionResult,
  TabSessionResolverCandidate,
  TabSessionWorkstreamOption,
} from './types';

const workstreams: readonly TabSessionWorkstreamOption[] = [
  { bac_id: 'ws-1', path: 'Research / Probability' },
  { bac_id: 'ws-2', path: 'Infra / Deploy' },
  { bac_id: 'ws-3', path: 'Reading / Longform' },
  { bac_id: 'ws-4', path: 'Admin / Ops' },
  { bac_id: 'ws-5', path: 'Side / Misc' },
];

const candidate = (
  over: Partial<TabSessionResolverCandidate> = {},
): TabSessionResolverCandidate => ({
  workstreamId: 'ws-1',
  rawFusionLogit: 1.2,
  dominantSource: 'ppr',
  reasons: [{ source: 'ppr', summary: 'graph 0.5', anchors: [] }],
  ...over,
});

const resolution = (
  decision: TabSessionResolutionResult['decision'],
  candidates: readonly TabSessionResolverCandidate[],
): TabSessionResolutionResult => ({
  tabSessionId: 'tses_1',
  dryRun: true,
  decision,
  fusedCandidates: candidates,
});

describe('SuggestionStats — ranked "Possibilities" list', () => {
  it('shows the endorsed primary prominently and collapses the rest under "Other possibilities (N)"', () => {
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'suggest', workstreamId: 'ws-1', margin: 0.9 }, [
          candidate({ workstreamId: 'ws-1', rawFusionLogit: 2.5 }),
          candidate({ workstreamId: 'ws-2', rawFusionLogit: 1.0 }),
          candidate({ workstreamId: 'ws-3', rawFusionLogit: 0.3 }),
        ])}
        workstreams={workstreams}
        showEmptyPlaceholder
      />,
    );
    // Primary still prominent.
    expect(screen.getByText('Research / Probability')).toBeDefined();
    // The tail is collapsed under a disclosure counting the 2 non-primary rows.
    const summary = screen.getByText('Other possibilities (2)');
    expect(summary).toBeDefined();
    const details = summary.closest('details');
    expect(details).not.toBeNull();
    // Collapsed by default (no `open` attribute).
    expect(details?.hasAttribute('open')).toBe(false);
    // The two non-primary workstreams are listed (plain words for the source).
    expect(screen.getByText('Infra / Deploy')).toBeDefined();
    expect(screen.getByText('Reading / Longform')).toBeDefined();
  });

  it('EXPANDS the possibilities when there is no confident primary (weak guess below the bar)', () => {
    // The key case the user means: sub-threshold candidates that used to read
    // as "No signal yet". action='inbox' → no confident primary → the list is
    // open, headed "Below confidence bar — possibilities:", including rank 0.
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: -0.4 }, [
          candidate({ workstreamId: 'ws-1', rawFusionLogit: 0.6 }),
          candidate({ workstreamId: 'ws-2', rawFusionLogit: 0.3 }),
        ])}
        workstreams={workstreams}
        showEmptyPlaceholder
      />,
    );
    expect(screen.getByText('Below confidence bar — possibilities:')).toBeDefined();
    // No "No signal yet" lie — the resolver HAD ranked possibilities.
    expect(screen.queryByText('No signal yet')).toBeNull();
    // Both candidates listed, top included.
    expect(screen.getByText('Infra / Deploy')).toBeDefined();
    // ws-1 appears both as the weak-guess headline target and a possibility
    // row; getAllByText tolerates the duplicate.
    expect(screen.getAllByText('Research / Probability').length).toBeGreaterThanOrEqual(1);
  });

  it('files a possibility through the EXISTING pick flow via onFileHere', () => {
    const onFileHere = vi.fn();
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'suggest', workstreamId: 'ws-1', margin: 0.9 }, [
          candidate({ workstreamId: 'ws-1', rawFusionLogit: 2.5 }),
          candidate({ workstreamId: 'ws-2', rawFusionLogit: 1.0 }),
        ])}
        workstreams={workstreams}
        showEmptyPlaceholder
        onFileHere={onFileHere}
      />,
    );
    // The one non-primary possibility (ws-2) exposes a "File here" button.
    const row = screen.getByText('Infra / Deploy').closest('li');
    expect(row).not.toBeNull();
    const fileButton = within(row as HTMLElement).getByRole('button', { name: 'File here' });
    fireEvent.click(fileButton);
    expect(onFileHere).toHaveBeenCalledTimes(1);
    expect(onFileHere).toHaveBeenCalledWith('ws-2');
  });

  it('renders the list read-only (no File-here button) when onFileHere is omitted', () => {
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: -0.4 }, [
          candidate({ workstreamId: 'ws-1' }),
          candidate({ workstreamId: 'ws-2' }),
        ])}
        workstreams={workstreams}
        showEmptyPlaceholder
      />,
    );
    expect(screen.getByText('Below confidence bar — possibilities:')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'File here' })).toBeNull();
  });

  it('does not render a possibilities list for a single-candidate endorsed suggestion', () => {
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'suggest', workstreamId: 'ws-1', margin: 0.9 }, [
          candidate({ workstreamId: 'ws-1', rawFusionLogit: 2.5 }),
        ])}
        workstreams={workstreams}
        showEmptyPlaceholder
      />,
    );
    expect(screen.queryByText(/Other possibilities/)).toBeNull();
    expect(screen.queryByText('Below confidence bar — possibilities:')).toBeNull();
  });

  it('keeps the genuine-empty "No signal yet" card unchanged (zero candidates)', () => {
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: 0 }, [])}
        workstreams={workstreams}
        showEmptyPlaceholder
        pageAccessGranted
      />,
    );
    expect(screen.getByText('No signal yet')).toBeDefined();
    expect(screen.queryByText('Below confidence bar — possibilities:')).toBeNull();
  });

  it('renders nothing (no possibilities) for a busy/error resolve state', () => {
    const { container } = render(
      <SuggestionStats workstreams={workstreams} showEmptyPlaceholder error={{ kind: 'busy' }} />,
    );
    expect(screen.getByText('Companion is busy — retrying')).toBeDefined();
    expect(container.querySelector('.suggestion-possibilities')).toBeNull();
  });
});

// The lane-fallback pick — the companion now fills an EMPTY fusion's displayed
// pick from the content + ai guess lanes (tabsession/laneFallback.ts) so the
// card shows a best guess on partial data instead of "In workstream: — / No
// confident pick". Those candidates ride in the same fusedCandidates array a
// real fused candidate would, so the card must be able to tell them apart and
// label the pick as UNCONFIRMED rather than presenting it like a suggestion.
describe('SuggestionStats — lane-fallback pick (unconfirmed, page-content only)', () => {
  // Exactly what the companion emits: reasons[0].summary carries the frozen
  // provenance prefix, all evidence channels are 0, dominantSource is 'none',
  // and rawFusionLogit holds the lane-native score (NOT a fusion logit).
  const fallbackCandidate = (
    workstreamId: string,
    score: number,
    lanes: string,
  ): TabSessionResolverCandidate => ({
    workstreamId,
    rawFusionLogit: score,
    dominantSource: 'none',
    reasons: [
      {
        source: 'similarity',
        summary: `${LANE_FALLBACK_WHY_PREFIX} · ${lanes} ${String(Math.round(score * 100))}%`,
        anchors: [],
      },
    ],
  });

  const jfrogResolution = (): TabSessionResolutionResult =>
    resolution(
      {
        action: 'inbox',
        margin: 0,
        gate: {
          reason: 'no-candidates',
          detail: 'no candidates reached fusion · lane-fallback shown',
        },
      },
      [
        fallbackCandidate('ws-2', 0.71, 'content + ai lanes'),
        fallbackCandidate('ws-1', 0.62, 'content + ai lanes'),
        fallbackCandidate('ws-3', 0.31, 'content lane'),
      ],
    );

  it('labels the pick UNCONFIRMED with its page-content provenance, not as a suggestion', () => {
    render(
      <SuggestionStats suggestion={jfrogResolution()} workstreams={workstreams} showEmptyPlaceholder />,
    );
    const chip = screen.getByTestId('lane-fallback-pick');
    expect(chip.textContent).toBe('Unconfirmed — from page content (AI-assisted)');
    // The workstream IS shown (the whole point — a best guess beats a dash) …
    expect(screen.getAllByText('Infra / Deploy').length).toBeGreaterThanOrEqual(1);
    // … and the generic weak-guess wording is NOT used: there was no fusion
    // here at all, so "below the resolver's confidence bar" would misdescribe it.
    expect(screen.queryByText('weak guess — filed to inbox')).toBeNull();
  });

  it('never prints a confidence word for a synthesized score', () => {
    const { container } = render(
      <SuggestionStats suggestion={jfrogResolution()} workstreams={workstreams} showEmptyPlaceholder />,
    );
    // The headline shows NO confidence word at all when the uncertainty chip
    // is up. It used to print the level label ("No clear pick") beside the
    // chip; on a real weak-guess page that same slot rendered "WEAK GUESS —
    // FILED TO INBOX  ai  Highly likely" — a contradiction on one line (live
    // screenshot, 2026-07-28). The chip is the whole statement now; the level
    // survives only in the ⓘ tooltip.
    expect(screen.queryByText('No clear pick')).toBeNull();
    expect(container.querySelector('.suggestion-stats-confidence')).toBeNull();
    // … and every possibility row says "unconfirmed" rather than a calibrated
    // word ("Medium") derived from a lane score sitting in the logit field.
    const words = Array.from(
      container.querySelectorAll('.suggestion-possibility-confidence'),
    ).map((el) => el.textContent);
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) expect(word).toBe('· unconfirmed');
    // The card is tagged for the fallback so styling/telemetry can tell.
    expect(container.querySelector('[data-endorsement="lane-fallback"]')).not.toBeNull();
  });

  it('leaves a REAL weak guess reading exactly as before', () => {
    // Regression guard: an ordinary un-endorsed fused candidate (no fallback
    // provenance) must keep the existing weak-guess headline.
    render(
      <SuggestionStats
        suggestion={resolution({ action: 'inbox', margin: -0.4 }, [
          candidate({ workstreamId: 'ws-1', rawFusionLogit: 0.6 }),
        ])}
        workstreams={workstreams}
        showEmptyPlaceholder
      />,
    );
    expect(screen.getByText('weak guess — filed to inbox')).toBeDefined();
    expect(screen.queryByTestId('lane-fallback-pick')).toBeNull();
  });
});
