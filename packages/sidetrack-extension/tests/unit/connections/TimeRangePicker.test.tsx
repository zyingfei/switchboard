import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  TimeRangePicker,
  filterByTimeRange,
  type TimeRangeValue,
} from '../../../src/sidepanel/connections/TimeRangePicker';
import type { ConnectionEdge, ConnectionNode } from '../../../src/sidepanel/connections/types';

const NOW = Date.parse('2026-05-12T20:00:00.000Z');

const node = (input: {
  readonly id: string;
  readonly lastSeenAt?: string;
}): ConnectionNode => ({
  id: input.id,
  kind: 'visit-instance',
  label: '',
  originReplicaIds: [],
  metadata: {},
  ...(input.lastSeenAt === undefined ? {} : { lastSeenAt: input.lastSeenAt }),
});

const edge = (id: string, from: string, to: string): ConnectionEdge => ({
  id,
  kind: 'visit_observed_on_replica',
  fromNodeId: from,
  toNodeId: to,
  observedAt: '2026-05-12T19:00:00.000Z',
  producedBy: { source: 'event-log' },
  confidence: 'observed',
});

describe('filterByTimeRange (TimeRangePicker)', () => {
  it('all-kind returns input unchanged', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })];
    const out = filterByTimeRange(nodes, [], { kind: 'all' }, { nowMs: NOW });
    expect(out.nodes).toBe(nodes);
  });

  it('preset 1h is tighter than preset 24h', () => {
    const nodes = [
      node({ id: 'm45', lastSeenAt: '2026-05-12T19:15:00.000Z' }), // 45m ago
      node({ id: 'h6', lastSeenAt: '2026-05-12T14:00:00.000Z' }), // 6h ago
    ];
    const within1h = filterByTimeRange(nodes, [], { kind: 'preset', preset: '1h' }, { nowMs: NOW });
    const within24h = filterByTimeRange(
      nodes,
      [],
      { kind: 'preset', preset: '24h' },
      { nowMs: NOW },
    );
    expect(within1h.nodes.map((n) => n.id)).toEqual(['m45']);
    expect(within24h.nodes.map((n) => n.id).sort()).toEqual(['h6', 'm45']);
  });

  it('custom range honors start + end inclusively', () => {
    const nodes = [
      node({ id: 'pre', lastSeenAt: '2026-05-10T00:00:00.000Z' }),
      node({ id: 'mid', lastSeenAt: '2026-05-11T12:00:00.000Z' }),
      node({ id: 'post', lastSeenAt: '2026-05-13T00:00:00.000Z' }),
    ];
    const out = filterByTimeRange(
      nodes,
      [],
      {
        kind: 'custom',
        startMs: Date.parse('2026-05-11T00:00:00.000Z'),
        endMs: Date.parse('2026-05-12T00:00:00.000Z'),
      },
      { nowMs: NOW },
    );
    expect(out.nodes.map((n) => n.id)).toEqual(['mid']);
  });

  it('preset window keeps the anchor even when its lastSeenAt is outside', () => {
    const nodes = [
      node({ id: 'anchor', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
      node({ id: 'fresh', lastSeenAt: '2026-05-12T19:15:00.000Z' }),
    ];
    const out = filterByTimeRange(
      nodes,
      [],
      { kind: 'preset', preset: '1h' },
      { nowMs: NOW, anchorId: 'anchor' },
    );
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['anchor', 'fresh']);
  });
});

describe('TimeRangePicker', () => {
  it('changes value to a preset when the user clicks one', () => {
    const onChange = vi.fn();
    render(<TimeRangePicker value={{ kind: 'all' }} onChange={onChange} nowMs={NOW} />);
    fireEvent.click(screen.getByTestId('connections-timerange-24h'));
    expect(onChange).toHaveBeenCalledWith({ kind: 'preset', preset: '24h' });
  });

  it('opens the custom popover and applies a valid range', () => {
    const onChange = vi.fn();
    render(<TimeRangePicker value={{ kind: 'all' }} onChange={onChange} nowMs={NOW} />);
    fireEvent.click(screen.getByTestId('connections-timerange-custom'));
    expect(screen.getByTestId('connections-timerange-popover')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('connections-timerange-start'), {
      target: { value: '2026-05-10T08:00' },
    });
    fireEvent.change(screen.getByTestId('connections-timerange-end'), {
      target: { value: '2026-05-11T08:00' },
    });
    fireEvent.click(screen.getByTestId('connections-timerange-apply'));
    expect(onChange).toHaveBeenCalled();
    const arg = onChange.mock.calls[0][0] as TimeRangeValue;
    expect(arg.kind).toBe('custom');
  });

  it('rejects an invalid range (start ≥ end) with an inline error', () => {
    const onChange = vi.fn();
    render(<TimeRangePicker value={{ kind: 'all' }} onChange={onChange} nowMs={NOW} />);
    fireEvent.click(screen.getByTestId('connections-timerange-custom'));
    fireEvent.change(screen.getByTestId('connections-timerange-start'), {
      target: { value: '2026-05-11T08:00' },
    });
    fireEvent.change(screen.getByTestId('connections-timerange-end'), {
      target: { value: '2026-05-10T08:00' },
    });
    fireEvent.click(screen.getByTestId('connections-timerange-apply'));
    expect(screen.getByTestId('connections-timerange-error')).toHaveTextContent('Start must be before end.');
    expect(onChange).not.toHaveBeenCalled();
  });
});
