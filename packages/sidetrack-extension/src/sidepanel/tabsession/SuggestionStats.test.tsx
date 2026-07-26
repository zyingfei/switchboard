import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
