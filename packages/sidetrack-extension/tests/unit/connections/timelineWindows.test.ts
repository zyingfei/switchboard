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

// Build an ISO string for a specific LOCAL time. Used to make
// timezone-aware tests deterministic across CI / dev machines —
// the rail uses local hours, so we construct timestamps in local
// time then serialize.
const localIso = (year: number, month: number, day: number, hour: number, minute = 0): string =>
  new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
const localYmd = (year: number, month: number, day: number): string =>
  `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

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
          observedAt: localIso(2026, 5, 14, 9, 10),
          producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 1 } },
          confidence: 'asserted',
        },
        {
          id: 'e2',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: localIso(2026, 5, 14, 9, 25),
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
    expect(a).toBe(Date.parse(localIso(2026, 5, 14, 9, 10)));
    expect(b).toBe(Date.parse(localIso(2026, 5, 14, 9, 25)));
  });

  it('splits a >30min gap into separate windows', () => {
    const snap = baseSnap({
      edges: [
        {
          id: 'e1',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: localIso(2026, 5, 14, 9, 0),
          producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 1 } },
          confidence: 'asserted',
        },
        {
          id: 'e2',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: localIso(2026, 5, 14, 11, 0),
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
          observedAt: localIso(2026, 5, 14, 9, 0),
          producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 1 } },
          confidence: 'asserted',
        },
        {
          id: 'e2',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: localIso(2026, 5, 14, 10, 30),
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
          observedAt: localIso(2026, 5, 14, 9, 0),
          producedBy: { source: 'workboard-state' },
          confidence: 'asserted',
        },
      ],
    });
    expect(computeTimelineRail(snap, 'thread:t1')).toBeNull();
  });

  it('All range scales to the observed event span when the snapshot spans days', () => {
    const dayA: ConnectionsSnapshot['edges'] = [
      {
        id: 'eA1',
        kind: 'thread_in_workstream',
        fromNodeId: 'thread:t1',
        toNodeId: 'workstream:w1',
        observedAt: localIso(2026, 5, 13, 15, 0),
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
        observedAt: localIso(2026, 5, 14, 9, 0),
        producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 2 } },
        confidence: 'asserted',
      },
      {
        id: 'eB2',
        kind: 'thread_in_workstream',
        fromNodeId: 'thread:t1',
        toNodeId: 'workstream:w1',
        observedAt: localIso(2026, 5, 14, 10, 0),
        producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 3 } },
        confidence: 'asserted',
      },
    ];
    const snap = baseSnap({ edges: [...dayA, ...dayB] });
    const rail = computeTimelineRail(snap, 'thread:t1');
    expect(rail!.date).toBe(`${localYmd(2026, 5, 13)}-${localYmd(2026, 5, 14)}`);
    expect(rail!.scaleLabel).toBe('hours');
    expect(rail!.startMs).toBe(Date.parse(localIso(2026, 5, 13, 15, 0)));
    expect(rail!.endMs).toBe(Date.parse(localIso(2026, 5, 14, 10, 0)));
  });

  it('resolves anchor + neighbor markers from node lastSeenAt within the chosen range', () => {
    const snap = baseSnap({
      nodes: [
        {
          id: 'thread:t1',
          kind: 'thread',
          label: 'anchor',
          lastSeenAt: localIso(2026, 5, 14, 9, 30),
          originReplicaIds: ['mac'],
          metadata: {},
        },
        {
          id: 'workstream:w1',
          kind: 'workstream',
          label: 'ws',
          lastSeenAt: localIso(2026, 5, 14, 10, 15),
          originReplicaIds: ['mac'],
          metadata: {},
        },
        {
          id: 'thread:t_other_day',
          kind: 'thread',
          label: 'other day',
          lastSeenAt: localIso(2026, 5, 13, 12, 0),
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
          observedAt: localIso(2026, 5, 14, 9, 0),
          producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 1 } },
          confidence: 'asserted',
        },
      ],
    });
    const rail = computeTimelineRail(snap, 'thread:t1');
    expect(rail!.anchorTime).toBe(Date.parse(localIso(2026, 5, 14, 9, 30)));
    expect(rail!.neighborTimes).toEqual([Date.parse(localIso(2026, 5, 14, 10, 15))]);
    expect(rail!.markers.map((marker) => [marker.kind, marker.nodeId])).toEqual([
      ['anchor', 'thread:t1'],
      ['related', 'workstream:w1'],
    ]);
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
          lastSeenAt: localIso(2026, 5, 14, 9, 15),
        },
        {
          id: 'timeline-visit:https://example.test/page',
          kind: 'timeline-visit',
          label: 'Page',
          originReplicaIds: ['mac'],
          metadata: { canonicalUrl: 'https://example.test/page' },
          lastSeenAt: localIso(2026, 5, 14, 10, 0),
        },
      ],
      edges: [
        {
          id: 'e1',
          kind: 'timeline_same_url_as_thread',
          fromNodeId: 'thread:t1',
          toNodeId: 'timeline-visit:https://example.test/page',
          observedAt: localIso(2026, 5, 14, 10, 0),
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
    expect(rail!.anchorTime).toBe(Date.parse(localIso(2026, 5, 14, 9, 15)));
    expect(rail!.neighborTimes).toEqual([Date.parse(localIso(2026, 5, 14, 10, 0))]);
  });

  it('honors a selected preset range', () => {
    const snap = baseSnap({
      edges: [
        {
          id: 'old',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: localIso(2026, 5, 14, 8, 0),
          producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 1 } },
          confidence: 'asserted',
        },
        {
          id: 'fresh',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: localIso(2026, 5, 14, 9, 45),
          producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 2 } },
          confidence: 'asserted',
        },
      ],
    });
    const rail = computeTimelineRail(snap, 'thread:t1', {
      range: { kind: 'preset', preset: '1h' },
      nowMs: Date.parse(localIso(2026, 5, 14, 10, 0)),
    });
    expect(rail).not.toBeNull();
    expect(rail!.startMs).toBe(Date.parse(localIso(2026, 5, 14, 9, 0)));
    expect(rail!.endMs).toBe(Date.parse(localIso(2026, 5, 14, 10, 0)));
    expect(rail!.rows[0]!.windows).toHaveLength(1);
    expect(rail!.rows[0]!.windows[0]![0]).toBe(Date.parse(localIso(2026, 5, 14, 9, 45)));
  });

  it('keeps boundary observations visible at the end of the selected range', () => {
    const endMs = Date.parse(localIso(2026, 5, 14, 10, 0));
    const snap = baseSnap({
      edges: [
        {
          id: 'at-end',
          kind: 'thread_in_workstream',
          fromNodeId: 'thread:t1',
          toNodeId: 'workstream:w1',
          observedAt: new Date(endMs).toISOString(),
          producedBy: { source: 'event-log', dot: { replicaId: 'mac', seq: 1 } },
          confidence: 'asserted',
        },
      ],
    });
    const rail = computeTimelineRail(snap, 'thread:t1', {
      range: { kind: 'preset', preset: '1h' },
      nowMs: endMs,
    });
    expect(rail).not.toBeNull();
    const [start, end] = rail!.rows[0]!.windows[0]!;
    expect(start).toBeLessThan(end);
    expect(end).toBe(endMs);
  });
});
