import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TimelineRail } from '../../../src/sidepanel/connections/TimelineRail';
import type { TimelineRailData } from '../../../src/sidepanel/connections/timelineWindows';

describe('TimelineRail', () => {
  const baseData: TimelineRailData = {
    date: '2026-05-15',
    rangeLabel: 'May 15 · 9:00 AM-10:00 AM',
    scaleLabel: 'minutes',
    startMs: Date.parse('2026-05-15T16:00:00.000Z'),
    endMs: Date.parse('2026-05-15T17:00:00.000Z'),
    ticks: [
      { label: '9:00 AM', ms: Date.parse('2026-05-15T16:00:00.000Z') },
      { label: '9:15 AM', ms: Date.parse('2026-05-15T16:15:00.000Z') },
      { label: '9:30 AM', ms: Date.parse('2026-05-15T16:30:00.000Z') },
      { label: '9:45 AM', ms: Date.parse('2026-05-15T16:45:00.000Z') },
      { label: '10:00 AM', ms: Date.parse('2026-05-15T17:00:00.000Z') },
    ],
    rows: [
      {
        replicaId: 'replica:a',
        windows: [[Date.parse('2026-05-15T16:00:00.000Z'), Date.parse('2026-05-15T16:30:00.000Z')]],
      },
    ],
    anchorTime: Date.parse('2026-05-15T16:20:00.000Z'),
    neighborTimes: [Date.parse('2026-05-15T16:45:00.000Z')],
    markers: [
      {
        id: 'anchor:thread:t1',
        nodeId: 'thread:t1',
        timeMs: Date.parse('2026-05-15T16:20:00.000Z'),
        kind: 'anchor' as const,
        label: 'Anchor page',
      },
      {
        id: 'related:timeline-visit:https://example.test',
        nodeId: 'timeline-visit:https://example.test',
        timeMs: Date.parse('2026-05-15T16:45:00.000Z'),
        kind: 'related' as const,
        label: 'Related page',
      },
    ],
  };

  it('renders the activity legend', () => {
    render(
      <TimelineRail
        data={baseData}
        ctx={{
          resolveWorkstreamPath: () => null,
          replicaAlias: () => 'Browser',
        }}
      />,
    );

    expect(screen.getByLabelText('Timeline legend')).toBeDefined();
    expect(screen.getByText('Presence')).toBeDefined();
    expect(screen.getByText('Anchor')).toBeDefined();
    expect(screen.getByText('Related')).toBeDefined();
  });

  it('labels anchor and related markers on the rail', () => {
    render(
      <TimelineRail
        data={baseData}
        ctx={{
          resolveWorkstreamPath: () => null,
          replicaAlias: () => 'Browser',
        }}
      />,
    );

    expect(screen.getByTestId('timeline-marker-anchor').textContent).toBe('A');
    expect(
      screen.getByTestId('timeline-marker-related-timeline-visit:https://example.test').textContent,
    ).toBe('R');
  });

  it('reports marker hover so connected rows can highlight', () => {
    const onHoverNode = vi.fn();
    render(
      <TimelineRail
        data={baseData}
        ctx={{
          resolveWorkstreamPath: () => null,
          replicaAlias: () => 'Browser',
        }}
        onHoverNode={onHoverNode}
      />,
    );

    const marker = screen.getByTestId(
      'timeline-marker-related-timeline-visit:https://example.test',
    );
    fireEvent.mouseEnter(marker);
    expect(onHoverNode).toHaveBeenCalledWith('timeline-visit:https://example.test');
    fireEvent.mouseLeave(marker);
    expect(onHoverNode).toHaveBeenCalledWith(null);
  });
});
