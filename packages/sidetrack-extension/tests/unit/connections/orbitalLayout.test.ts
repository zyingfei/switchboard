import { describe, expect, it } from 'vitest';

import { computeOrbitalLayout } from '../../../src/sidepanel/connections/orbitalLayout';
import type { ConnectionEdge, ConnectionsSnapshot } from '../../../src/sidepanel/connections/types';

const mkEdge = (input: {
  id: string;
  kind: string;
  fromNodeId: string;
  toNodeId: string;
  observedAt?: string;
}): ConnectionEdge => ({
  id: input.id,
  kind: input.kind,
  fromNodeId: input.fromNodeId,
  toNodeId: input.toNodeId,
  observedAt: input.observedAt ?? '2026-05-14T10:00:00.000Z',
  producedBy: { source: 'event-log' },
  confidence: 'asserted',
});

const mkSnap = (overrides: Partial<ConnectionsSnapshot> = {}): ConnectionsSnapshot => ({
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: '2026-05-14T10:00:00.000Z',
  nodeCount: 0,
  edgeCount: 0,
  ...overrides,
});

describe('connections — computeOrbitalLayout', () => {
  it('places the anchor at the center', () => {
    const layout = computeOrbitalLayout({
      snapshot: mkSnap({ nodes: [{ id: 'thread:t1', kind: 'thread', label: 'A', originReplicaIds: [], metadata: {} }] }),
      anchorId: 'thread:t1',
      width: 760,
      height: 600,
    });
    const anchor = layout.positions.get('thread:t1')!;
    expect(anchor.ring).toBe(0);
    expect(anchor.x).toBe(380);
    expect(anchor.y).toBe(300);
    expect(anchor.family).toBeNull();
  });

  it('routes contain edges to the top sector and flow edges to the right sector', () => {
    const snap = mkSnap({
      edges: [
        mkEdge({ id: 'e1', kind: 'thread_in_workstream', fromNodeId: 'thread:t1', toNodeId: 'workstream:w1' }),
        mkEdge({ id: 'e2', kind: 'dispatch_from_thread', fromNodeId: 'dispatch:d1', toNodeId: 'thread:t1' }),
      ],
    });
    const layout = computeOrbitalLayout({
      snapshot: snap,
      anchorId: 'thread:t1',
      width: 800,
      height: 600,
    });
    const containNeighbor = layout.positions.get('workstream:w1')!;
    const flowNeighbor = layout.positions.get('dispatch:d1')!;
    // Top sector — y < center.y
    expect(containNeighbor.y).toBeLessThan(layout.center.y);
    expect(containNeighbor.family).toBe('contain');
    // Right sector — x > center.x
    expect(flowNeighbor.x).toBeGreaterThan(layout.center.x);
    expect(flowNeighbor.family).toBe('flow');
  });

  it('routes urlmatch edges to the left sector and defer edges to the bottom sector', () => {
    const snap = mkSnap({
      edges: [
        mkEdge({ id: 'eu', kind: 'thread_references_url', fromNodeId: 'thread:t1', toNodeId: 'timeline-visit:https://x' }),
        mkEdge({ id: 'ed', kind: 'queue_targets_thread', fromNodeId: 'queue-item:q1', toNodeId: 'thread:t1' }),
      ],
    });
    const layout = computeOrbitalLayout({
      snapshot: snap,
      anchorId: 'thread:t1',
      width: 800,
      height: 600,
    });
    const urlMatchNeighbor = layout.positions.get('timeline-visit:https://x')!;
    const deferNeighbor = layout.positions.get('queue-item:q1')!;
    expect(urlMatchNeighbor.x).toBeLessThan(layout.center.x);
    expect(urlMatchNeighbor.family).toBe('urlmatch');
    expect(deferNeighbor.y).toBeGreaterThan(layout.center.y);
    expect(deferNeighbor.family).toBe('defer');
  });

  it('is deterministic: same input → byte-identical positions across edge orders', () => {
    const edges = [
      mkEdge({ id: 'e1', kind: 'thread_in_workstream', fromNodeId: 'thread:t1', toNodeId: 'workstream:w1' }),
      mkEdge({ id: 'e2', kind: 'dispatch_from_thread', fromNodeId: 'dispatch:d1', toNodeId: 'thread:t1' }),
      mkEdge({ id: 'e3', kind: 'queue_targets_thread', fromNodeId: 'queue-item:q1', toNodeId: 'thread:t1' }),
    ];
    const fwd = computeOrbitalLayout({
      snapshot: mkSnap({ edges }),
      anchorId: 'thread:t1',
      width: 800,
      height: 600,
    });
    const rev = computeOrbitalLayout({
      snapshot: mkSnap({ edges: [...edges].reverse() }),
      anchorId: 'thread:t1',
      width: 800,
      height: 600,
    });
    const fwdSerialized = JSON.stringify([...fwd.positions.entries()]);
    const revSerialized = JSON.stringify([...rev.positions.entries()]);
    expect(revSerialized).toBe(fwdSerialized);
  });

  it('places second-hop neighbors on the outer ring when hops=2', () => {
    const snap = mkSnap({
      edges: [
        mkEdge({ id: 'e1', kind: 'thread_in_workstream', fromNodeId: 'thread:t1', toNodeId: 'workstream:w1' }),
        // workstream → child workstream (no anchor endpoint)
        mkEdge({
          id: 'e2',
          kind: 'workstream_parent_of',
          fromNodeId: 'workstream:w1',
          toNodeId: 'workstream:w_child',
        }),
      ],
    });
    const layout = computeOrbitalLayout({
      snapshot: snap,
      anchorId: 'thread:t1',
      width: 800,
      height: 600,
      hops: 2,
    });
    expect(layout.positions.get('workstream:w_child')?.ring).toBe(2);
    expect(layout.edges.length).toBe(2); // both edges have placed endpoints
  });

  it('hops=1 (default) excludes second-hop neighbors and their edges', () => {
    const snap = mkSnap({
      edges: [
        mkEdge({ id: 'e1', kind: 'thread_in_workstream', fromNodeId: 'thread:t1', toNodeId: 'workstream:w1' }),
        mkEdge({
          id: 'e2',
          kind: 'workstream_parent_of',
          fromNodeId: 'workstream:w1',
          toNodeId: 'workstream:w_child',
        }),
      ],
    });
    const layout = computeOrbitalLayout({
      snapshot: snap,
      anchorId: 'thread:t1',
      width: 800,
      height: 600,
      hops: 1,
    });
    expect(layout.positions.has('workstream:w_child')).toBe(false);
    // workstream:w1 is positioned, but the second edge to w_child has
    // an unpositioned endpoint → excluded from visible edges.
    expect(layout.edges.map((e) => e.id)).toEqual(['e1']);
  });
});
