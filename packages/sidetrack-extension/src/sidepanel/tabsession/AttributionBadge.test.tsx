import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AttributionBadge } from './AttributionBadge';
import { LANE_FALLBACK_WHY_PREFIX } from './laneFallbackPick';
import type {
  TabSessionRecord,
  TabSessionResolutionResult,
  TabSessionResolverCandidate,
  TabSessionWorkstreamOption,
} from './types';

const workstreams: readonly TabSessionWorkstreamOption[] = [{ bac_id: 'ws-1', path: 'Research' }];

const record = (over: Partial<TabSessionRecord> = {}): TabSessionRecord => ({
  tabSessionId: 'tses_1',
  openedAt: '2026-07-13T00:00:00.000Z',
  lastActivityAt: '2026-07-13T00:00:00.000Z',
  attributionHistory: [],
  ...over,
});

const candidate = (): TabSessionResolverCandidate => ({
  workstreamId: 'ws-1',
  rawFusionLogit: 1.0,
  dominantSource: 'ppr',
  reasons: [],
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

describe('AttributionBadge honesty variant', () => {
  it('uses the suggested variant for an endorsed pick', () => {
    const { container } = render(
      <AttributionBadge
        record={record()}
        suggestion={resolution({ action: 'suggest', workstreamId: 'ws-1', margin: 0.9 }, [
          candidate(),
        ])}
        workstreams={workstreams}
      />,
    );
    expect(container.querySelector('[data-attribution-variant="suggested"]')).not.toBeNull();
  });

  it('uses the weak-guess variant for an un-endorsed (inbox) lean', () => {
    const { container } = render(
      <AttributionBadge
        record={record()}
        suggestion={resolution({ action: 'inbox', margin: -0.62 }, [candidate()])}
        workstreams={workstreams}
      />,
    );
    const badge = container.querySelector('[data-attribution-variant="weak-guess"]');
    expect(badge).not.toBeNull();
    // The label still shows the workstream so the user can act on it.
    expect(badge?.textContent).toContain('Research');
  });

  // Regression guard for the display-policy bug: fusion HELD (no candidates
  // reached fusion) and the top candidate is the synthesized below-floor
  // lane-fallback pick — the badge must not name that workstream as if it
  // were a real ("In workstream: X") suggestion.
  it('hides the fallback workstream name — shows "No good guess yet" — when fusion held', () => {
    const { container } = render(
      <AttributionBadge
        record={record()}
        suggestion={resolution({ action: 'inbox', margin: 0 }, [
          {
            workstreamId: 'ws-1',
            rawFusionLogit: 0.71,
            dominantSource: 'none',
            reasons: [
              {
                source: 'similarity',
                summary: `${LANE_FALLBACK_WHY_PREFIX} · content lane 71%`,
                anchors: [],
              },
            ],
          },
        ])}
        workstreams={workstreams}
      />,
    );
    const badge = container.querySelector('[data-attribution-variant="weak-guess"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('No good guess yet');
    expect(badge?.textContent).not.toContain('Research');
  });

  it('renders the empty placeholder when there is no candidate', () => {
    const { container } = render(
      <AttributionBadge
        record={record()}
        suggestion={resolution({ action: 'inbox', margin: 0 }, [])}
        workstreams={workstreams}
      />,
    );
    expect(container.querySelector('[data-attribution-variant="empty"]')).not.toBeNull();
  });
});

// Primary-membership removal (docs/plans/2026-08-16-category-flexibility-
// hyde.md §9 addendum, scope 4) — the "×" lives on the badge itself so the
// primary name is never duplicated as a separate chip.
describe('AttributionBadge primary removal', () => {
  const attributedRecord = (): TabSessionRecord =>
    record({
      currentAttribution: {
        workstreamId: 'ws-1',
        source: 'user_asserted',
        observedAt: '2026-08-16T00:00:00.000Z',
        clientEventId: 'evt-1',
      },
    });

  it('renders a "×" worded "Remove from <name>" for a real attribution when onRemove is wired', () => {
    const onRemove = vi.fn();
    render(
      <AttributionBadge record={attributedRecord()} workstreams={workstreams} onRemove={onRemove} />,
    );
    const removeButton = screen.getByRole('button', { name: 'Remove from Research' });
    expect(removeButton).toBeInTheDocument();
    fireEvent.click(removeButton);
    expect(onRemove).toHaveBeenCalledWith('ws-1');
  });

  it('renders no "×" when onRemove is omitted', () => {
    render(<AttributionBadge record={attributedRecord()} workstreams={workstreams} />);
    expect(screen.queryByRole('button', { name: /Remove from/ })).not.toBeInTheDocument();
  });

  it('renders no "×" for an empty (unfiled) badge even when onRemove is wired', () => {
    const onRemove = vi.fn();
    render(<AttributionBadge record={record()} workstreams={workstreams} onRemove={onRemove} />);
    expect(screen.queryByRole('button', { name: /Remove from/ })).not.toBeInTheDocument();
  });

  it('renders no "×" for a weak-guess/suggested badge — nothing filed yet to remove', () => {
    const onRemove = vi.fn();
    render(
      <AttributionBadge
        record={record()}
        suggestion={resolution({ action: 'inbox', margin: -0.62 }, [candidate()])}
        workstreams={workstreams}
        onRemove={onRemove}
      />,
    );
    expect(screen.queryByRole('button', { name: /Remove from/ })).not.toBeInTheDocument();
  });
});
