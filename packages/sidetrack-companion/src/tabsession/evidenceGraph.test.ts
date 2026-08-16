import { describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot } from '../connections/types.js';
import { buildEvidenceGraph } from './evidenceGraph.js';

// PERF (2026-08-16) — buildEvidenceGraph memoization. A batch-resolve request
// reuses ONE snapshot object reference across every miss URL in the batch
// (server.ts pins `missedSnapshot` once — see readResolverSubgraphForUrls),
// so a WeakMap keyed on that object identity turns N graph rebuilds into one.
// Object identity is the ONLY correctness boundary here (see the comment on
// evidenceGraphCache in evidenceGraph.ts) — no time-based invalidation.
const buildSnapshot = (revisionSuffix: string): ConnectionsSnapshot => ({
  scope: {},
  nodes: [
    {
      id: 'timeline-visit:a',
      kind: 'timeline-visit',
      label: 'A',
      originReplicaIds: [],
      metadata: {},
    },
    { id: 'workstream:w1', kind: 'workstream', label: 'W1', originReplicaIds: [], metadata: {} },
  ],
  edges: [
    {
      id: `edge:visit_in_workstream:${revisionSuffix}`,
      kind: 'visit_in_workstream',
      fromNodeId: 'timeline-visit:a',
      toNodeId: 'workstream:w1',
      observedAt: '2026-06-01T00:00:00.000Z',
      producedBy: { source: 'event-log' },
      confidence: 'observed',
    },
  ],
  updatedAt: '2026-06-01T00:00:00.000Z',
  nodeCount: 2,
  edgeCount: 1,
});

describe('buildEvidenceGraph memoization', () => {
  it('returns the SAME EvidenceGraph instance for the same snapshot object', () => {
    const snapshot = buildSnapshot('same');

    const first = buildEvidenceGraph(snapshot);
    const second = buildEvidenceGraph(snapshot);

    expect(second).toBe(first); // object identity — proves the cache hit, not just equal content
    expect(second.graph).toBe(first.graph);
    expect(second.adjacency).toBe(first.adjacency);
  });

  it('rebuilds for a DIFFERENT snapshot object, even with identical content', () => {
    // Two independently-constructed snapshots with byte-identical fields —
    // content equality must NOT be mistaken for the cache key. Only object
    // identity may hit the cache.
    const snapshotA = buildSnapshot('dup');
    const snapshotB = buildSnapshot('dup');

    const fromA = buildEvidenceGraph(snapshotA);
    const fromB = buildEvidenceGraph(snapshotB);

    expect(fromB).not.toBe(fromA);
    // Content is still equivalent — the rebuild is a distinct object with
    // the same shape, not a divergent one.
    expect(fromB.revision).toBe(fromA.revision);
    expect(fromB.graph.order).toBe(fromA.graph.order);
    expect(fromB.graph.size).toBe(fromA.graph.size);

    // The first snapshot's entry is unaffected by building the second.
    expect(buildEvidenceGraph(snapshotA)).toBe(fromA);
  });
});
