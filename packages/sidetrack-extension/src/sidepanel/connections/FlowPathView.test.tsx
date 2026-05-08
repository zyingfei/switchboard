import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FlowPathView, type TimelineVisit } from './FlowPathView';

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
  it('renders all visits and navigation edges', () => {
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
    expect(screen.getAllByTestId(/^flow-nav-edge-/u)).toHaveLength(4);
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
});
