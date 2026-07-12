import { describe, expect, it } from 'vitest';

import { USER_FLOW_CONFIRMED, USER_FLOW_REJECTED } from '../../feedback/events.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import type { ConnectionEdge, ConnectionsSnapshot } from '../types.js';
import { buildAcceptedUserSignal, computeConnectionsPrecision } from './connectionsPrecision.js';

const node = (id: string): string => `timeline-visit:${id}`;

const simEdge = (
  from: string,
  to: string,
  tier: string | undefined,
  kind: 'closest_visit' | 'visit_resembles_visit' = 'visit_resembles_visit',
): ConnectionEdge => ({
  id: `edge:${kind}:${node(from)}:${node(to)}`,
  kind,
  fromNodeId: node(from),
  toNodeId: node(to),
  observedAt: '2026-05-08T16:00:00.000Z',
  producedBy: { source: 'visit-similarity', revisionId: 'rev-1' },
  confidence: 'inferred',
  family: 'urlmatch',
  ...(tier === undefined ? {} : { metadata: { evidenceTier: tier } }),
});

const snapshotWith = (edges: readonly ConnectionEdge[]): ConnectionsSnapshot => ({
  scope: {},
  nodes: [],
  edges,
  updatedAt: '2026-05-08T16:00:00.000Z',
  nodeCount: 0,
  edgeCount: edges.length,
});

const flowEvent = (
  seq: number,
  type: typeof USER_FLOW_CONFIRMED | typeof USER_FLOW_REJECTED,
  from: string,
  to: string,
  acceptedAtMs: number,
): AcceptedEvent => ({
  clientEventId: `flow-${String(seq)}`,
  dot: { replicaId: 'r', seq },
  deps: {},
  aggregateId: `agg-${String(seq)}`,
  type,
  payload: {
    payloadVersion: 1,
    relationKind: 'closest_visit',
    fromId: node(from),
    toId: node(to),
    ...(type === USER_FLOW_REJECTED ? { reason: 'not-related' } : {}),
  },
  acceptedAtMs,
});

describe('buildAcceptedUserSignal', () => {
  it('bins confirmed vs rejected pairs order-independently, latest-wins', () => {
    const merged: AcceptedEvent[] = [
      flowEvent(1, USER_FLOW_CONFIRMED, 'a', 'b', 100),
      // Reject a later than confirm on the same (order-flipped) pair → rejected.
      flowEvent(2, USER_FLOW_CONFIRMED, 'x', 'y', 100),
      flowEvent(3, USER_FLOW_REJECTED, 'y', 'x', 200),
    ];
    const signal = buildAcceptedUserSignal(merged);
    expect([...signal.confirmedPairs]).toEqual([`${node('a')} ${node('b')}`]);
    // (x,y) latest event is a reject → in rejectedPairs, not confirmed.
    expect(signal.rejectedPairs.has(`${node('x')} ${node('y')}`)).toBe(true);
    expect(signal.confirmedPairs.has(`${node('x')} ${node('y')}`)).toBe(false);
  });
});

describe('computeConnectionsPrecision', () => {
  it('reports precision by evidence tier over judged served edges — hand computed', () => {
    // Served similarity edges:
    //   content_vector: (a,b) confirmed [TP], (c,d) rejected [FP]     → 1/2
    //   metadata:       (e,f) confirmed [TP], (g,h) confirmed [TP]    → 2/2
    //   title_only:     (i,j) rejected  [FP]                          → 0/1
    //   title_only:     (k,l) UNJUDGED (no signal) — served, not judged.
    //   unknown tier:   (m,n) confirmed [TP]                          → 1/1
    const edges = [
      simEdge('a', 'b', 'content_vector'),
      simEdge('c', 'd', 'content_vector'),
      simEdge('e', 'f', 'metadata'),
      simEdge('g', 'h', 'metadata', 'closest_visit'),
      simEdge('i', 'j', 'title_only'),
      simEdge('k', 'l', 'title_only'),
      simEdge('m', 'n', undefined),
    ];
    const merged: AcceptedEvent[] = [
      flowEvent(1, USER_FLOW_CONFIRMED, 'a', 'b', 10),
      flowEvent(2, USER_FLOW_REJECTED, 'c', 'd', 20),
      flowEvent(3, USER_FLOW_CONFIRMED, 'e', 'f', 30),
      flowEvent(4, USER_FLOW_CONFIRMED, 'g', 'h', 40),
      flowEvent(5, USER_FLOW_REJECTED, 'i', 'j', 50),
      flowEvent(6, USER_FLOW_CONFIRMED, 'm', 'n', 60),
    ];
    const signal = buildAcceptedUserSignal(merged);
    const report = computeConnectionsPrecision(snapshotWith(edges), signal);

    expect(report.totalServedSimilarityEdges).toBe(7);
    expect(report.judgedServedEdges).toBe(6); // (k,l) is unjudged.
    expect(report.confirmedSignalPairs).toBe(4);
    expect(report.rejectedSignalPairs).toBe(2);

    const byTier = Object.fromEntries(report.byTier.map((tier) => [tier.tier, tier]));
    expect(byTier['content_vector']!.precision).toBeCloseTo(0.5, 12);
    expect(byTier['content_vector']!.servedCount).toBe(2);
    expect(byTier['metadata']!.precision).toBe(1);
    expect(byTier['metadata']!.judgedCount).toBe(2);
    expect(byTier['title_only']!.precision).toBe(0);
    expect(byTier['title_only']!.judgedCount).toBe(1);
    expect(byTier['title_only']!.servedCount).toBe(2); // includes the unjudged (k,l).
    expect(byTier['unknown']!.precision).toBe(1);

    // Overall = TP(1+2+0+1) / judged(6) = 4/6.
    expect(report.overallPrecision).toBeCloseTo(4 / 6, 12);
  });

  it('reports null precision (not zero) for a tier with no judged edges', () => {
    const edges = [simEdge('a', 'b', 'content_vector')];
    const report = computeConnectionsPrecision(snapshotWith(edges), {
      confirmedPairs: new Set(),
      rejectedPairs: new Set(),
    });
    const byTier = Object.fromEntries(report.byTier.map((tier) => [tier.tier, tier]));
    expect(byTier['content_vector']!.precision).toBeNull();
    expect(report.overallPrecision).toBeNull();
  });

  it('ignores non-served-similarity edges and asserted/observed edges', () => {
    const containEdge: ConnectionEdge = {
      id: 'edge:thread_in_workstream:a:b',
      kind: 'thread_in_workstream',
      fromNodeId: node('a'),
      toNodeId: node('b'),
      observedAt: '2026-05-08T16:00:00.000Z',
      producedBy: { source: 'event-log' },
      confidence: 'observed',
    };
    const report = computeConnectionsPrecision(snapshotWith([containEdge]), {
      confirmedPairs: new Set([`${node('a')} ${node('b')}`]),
      rejectedPairs: new Set(),
    });
    expect(report.totalServedSimilarityEdges).toBe(0);
    expect(report.overallPrecision).toBeNull();
  });
});
