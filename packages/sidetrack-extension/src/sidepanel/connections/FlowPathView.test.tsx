import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  FlowPathView,
  type FlowSummary,
  type TabSessionInfo,
  type TimelineVisit,
} from './FlowPathView';

const visits: readonly TimelineVisit[] = [
  {
    id: 'visit:1',
    label: 'Visit 1',
    commitTimestamp: '2026-05-08T10:00:00.000Z',
    tabSessionIdHash: 'tab-a',
    engagementClass: 'glanced',
  },
  {
    id: 'visit:2',
    label: 'Visit 2',
    commitTimestamp: '2026-05-08T10:05:00.000Z',
    tabSessionIdHash: 'tab-a',
    engagementClass: 'engaged_read',
  },
  {
    id: 'visit:3',
    label: 'Visit 3',
    commitTimestamp: '2026-05-08T10:10:00.000Z',
    tabSessionIdHash: 'tab-a',
  },
  {
    id: 'visit:4',
    label: 'Visit 4',
    commitTimestamp: '2026-05-08T11:00:00.000Z',
    tabSessionIdHash: 'tab-b',
  },
  {
    id: 'visit:5',
    label: 'Visit 5',
    commitTimestamp: '2026-05-08T11:05:00.000Z',
    tabSessionIdHash: 'tab-b',
  },
  {
    id: 'visit:6',
    label: 'Visit 6',
    commitTimestamp: '2026-05-08T11:10:00.000Z',
    tabSessionIdHash: 'tab-b',
  },
];

describe('FlowPathView', () => {
  it('renders all visits with arrows between same-tab neighbors', () => {
    render(
      <FlowPathView
        visits={visits}
        navigationEdges={[
          { id: 'e1', fromVisitId: 'visit:1', toVisitId: 'visit:2', kind: 'previousVisitId' },
          { id: 'e2', fromVisitId: 'visit:2', toVisitId: 'visit:3', kind: 'previousVisitId' },
          { id: 'e3', fromVisitId: 'visit:4', toVisitId: 'visit:5', kind: 'previousVisitId' },
          { id: 'e4', fromVisitId: 'visit:5', toVisitId: 'visit:6', kind: 'previousVisitId' },
        ]}
        crossReplicaEdges={[]}
        onNodeClick={() => undefined}
      />,
    );

    expect(screen.getAllByTestId(/^flow-visit-/u)).toHaveLength(6);
    expect(screen.getByText('Tab 1')).toBeDefined();
    expect(screen.getByText('Tab 2')).toBeDefined();
    // Same-tab navigation now renders as → arrows between visits;
    // each tab has (N-1) arrows for N visits, so 2 + 2 = 4.
    const arrows = screen.getAllByText('→');
    expect(arrows).toHaveLength(4);
  });

  it('renders opener badge between tabs', () => {
    render(
      <FlowPathView
        visits={visits}
        navigationEdges={[
          { id: 'op1', fromVisitId: 'visit:3', toVisitId: 'visit:4', kind: 'openerVisitId' },
        ]}
        crossReplicaEdges={[]}
        onNodeClick={() => undefined}
      />,
    );

    expect(screen.getByText(/opened from Tab 1/u)).toBeDefined();
  });

  it('renders cross-replica edges dashed', () => {
    render(
      <FlowPathView
        visits={visits.slice(0, 1)}
        navigationEdges={[]}
        crossReplicaEdges={[{ id: 'xr1', fromVisitId: 'visit:1', replicaId: 'replica-b' }]}
        onNodeClick={() => undefined}
      />,
    );

    expect(screen.getByTestId('flow-cross-replica-edge-xr1').className).toContain(
      'cx-edge-cross-replica',
    );
  });

  it('renders duration when focusedWindowMs is provided', () => {
    render(
      <FlowPathView
        visits={[
          {
            id: 'visit:1',
            label: 'Visit 1',
            commitTimestamp: '2026-05-08T10:00:00.000Z',
            tabSessionIdHash: 'tab-a',
            focusedWindowMs: 90_000,
          },
        ]}
        navigationEdges={[]}
        crossReplicaEdges={[]}
        onNodeClick={() => undefined}
      />,
    );

    expect(screen.getByText('1m 30s')).toBeDefined();
  });

  it('fires onNodeClick with the visit id', () => {
    const onNodeClick = vi.fn();
    render(
      <FlowPathView
        visits={visits.slice(0, 1)}
        navigationEdges={[]}
        crossReplicaEdges={[]}
        onNodeClick={onNodeClick}
      />,
    );

    fireEvent.click(screen.getByTestId('flow-visit-visit:1'));
    expect(onNodeClick).toHaveBeenCalledWith('visit:1');
  });

  it('renders the anchor lifecycle summary strip', () => {
    const summary: FlowSummary = {
      visitCount: 3,
      tabCount: 3,
      firstSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      replicaAliases: ['Browser 2'],
    };
    render(
      <FlowPathView
        visits={visits}
        navigationEdges={[]}
        crossReplicaEdges={[]}
        onNodeClick={() => undefined}
        summary={summary}
      />,
    );
    const strip = screen.getByTestId('flow-path-summary');
    expect(strip.textContent).toContain('Visited 3 times across 3 tabs');
    expect(strip.textContent).toContain('also on Browser 2');
  });

  it('uses tabSessions.get(hash).label and renders a time description for the column header', () => {
    const tabSessions = new Map<string, TabSessionInfo>([
      [
        'tab-a',
        {
          label: 'Sidetrack PRs',
          host: 'github.com',
          firstSeenAt: '2026-05-08T09:59:46.000Z',
          lastActivityAt: '2026-05-08T10:00:00.000Z',
          lifespanMs: 14_000,
        },
      ],
    ]);
    render(
      <FlowPathView
        visits={visits.slice(0, 1)}
        navigationEdges={[]}
        crossReplicaEdges={[]}
        onNodeClick={() => undefined}
        tabSessions={tabSessions}
      />,
    );
    expect(screen.getByText('Sidetrack PRs')).toBeDefined();
    expect(screen.getByText('github.com')).toBeDefined();
    expect(screen.getByText(/14s · 1 visit/u)).toBeDefined();
  });

  it('renders the empty-chain placeholder for a solo anchor', () => {
    render(
      <FlowPathView
        visits={[
          {
            id: 'visit:anchor',
            label: 'Just this page',
            commitTimestamp: '2026-05-08T10:00:00.000Z',
            tabSessionIdHash: 'tab-a',
            isAnchor: true,
          },
        ]}
        navigationEdges={[]}
        crossReplicaEdges={[]}
        onNodeClick={() => undefined}
      />,
    );
    expect(screen.getByTestId('flow-tab-placeholder-tab-a').textContent).toContain(
      'Direct visit — no prior page in this tab',
    );
  });

  it('renders Before / After segment labels around the anchor', () => {
    render(
      <FlowPathView
        visits={[
          {
            id: 'visit:1',
            label: 'Before page',
            commitTimestamp: '2026-05-08T10:00:00.000Z',
            tabSessionIdHash: 'tab-a',
          },
          {
            id: 'visit:2',
            label: 'Anchor page',
            commitTimestamp: '2026-05-08T10:05:00.000Z',
            tabSessionIdHash: 'tab-a',
            isAnchor: true,
          },
          {
            id: 'visit:3',
            label: 'After page',
            commitTimestamp: '2026-05-08T10:10:00.000Z',
            tabSessionIdHash: 'tab-a',
          },
        ]}
        navigationEdges={[]}
        crossReplicaEdges={[]}
        onNodeClick={() => undefined}
      />,
    );
    expect(screen.getByText('Before')).toBeDefined();
    expect(screen.getByText('After')).toBeDefined();
  });

  it('renders provider chip, engagement label, and visitCount on a cell', () => {
    render(
      <FlowPathView
        visits={[
          {
            id: 'visit:1',
            label: 'Some page',
            commitTimestamp: '2026-05-08T10:00:00.000Z',
            tabSessionIdHash: 'tab-a',
            provider: 'chatgpt',
            engagementClass: 'engaged_read',
            visitCount: 5,
          },
        ]}
        navigationEdges={[]}
        crossReplicaEdges={[]}
        onNodeClick={() => undefined}
      />,
    );
    expect(screen.getByText('ChatGPT')).toBeDefined();
    expect(screen.getByText('Read')).toBeDefined();
    expect(screen.getByText('· 5 visits')).toBeDefined();
  });

  it('renders the search-query prefix when set', () => {
    render(
      <FlowPathView
        visits={[
          {
            id: 'visit:1',
            label: 'Search results',
            commitTimestamp: '2026-05-08T10:00:00.000Z',
            tabSessionIdHash: 'tab-a',
            searchQuery: 'react hooks tutorial',
          },
        ]}
        navigationEdges={[]}
        crossReplicaEdges={[]}
        onNodeClick={() => undefined}
      />,
    );
    expect(screen.getByText(/q: react hooks tutorial/u)).toBeDefined();
  });

  it('keeps same-title tabs as separate rows instead of grouping by canonical name', () => {
    const tabSessions = new Map<string, TabSessionInfo>([
      ['tab-a', { label: 'Google', host: 'www.google.com' }],
      ['tab-b', { label: 'Google', host: 'www.google.com' }],
    ]);
    render(
      <FlowPathView
        visits={[
          {
            id: 'visit:1',
            label: 'Google',
            commitTimestamp: '2026-05-08T10:00:00.000Z',
            tabSessionIdHash: 'tab-a',
          },
          {
            id: 'visit:2',
            label: 'Google',
            commitTimestamp: '2026-05-08T10:05:00.000Z',
            tabSessionIdHash: 'tab-b',
          },
        ]}
        navigationEdges={[]}
        crossReplicaEdges={[]}
        onNodeClick={() => undefined}
        tabSessions={tabSessions}
      />,
    );
    expect(screen.getAllByText('Google')).toHaveLength(4);
    expect(screen.getAllByText('www.google.com')).toHaveLength(2);
    expect(screen.queryByText('2 tabs aggregated')).toBeNull();
  });

  it('keeps surrounding tab rows around the inline You are here visit', () => {
    render(
      <FlowPathView
        visits={[
          {
            id: 'visit:old',
            label: 'Old page',
            commitTimestamp: '2026-05-08T09:00:00.000Z',
            tabSessionIdHash: 'tab-a',
          },
          {
            id: 'visit:anchor',
            label: 'Anchor page',
            commitTimestamp: '2026-05-08T10:00:00.000Z',
            tabSessionIdHash: 'tab-b',
            host: 'example.test',
            isAnchor: true,
          },
          {
            id: 'visit:later',
            label: 'Later page',
            commitTimestamp: '2026-05-08T11:00:00.000Z',
            tabSessionIdHash: 'tab-c',
          },
        ]}
        navigationEdges={[]}
        crossReplicaEdges={[]}
        onNodeClick={() => undefined}
      />,
    );
    expect(screen.queryByTestId('flow-path-anchor')).toBeNull();
    const oldVisit = screen.getByTestId('flow-visit-visit:old');
    const anchorVisit = screen.getByTestId('flow-visit-visit:anchor');
    const laterVisit = screen.getByTestId('flow-visit-visit:later');
    expect(anchorVisit).toHaveTextContent('You are here');
    expect(oldVisit.compareDocumentPosition(anchorVisit) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    expect(
      anchorVisit.compareDocumentPosition(laterVisit) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });
});
