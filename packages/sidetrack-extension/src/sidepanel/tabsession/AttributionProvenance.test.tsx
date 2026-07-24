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

  // --- Auto-file provenance (the user's ask): when the resolver auto-applied
  // an attribution (currentAttribution.source='inferred'), make WHERE it came
  // from + HOW confident explicit — in plain words — instead of a bare
  // "Attributed by Sidetrack".
  describe('auto-file provenance (inferred attribution)', () => {
    const inferredRecord = (): TabSessionRecord =>
      record({
        currentAttribution: {
          workstreamId: 'ws-1',
          source: 'inferred',
          observedAt: '2026-07-24T00:00:00.000Z',
          clientEventId: 'evt_1',
        },
      });

    it('says "Auto-filed" with the plain-word source (similarity → similar pages)', () => {
      render(
        <AttributionProvenance
          record={inferredRecord()}
          suggestion={resolution({ action: 'auto-apply', workstreamId: 'ws-1', margin: 1.2 }, [
            candidate({
              dominantSource: 'similarity',
              rawFusionLogit: 2.5,
              reasons: [{ source: 'similarity', summary: 'Similarity top 0.9', anchors: [] }],
            }),
          ])}
          workstreams={workstreams}
        />,
      );
      expect(screen.getByText('Auto-filed')).toBeDefined();
      // Plain words, not the jargon enum "similarity".
      expect(screen.getByText(/similar pages/)).toBeDefined();
      expect(screen.queryByText(/Attributed by Sidetrack/)).toBeNull();
    });

    it('maps ppr → "browsing path" and cluster → "topic"', () => {
      const { rerender } = render(
        <AttributionProvenance
          record={inferredRecord()}
          suggestion={resolution({ action: 'auto-apply', workstreamId: 'ws-1', margin: 1.2 }, [
            candidate({ dominantSource: 'ppr', rawFusionLogit: 2.5 }),
          ])}
          workstreams={workstreams}
        />,
      );
      expect(screen.getByText(/browsing path/)).toBeDefined();

      rerender(
        <AttributionProvenance
          record={inferredRecord()}
          suggestion={resolution({ action: 'auto-apply', workstreamId: 'ws-1', margin: 1.2 }, [
            candidate({
              dominantSource: 'cluster',
              rawFusionLogit: 2.5,
              reasons: [{ source: 'cluster', summary: 'Topic 0.8', anchors: [] }],
            }),
          ])}
          workstreams={workstreams}
        />,
      );
      // "· topic" is the plain-word source span (the reason chip says
      // "topic cluster"); assert the source span specifically.
      expect(screen.getByText('· topic')).toBeDefined();
    });

    it('shows a coarse confidence word (High for a strong logit), never a raw %', () => {
      const { container } = render(
        <AttributionProvenance
          record={inferredRecord()}
          suggestion={resolution({ action: 'auto-apply', workstreamId: 'ws-1', margin: 1.2 }, [
            // sigmoid(2.5) ≈ 0.924 → High
            candidate({ dominantSource: 'similarity', rawFusionLogit: 2.5 }),
          ])}
          workstreams={workstreams}
        />,
      );
      expect(screen.getByText(/High confidence/)).toBeDefined();
      // The uncalibrated raw % must not leak onto the card.
      expect(container.textContent).not.toMatch(/9\d%/);
    });

    it('marks the row as reversible in the tooltip', () => {
      const { container } = render(
        <AttributionProvenance
          record={inferredRecord()}
          suggestion={resolution({ action: 'auto-apply', workstreamId: 'ws-1', margin: 1.2 }, [
            candidate({ dominantSource: 'similarity', rawFusionLogit: 2.5 }),
          ])}
          workstreams={workstreams}
        />,
      );
      const row = container.querySelector('[data-attribution-source="inferred"]');
      expect(row).not.toBeNull();
      expect(row?.getAttribute('title')).toMatch(/Reversible/);
    });

    it('degrades gracefully to just "Auto-filed" when the resolver result is gone', () => {
      // The resolve cache can be evicted after the auto-apply; the label +
      // "Auto-filed" verb must still render (no crash, no bare bac_id).
      render(
        <AttributionProvenance record={inferredRecord()} workstreams={workstreams} />,
      );
      expect(screen.getByText('Auto-filed')).toBeDefined();
      expect(screen.getByText(/Research \/ Probability/)).toBeDefined();
    });

    it('keeps the plain "Attributed by you" line for a user-asserted move', () => {
      render(
        <AttributionProvenance
          record={record({
            currentAttribution: {
              workstreamId: 'ws-1',
              source: 'user_asserted',
              observedAt: '2026-07-24T00:00:00.000Z',
              clientEventId: 'evt_2',
            },
          })}
          workstreams={workstreams}
        />,
      );
      expect(screen.getByText(/Attributed by you/)).toBeDefined();
      expect(screen.queryByText('Auto-filed')).toBeNull();
    });
  });
});
