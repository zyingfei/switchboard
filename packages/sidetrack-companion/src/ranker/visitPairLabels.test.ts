// Stage 5 / T4 — visit-pair label derivation from user-asserted
// `visit_instance_in_workstream` edges. Bridges the gap between the
// projection's `(URL, workstreamId)` labels and the ranker's expected
// `(visitKey, visitKey)` candidate shape.

import { describe, expect, it } from 'vitest';

import { TAB_SESSION_ATTRIBUTION_INFERRED } from '../tabsession/events.js';
import { URL_ATTRIBUTION_INFERRED } from '../urls/events.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import type {
  ConnectionEdge,
  ConnectionNode,
  ConnectionsSnapshot,
} from '../connections/types.js';

import {
  augmentFeedbackWithVisitPairLabels,
  deriveVisitPairLabelsFromSnapshot,
} from './retrain.js';

const TIMESTAMP = '2026-05-10T10:00:00.000Z';

const visitInstance = (
  id: string,
  canonicalUrl: string | undefined,
): ConnectionNode => ({
  id,
  kind: 'visit-instance',
  label: id,
  firstSeenAt: TIMESTAMP,
  lastSeenAt: TIMESTAMP,
  originReplicaIds: ['rep-1'],
  metadata: canonicalUrl === undefined ? {} : { canonicalUrl },
});

const workstreamNode = (key: string): ConnectionNode => ({
  id: `workstream:${key}`,
  kind: 'workstream',
  label: key,
  originReplicaIds: ['rep-1'],
  metadata: {},
});

const userAssertedEdge = (
  fromNodeId: string,
  toNodeId: string,
): ConnectionEdge => ({
  id: `edge:visit_instance_in_workstream:${fromNodeId}:${toNodeId}`,
  kind: 'visit_instance_in_workstream',
  fromNodeId,
  toNodeId,
  observedAt: TIMESTAMP,
  producedBy: {
    source: 'event-log',
    eventType: USER_ORGANIZED_ITEM,
    dot: { replicaId: 'rep-1', seq: 1 },
  },
  confidence: 'asserted',
});

const urlInferredEdge = (
  fromNodeId: string,
  toNodeId: string,
): ConnectionEdge => ({
  id: `edge:visit_instance_in_workstream:${fromNodeId}:${toNodeId}`,
  kind: 'visit_instance_in_workstream',
  fromNodeId,
  toNodeId,
  observedAt: TIMESTAMP,
  producedBy: {
    source: 'event-log',
    eventType: URL_ATTRIBUTION_INFERRED,
    dot: { replicaId: 'rep-1', seq: 2 },
  },
  confidence: 'inferred',
});

const tabSessionInferredEdge = (
  fromNodeId: string,
  toNodeId: string,
): ConnectionEdge => ({
  id: `edge:visit_instance_in_workstream:${fromNodeId}:${toNodeId}`,
  kind: 'visit_instance_in_workstream',
  fromNodeId,
  toNodeId,
  observedAt: TIMESTAMP,
  producedBy: {
    source: 'event-log',
    eventType: TAB_SESSION_ATTRIBUTION_INFERRED,
    dot: { replicaId: 'rep-1', seq: 3 },
  },
  confidence: 'inferred',
});

const snapshot = (
  nodes: readonly ConnectionNode[],
  edges: readonly ConnectionEdge[],
): ConnectionsSnapshot => ({
  scope: {},
  nodes,
  edges,
  updatedAt: TIMESTAMP,
  nodeCount: nodes.length,
  edgeCount: edges.length,
});

const sortLabels = (labels: readonly { fromId: string; toId: string }[]) =>
  [...labels]
    .map(({ fromId, toId }) => `${fromId}|${toId}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe('deriveVisitPairLabelsFromSnapshot', () => {
  it('emits directional (URL, URL) pairs for visits user-asserted into the same workstream', () => {
    const visitA = visitInstance('visit-instance:tses-1:1:https://example.test/a', 'https://example.test/a');
    const visitB = visitInstance('visit-instance:tses-1:1:https://example.test/b', 'https://example.test/b');
    const ws = workstreamNode('ws-1');
    const snap = snapshot(
      [visitA, visitB, ws],
      [userAssertedEdge(visitA.id, ws.id), userAssertedEdge(visitB.id, ws.id)],
    );
    const labels = deriveVisitPairLabelsFromSnapshot(snap);
    expect(sortLabels(labels)).toEqual([
      'https://example.test/a|https://example.test/b',
      'https://example.test/b|https://example.test/a',
    ]);
    for (const label of labels) {
      expect(label.weight).toBe(1);
    }
  });

  it('emits Cartesian pairs (N*(N-1)) for N>2 visits in the same workstream', () => {
    const visits = ['a', 'b', 'c'].map((suffix) =>
      visitInstance(
        `visit-instance:tses-1:1:https://example.test/${suffix}`,
        `https://example.test/${suffix}`,
      ),
    );
    const ws = workstreamNode('ws-1');
    const snap = snapshot(
      [...visits, ws],
      visits.map((v) => userAssertedEdge(v.id, ws.id)),
    );
    const labels = deriveVisitPairLabelsFromSnapshot(snap);
    expect(labels).toHaveLength(6);
  });

  it('keeps pairs scoped to a single workstream (no cross-workstream pairs)', () => {
    const visitA = visitInstance('visit-instance:tses-1:1:https://example.test/a', 'https://example.test/a');
    const visitB = visitInstance('visit-instance:tses-1:1:https://example.test/b', 'https://example.test/b');
    const ws1 = workstreamNode('ws-1');
    const ws2 = workstreamNode('ws-2');
    const snap = snapshot(
      [visitA, visitB, ws1, ws2],
      [userAssertedEdge(visitA.id, ws1.id), userAssertedEdge(visitB.id, ws2.id)],
    );
    const labels = deriveVisitPairLabelsFromSnapshot(snap);
    expect(labels).toEqual([]);
  });

  it('excludes edges produced by URL_ATTRIBUTION_INFERRED', () => {
    const visitA = visitInstance('visit-instance:tses-1:1:https://example.test/a', 'https://example.test/a');
    const visitB = visitInstance('visit-instance:tses-1:1:https://example.test/b', 'https://example.test/b');
    const ws = workstreamNode('ws-1');
    const snap = snapshot(
      [visitA, visitB, ws],
      [urlInferredEdge(visitA.id, ws.id), urlInferredEdge(visitB.id, ws.id)],
    );
    expect(deriveVisitPairLabelsFromSnapshot(snap)).toEqual([]);
  });

  it('excludes edges produced by TAB_SESSION_ATTRIBUTION_INFERRED', () => {
    const visitA = visitInstance('visit-instance:tses-1:1:https://example.test/a', 'https://example.test/a');
    const visitB = visitInstance('visit-instance:tses-1:1:https://example.test/b', 'https://example.test/b');
    const ws = workstreamNode('ws-1');
    const snap = snapshot(
      [visitA, visitB, ws],
      [tabSessionInferredEdge(visitA.id, ws.id), tabSessionInferredEdge(visitB.id, ws.id)],
    );
    expect(deriveVisitPairLabelsFromSnapshot(snap)).toEqual([]);
  });

  it('skips visit-instance nodes without canonicalUrl metadata', () => {
    const visitA = visitInstance('visit-instance:tses-1:1:url-a', undefined);
    const visitB = visitInstance('visit-instance:tses-1:1:url-b', 'https://example.test/b');
    const ws = workstreamNode('ws-1');
    const snap = snapshot(
      [visitA, visitB, ws],
      [userAssertedEdge(visitA.id, ws.id), userAssertedEdge(visitB.id, ws.id)],
    );
    // Only one visit has canonicalUrl → no pairs.
    expect(deriveVisitPairLabelsFromSnapshot(snap)).toEqual([]);
  });
});

describe('augmentFeedbackWithVisitPairLabels', () => {
  it('returns the original feedback unchanged when the snapshot yields no pairs', () => {
    const feedback = {
      schemaVersion: 1 as const,
      perItem: {},
      positiveLabels: [{ fromId: 'x', toId: 'y', weight: 1 }],
      negativeLabels: [],
    };
    const result = augmentFeedbackWithVisitPairLabels(
      feedback,
      snapshot([], []),
    );
    expect(result).toBe(feedback);
  });

  it('appends derived visit-pair labels to positiveLabels', () => {
    const visitA = visitInstance('visit-instance:tses-1:1:https://example.test/a', 'https://example.test/a');
    const visitB = visitInstance('visit-instance:tses-1:1:https://example.test/b', 'https://example.test/b');
    const ws = workstreamNode('ws-1');
    const snap = snapshot(
      [visitA, visitB, ws],
      [userAssertedEdge(visitA.id, ws.id), userAssertedEdge(visitB.id, ws.id)],
    );
    const feedback = {
      schemaVersion: 1 as const,
      perItem: {},
      positiveLabels: [{ fromId: 'pre-existing-from', toId: 'pre-existing-to', weight: 1 }],
      negativeLabels: [],
    };
    const result = augmentFeedbackWithVisitPairLabels(feedback, snap);
    expect(result.positiveLabels).toHaveLength(3); // 1 pre-existing + 2 derived
    expect(sortLabels(result.positiveLabels)).toContain('https://example.test/a|https://example.test/b');
    expect(sortLabels(result.positiveLabels)).toContain('https://example.test/b|https://example.test/a');
    expect(sortLabels(result.positiveLabels)).toContain('pre-existing-from|pre-existing-to');
  });
});
