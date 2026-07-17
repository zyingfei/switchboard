import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AttributionProvenance } from './AttributionProvenance';
import type {
  TabSessionRecord,
  TabSessionResolutionResult,
  TabSessionResolverCandidate,
  TabSessionWorkstreamOption,
} from './types';

const workstreams: readonly TabSessionWorkstreamOption[] = [
  { bac_id: 'ws-1', path: 'Research / Probability' },
];

const record = (over: Partial<TabSessionRecord> = {}): TabSessionRecord => ({
  tabSessionId: 'tses_1',
  openedAt: '2026-07-13T00:00:00.000Z',
  lastActivityAt: '2026-07-13T00:00:00.000Z',
  latestUrl: 'https://www.janestreet.com/probability-markets/',
  attributionHistory: [],
  ...over,
});

const candidate = (
  over: Partial<TabSessionResolverCandidate> = {},
): TabSessionResolverCandidate => ({
  workstreamId: 'ws-1',
  rawFusionLogit: 1.2,
  dominantSource: 'ppr',
  reasons: [{ source: 'ppr', summary: 'Signed graph score 0.5', anchors: [] }],
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

describe('AttributionProvenance honesty', () => {
  it('renders an endorsed suggestion with the "Suggested" verb', () => {
    render(
      <AttributionProvenance
        record={record()}
        suggestion={resolution({ action: 'suggest', workstreamId: 'ws-1', margin: 0.9 }, [
          candidate(),
        ])}
        workstreams={workstreams}
      />,
    );
    expect(screen.getByText('Suggested')).toBeDefined();
    expect(screen.queryByText('Weak guess — filed to inbox')).toBeNull();
  });

  it('renders an un-endorsed (inbox) pick as a weak guess, never a suggestion', () => {
    const { container } = render(
      <AttributionProvenance
        record={record()}
        suggestion={resolution({ action: 'inbox', margin: -0.62 }, [candidate()])}
        workstreams={workstreams}
      />,
    );
    expect(screen.getByText('Weak guess — filed to inbox')).toBeDefined();
    expect(screen.queryByText('Suggested')).toBeNull();
    expect(container.querySelector('[data-endorsement="weak-guess"]')).not.toBeNull();
  });

  it('renders a graph-proximity reason chip for a ppr candidate', () => {
    render(
      <AttributionProvenance
        record={record()}
        suggestion={resolution({ action: 'suggest', workstreamId: 'ws-1', margin: 0.9 }, [
          candidate(),
        ])}
        workstreams={workstreams}
      />,
    );
    expect(screen.getByText('via graph proximity')).toBeDefined();
  });

  it('splits similarity into title vs content chip by page-evidence vector', () => {
    const simCandidate = candidate({
      dominantSource: 'similarity',
      reasons: [{ source: 'similarity', summary: 'Similarity top 0.7', anchors: [] }],
    });
    const { rerender } = render(
      <AttributionProvenance
        record={record({ pageEvidence: { tier: 'metadata' } })}
        suggestion={resolution({ action: 'suggest', workstreamId: 'ws-1', margin: 0.9 }, [
          simCandidate,
        ])}
        workstreams={workstreams}
      />,
    );
    expect(screen.getByText('title match')).toBeDefined();

    rerender(
      <AttributionProvenance
        record={record({
          pageEvidence: {
            tier: 'full',
            vector: { modelId: 'm', modelVersion: '1', dimensions: 384 },
          },
        })}
        suggestion={resolution({ action: 'suggest', workstreamId: 'ws-1', margin: 0.9 }, [
          simCandidate,
        ])}
        workstreams={workstreams}
      />,
    );
    expect(screen.getByText('content match')).toBeDefined();
  });

  it('shows the aggregator quiet line for a broad-site record with no candidates', () => {
    render(
      <AttributionProvenance
        record={record({ latestUrl: 'https://news.ycombinator.com/item?id=41800699' })}
        suggestion={resolution({ action: 'inbox', margin: 0 }, [])}
        workstreams={workstreams}
      />,
    );
    expect(screen.getByText('Broad site — waiting for stronger evidence')).toBeDefined();
  });

  it('falls back to plain "No attribution" for an ordinary site with no candidates', () => {
    render(
      <AttributionProvenance
        record={record({ latestUrl: 'https://www.janestreet.com/probability-markets/' })}
        suggestion={resolution({ action: 'inbox', margin: 0 }, [])}
        workstreams={workstreams}
      />,
    );
    expect(screen.getByText('No attribution')).toBeDefined();
  });
});
