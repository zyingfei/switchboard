// closest_visit ranker label shaping. Container membership is scope,
// not pairwise supervision: snapshot churn must not mint or rewrite
// labels.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import { projectFeedback, type FeedbackProjection } from '../feedback/projection.js';
import { collectWorkGraphHealth } from '../system/workGraphHealth.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { createEventLog } from '../sync/eventLog.js';
import type { ConnectionEdge, ConnectionNode, ConnectionsSnapshot } from '../connections/types.js';

import {
  buildRankerTrainingCandidates,
  deriveVisitPairLabelsFromSnapshot,
  fingerprintFeedbackTrainingLabels,
} from './retrain.js';

const TIMESTAMP = '2026-05-10T10:00:00.000Z';
const TIMESTAMP_MS = Date.parse(TIMESTAMP);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const visitInstance = (id: string, canonicalUrl: string | undefined): ConnectionNode => ({
  id,
  kind: 'visit-instance',
  label: id,
  firstSeenAt: TIMESTAMP,
  lastSeenAt: TIMESTAMP,
  originReplicaIds: ['rep-1'],
  metadata: canonicalUrl === undefined ? {} : { canonicalUrl },
});

const timelineVisitNode = (canonicalUrl: string): ConnectionNode => ({
  id: `timeline-visit:${canonicalUrl}`,
  kind: 'timeline-visit',
  label: canonicalUrl,
  firstSeenAt: TIMESTAMP,
  lastSeenAt: TIMESTAMP,
  originReplicaIds: ['rep-1'],
  metadata: { canonicalUrl },
});

const topicNode = (topicId: string): ConnectionNode => ({
  id: `topic:${topicId}`,
  kind: 'topic',
  label: topicId,
  originReplicaIds: ['rep-1'],
  metadata: {},
});

const workstreamNode = (key: string): ConnectionNode => ({
  id: `workstream:${key}`,
  kind: 'workstream',
  label: key,
  originReplicaIds: ['rep-1'],
  metadata: {},
});

const userAssertedEdge = (fromNodeId: string, toNodeId: string): ConnectionEdge => ({
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

const visitInWorkstreamEdge = (canonicalUrl: string, workstreamId: string): ConnectionEdge => ({
  id: `edge:visit_in_workstream:timeline-visit:${canonicalUrl}:workstream:${workstreamId}`,
  kind: 'visit_in_workstream',
  fromNodeId: `timeline-visit:${canonicalUrl}`,
  toNodeId: `workstream:${workstreamId}`,
  observedAt: TIMESTAMP,
  producedBy: {
    source: 'event-log',
    eventType: USER_ORGANIZED_ITEM,
    dot: { replicaId: 'rep-1', seq: 1 },
  },
  confidence: 'asserted',
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

const ignoreFromContainerEvent = (
  seq: number,
  itemId: string,
  fromContainer: string,
): AcceptedEvent => ({
  clientEventId: `ignore-${String(seq)}`,
  dot: { replicaId: 'rep-1', seq },
  deps: {},
  aggregateId: `feedback:${itemId}`,
  type: USER_ORGANIZED_ITEM,
  payload: {
    payloadVersion: 1,
    itemKind: 'canonical-url',
    itemId,
    action: 'ignore',
    fromContainer,
  },
  acceptedAtMs: TIMESTAMP_MS + seq,
});

const labelIdentitySet = (feedback: FeedbackProjection): readonly string[] =>
  [...feedback.positiveLabels.map((label) => `+|${label.fromId}|${label.toId}|${label.weight}`)]
    .concat(
      feedback.negativeLabels.map((label) => `-|${label.fromId}|${label.toId}|${label.weight}`),
    )
    .sort();

describe('deriveVisitPairLabelsFromSnapshot', () => {
  it('does not mint positives from user-asserted workstream closure', () => {
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
    expect(deriveVisitPairLabelsFromSnapshot(snap)).toEqual([]);
  });
});

describe('ranker feedback label stability', () => {
  it('keeps the same label set when snapshot container membership changes', () => {
    const event = ignoreFromContainerEvent(1, 'https://example.test/a', 'workstream:active-focus');
    const firstSnapshot = snapshot(
      [
        timelineVisitNode('https://example.test/a'),
        timelineVisitNode('https://example.test/b'),
        workstreamNode('active-focus'),
      ],
      [visitInWorkstreamEdge('https://example.test/b', 'active-focus')],
    );
    const changedSnapshot = snapshot(
      [
        timelineVisitNode('https://example.test/a'),
        timelineVisitNode('https://example.test/c'),
        timelineVisitNode('https://example.test/d'),
        workstreamNode('active-focus'),
      ],
      [
        visitInWorkstreamEdge('https://example.test/c', 'active-focus'),
        visitInWorkstreamEdge('https://example.test/d', 'active-focus'),
      ],
    );

    expect(firstSnapshot.edgeCount).not.toBe(changedSnapshot.edgeCount);

    const first = projectFeedback([event]);
    const second = projectFeedback([event]);

    expect(first.negativeLabels).toHaveLength(1);
    expect(second.negativeLabels).toHaveLength(1);
    expect(labelIdentitySet(first)).toEqual(labelIdentitySet(second));
    expect(fingerprintFeedbackTrainingLabels(first)).toEqual(
      fingerprintFeedbackTrainingLabels(second),
    );
  });

  it('does not generate pairwise negatives from a container-level ignore event', async () => {
    const anchorUrl = 'https://example.test/a';
    const memberUrl = 'https://example.test/b';
    const event = ignoreFromContainerEvent(1, anchorUrl, 'workstream:w1');
    const feedback = projectFeedback([event]);
    const snap = snapshot(
      [timelineVisitNode(anchorUrl), timelineVisitNode(memberUrl), workstreamNode('w1')],
      [visitInWorkstreamEdge(memberUrl, 'w1')],
    );

    const candidates = buildRankerTrainingCandidates({
      feedback,
      merged: [event],
      snapshot: snap,
      randomNegativeCandidatesPerPositive: 0,
    });
    const pairwiseNegatives = candidates.filter((entry) =>
      entry.candidate.sources.includes('recently_skipped'),
    );

    expect(feedback.negativeLabels).toEqual([
      { fromId: anchorUrl, toId: 'workstream:w1', weight: 1 },
    ]);
    expect(pairwiseNegatives).toHaveLength(0);

    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-no-expansion-'));
    tempRoots.push(vaultRoot);
    const eventLog = createEventLog(vaultRoot, {
      replicaId: 'local-replica',
      created: true,
      nextSeq: async () => 1,
      peekSeq: () => 1,
      observeSeq: async () => {},
    });
    await eventLog.importPeerEvent(event);
    const health = await collectWorkGraphHealth({ vaultRoot, eventLog });

    expect(health.ranker.expandedNegativeCount).toBe(0);
  });
});
