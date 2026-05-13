import { describe, expect, it } from 'vitest';

import { computeTimelineRail } from '../../../src/sidepanel/connections/timelineWindows';
import type { ConnectionsSnapshot } from '../../../src/sidepanel/connections/types';

const baseSnap = (
  overrides: Partial<ConnectionsSnapshot> = {},
): ConnectionsSnapshot => ({
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: '2026-05-14T15:00:00.000Z',
  nodeCount: 0,
  edgeCount: 0,
  ...overrides,
});

describe('connections — computeTimelineRail', () => {
  it('returns null when no event-log edges have a dot', () => {
    expect(computeTimelineRail(baseSnap(), 'thread:t1')).toBeNull();
  });

  it('clusters within-30min edges into a single window per replica', () => {
    const snap = baseSnap({
      edges: [
        {
          id: 'e1',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: '2026-05-14T09:10:00.000Z',
          producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 1 } },
          confidence: 'asserted',
        },
        {
          id: 'e2',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: '2026-05-14T09:25:00.000Z',
          producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 2 } },
          confidence: 'asserted',
        },
      ],
    });
    const rail = computeTimelineRail(snap, 'thread:t1');
    expect(rail).not.toBeNull();
    expect(rail!.rows.length).toBe(1);
    expect(rail!.rows[0]!.replicaId).toBe('mac');
    expect(rail!.rows[0]!.windows.length).toBe(1);
    const [a, b] = rail!.rows[0]!.windows[0]!;
    expect(a).toBeCloseTo(9 + 10 / 60, 3);
    expect(b).toBeCloseTo(9 + 25 / 60, 3);
  });

  it('splits a >30min gap into separate windows', () => {
    const snap = baseSnap({
      edges: [
        {
          id: 'e1',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: '2026-05-14T09:00:00.000Z',
          producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 1 } },
          confidence: 'asserted',
        },
        {
          id: 'e2',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: '2026-05-14T11:00:00.000Z',
          producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 2 } },
          confidence: 'asserted',
        },
      ],
    });
    const rail = computeTimelineRail(snap, 'thread:t1');
    expect(rail!.rows[0]!.windows.length).toBe(2);
  });

  it('groups edges by replicaId — distinct rows per replica', () => {
    const snap = baseSnap({
      edges: [
        {
          id: 'e1',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: '2026-05-14T09:00:00.000Z',
          producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 1 } },
          confidence: 'asserted',
        },
        {
          id: 'e2',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: '2026-05-14T10:30:00.000Z',
          producedBy: { source: 'event-log', dot: { replicaId: 'pc', seq: 5 } },
          confidence: 'asserted',
        },
      ],
    });
    const rail = computeTimelineRail(snap, 'thread:t1');
    const ids = rail!.rows.map((r) => r.replicaId);
    expect(ids).toEqual(['mac', 'pc']);
  });

  it('skips vault-derived edges that lack a dot', () => {
    const snap = baseSnap({
      edges: [
        {
          id: 'e_vault',
          kind: 'dispatch_in_workstream',
          fromNodeId: 'dispatch:d1',
          toNodeId: 'workstream:w1',
          observedAt: '2026-05-14T09:00:00.000Z',
          producedBy: { source: 'workboard-state' },
          confidence: 'asserted',
        },
      ],
    });
    expect(computeTimelineRail(snap, 'thread:t1')).toBeNull();
  });

  it('picks the most-populated UTC day when the snapshot spans days', () => {
    const dayA: ConnectionsSnapshot['edges'] = [
      {
        id: 'eA1',
        kind: 'thread_in_workstream',
        fromNodeId: 'thread:t1',
        toNodeId: 'workstream:w1',
        observedAt: '2026-05-13T15:00:00.000Z',
        producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 1 } },
        confidence: 'asserted',
      },
    ];
    const dayB: ConnectionsSnapshot['edges'] = [
      {
        id: 'eB1',
        kind: 'thread_in_workstream',
        fromNodeId: 'thread:t1',
        toNodeId: 'workstream:w1',
        observedAt: '2026-05-14T09:00:00.000Z',
        producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 2 } },
        confidence: 'asserted',
      },
      {
        id: 'eB2',
        kind: 'thread_in_workstream',
        fromNodeId: 'thread:t1',
        toNodeId: 'workstream:w1',
        observedAt: '2026-05-14T10:00:00.000Z',
        producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 3 } },
        confidence: 'asserted',
      },
    ];
    const snap = baseSnap({ edges: [...dayA, ...dayB] });
    const rail = computeTimelineRail(snap, 'thread:t1');
    expect(rail!.date).toBe('2026-05-14');
  });

  it('resolves anchor + neighbor markers from node lastSeenAt within the chosen day', () => {
    const snap = baseSnap({
      nodes: [
        {
          id: 'thread:t1',
          kind: 'thread',
          label: 'anchor',
          lastSeenAt: '2026-05-14T09:30:00.000Z',
          originReplicaIds: ['mac'],
          metadata: {},
        },
        {
          id: 'workstream:w1',
          kind: 'workstream',
          label: 'ws',
          lastSeenAt: '2026-05-14T10:15:00.000Z',
          originReplicaIds: ['mac'],
          metadata: {},
        },
        {
          id: 'thread:t_other_day',
          kind: 'thread',
          label: 'other day',
          lastSeenAt: '2026-05-13T12:00:00.000Z',
          originReplicaIds: ['mac'],
          metadata: {},
        },
      ],
      edges: [
        {
          id: 'e1',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: '2026-05-14T09:00:00.000Z',
          producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 1 } },
          confidence: 'asserted',
        },
      ],
    });
    const rail = computeTimelineRail(snap, 'thread:t1');
    expect(rail!.anchorTime).toBeCloseTo(9 + 30 / 60, 3);
    expect(rail!.neighborTimes).toEqual([10 + 15 / 60]);
  });

  it('falls back to node lastSeenAt when edges have no producer dot (inferred-only subgraph)', () => {
    // Thread anchor at 1 hop often has only `timeline_same_url_as_thread`
    // (inferred, no producedBy.dot). The fallback path uses each node's
    // own lastSeenAt + originReplicaIds so the rail still renders.
    const snap = baseSnap({
      nodes: [
        {
          id: 'thread:t1',
          kind: 'thread',
          label: 'Some thread',
          originReplicaIds: ['mac'],
          metadata: {},
          lastSeenAt: '2026-05-14T09:15:00.000Z',
        },
        {
          id: 'timeline-visit:https://example.test/page',
          kind: 'timeline-visit',
          label: 'Page',
          originReplicaIds: ['mac'],
          metadata: { canonicalUrl: 'https://example.test/page' },
          lastSeenAt: '2026-05-14T10:00:00.000Z',
        },
      ],
      edges: [
        {
          id: 'e1',
          kind: 'timeline_same_url_as_thread',
          fromNodeId: 'thread:t1',
          toNodeId: 'timeline-visit:https://example.test/page',
          observedAt: '2026-05-14T10:00:00.000Z',
          // Inferred edges carry no producedBy.dot
          producedBy: { source: 'inferred' },
          confidence: 'inferred',
        },
      ],
    });
    const rail = computeTimelineRail(snap, 'thread:t1');
    expect(rail).not.toBeNull();
    expect(rail!.date).toBe('2026-05-14');
    expect(rail!.rows.length).toBe(1);
    expect(rail!.rows[0]!.replicaId).toBe('mac');
    expect(rail!.anchorTime).toBeCloseTo(9 + 15 / 60, 3);
    expect(rail!.neighborTimes).toEqual([10]);
  });
});
