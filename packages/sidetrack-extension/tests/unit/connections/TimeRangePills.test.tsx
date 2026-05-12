import { describe, expect, it } from 'vitest';

import { filterByTimeRange } from '../../../src/sidepanel/connections/TimeRangePills';
import type { ConnectionEdge, ConnectionNode } from '../../../src/sidepanel/connections/types';

const NOW = Date.parse('2026-05-12T20:00:00.000Z');

const node = (input: {
  readonly id: string;
  readonly kind?: ConnectionNode['kind'];
  readonly lastSeenAt?: string;
}): ConnectionNode => ({
  id: input.id,
  kind: input.kind ?? 'visit-instance',
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

describe('filterByTimeRange', () => {
  it('returns input unchanged for range = all', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })];
    const edges = [edge('e1', 'a', 'b')];
    const out = filterByTimeRange(nodes, edges, 'all', { nowMs: NOW });
    expect(out.nodes).toBe(nodes);
    expect(out.edges).toBe(edges);
    expect(out.hiddenNodeCount).toBe(0);
  });

  it('hides nodes whose lastSeenAt is older than the window', () => {
    const nodes = [
      node({ id: 'recent', lastSeenAt: '2026-05-12T15:00:00.000Z' }),
      node({ id: 'old', lastSeenAt: '2026-05-01T12:00:00.000Z' }),
    ];
    const edges = [edge('e1', 'recent', 'old')];
    const out = filterByTimeRange(nodes, edges, '24h', { nowMs: NOW });
    expect(out.nodes.map((n) => n.id)).toEqual(['recent']);
    expect(out.edges).toEqual([]); // edge drops because endpoint went away
    expect(out.hiddenNodeCount).toBe(1);
    expect(out.hiddenEdgeCount).toBe(1);
  });

  it('keeps nodes without lastSeenAt (no time signal)', () => {
    const nodes = [
      node({ id: 'recent', lastSeenAt: '2026-05-12T19:00:00.000Z' }),
      node({ id: 'undated' }),
    ];
    const out = filterByTimeRange(nodes, [], '24h', { nowMs: NOW });
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['recent', 'undated']);
  });

  it('keeps the anchor even when its lastSeenAt is outside the window', () => {
    const nodes = [
      node({ id: 'anchor', lastSeenAt: '2026-01-01T00:00:00.000Z' }),
      node({ id: 'fresh', lastSeenAt: '2026-05-12T15:00:00.000Z' }),
    ];
    const out = filterByTimeRange(nodes, [], '24h', { nowMs: NOW, anchorId: 'anchor' });
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['anchor', 'fresh']);
  });

  it('30d window admits nodes older than 7d but within a month', () => {
    const nodes = [
      node({ id: 'd5', lastSeenAt: '2026-05-07T20:00:00.000Z' }), // 5 days ago
      node({ id: 'd25', lastSeenAt: '2026-04-17T20:00:00.000Z' }), // 25 days ago
      node({ id: 'd35', lastSeenAt: '2026-04-07T20:00:00.000Z' }), // 35 days ago
    ];
    const out = filterByTimeRange(nodes, [], '30d', { nowMs: NOW });
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['d25', 'd5']);
  });
});
