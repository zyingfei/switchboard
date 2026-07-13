import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AttributionBadge } from './AttributionBadge';
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
