// closest_visit ranker label shaping. Workstream membership is scope,
// not pairwise evidence: it must never mint positive labels or pair
// candidates without an independent source.

import { describe, expect, it } from 'vitest';

import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import type { ConnectionEdge, ConnectionNode, ConnectionsSnapshot } from '../connections/types.js';

import type { FeedbackProjection } from '../feedback/projection.js';

import {
  augmentFeedbackWithVisitPairLabels,
  buildRankerTrainingCandidates,
  deriveNegativeVisitPairLabelsFromSnapshot,
  deriveVisitPairLabelsFromSnapshot,
} from './retrain.js';

const TIMESTAMP = '2026-05-10T10:00:00.000Z';

const visitInstance = (id: string, canonicalUrl: string | undefined): ConnectionNode => ({
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

describe('augmentFeedbackWithVisitPairLabels', () => {
  it('returns the original feedback unchanged when the snapshot yields no pairs', () => {
    const feedback = {
      schemaVersion: 1 as const,
      perItem: {},
      containerByItem: {},
      organizedItemsByContainer: {},
      positiveLabels: [{ fromId: 'x', toId: 'y', weight: 1 }],
      negativeLabels: [],
    };
    const result = augmentFeedbackWithVisitPairLabels(feedback, snapshot([], []));
    expect(result).toBe(feedback);
  });

  it('leaves positive labels unchanged even when the snapshot has same-workstream visits', () => {
    const visitA = visitInstance(
      'visit-instance:tses-1:1:https://example.test/a',
      'https://example.test/a',
    );
    const visitB = visitInstance(
      'visit-instance:tses-1:1:https://example.test/b',
      'https://example.test/b',
    );
    const ws = workstreamNode('ws-1');
    const snap = snapshot(
      [visitA, visitB, ws],
      [userAssertedEdge(visitA.id, ws.id), userAssertedEdge(visitB.id, ws.id)],
    );
    const feedback = {
      schemaVersion: 1 as const,
      perItem: {},
      containerByItem: {},
      organizedItemsByContainer: {},
      positiveLabels: [{ fromId: 'pre-existing-from', toId: 'pre-existing-to', weight: 1 }],
      negativeLabels: [],
    };
    const result = augmentFeedbackWithVisitPairLabels(feedback, snap);
    expect(result.positiveLabels).toEqual(feedback.positiveLabels);
  });
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

const visitInTopicEdge = (canonicalUrl: string, topicId: string): ConnectionEdge => ({
  id: `edge:visit_in_topic:timeline-visit:${canonicalUrl}:topic:${topicId}`,
  kind: 'visit_in_topic',
  fromNodeId: `timeline-visit:${canonicalUrl}`,
  toNodeId: `topic:${topicId}`,
  observedAt: TIMESTAMP,
  producedBy: { source: 'topic-clusterer', revisionId: 'rev-1' },
  confidence: 'inferred',
});

const feedbackWith = (
  negativeLabels: readonly { fromId: string; toId: string; weight: number }[],
): FeedbackProjection => ({
  schemaVersion: 1,
  perItem: {},
  containerByItem: {},
  organizedItemsByContainer: {},
  positiveLabels: [],
  negativeLabels,
});

describe('deriveNegativeVisitPairLabelsFromSnapshot', () => {
  it('expands a (timeline-visit:A, topic:T) negative into A↔member pairs that survive the resolution gate', () => {
    const a = 'https://example.test/a';
    const b = 'https://example.test/b';
    const c = 'https://example.test/c';
    const snap = snapshot(
      [timelineVisitNode(a), timelineVisitNode(b), timelineVisitNode(c), topicNode('T')],
      [visitInTopicEdge(b, 'T'), visitInTopicEdge(c, 'T')],
    );
    const feedback = feedbackWith([{ fromId: `timeline-visit:${a}`, toId: 'topic:T', weight: 1 }]);

    const derived = deriveNegativeVisitPairLabelsFromSnapshot(feedback, snap);
    expect(sortLabels(derived)).toEqual([`${a}|${b}`, `${a}|${c}`]);

    // The derived negatives must reach training: every one must survive
    // `candidateResolvesToTimelineVisits` inside buildRankerTrainingCandidates.
    // augment appends the 2 derived pairs alongside the 1 original
    // container-shaped negative (the original is gate-dropped; the
    // derived pairs are not).
    const augmented = augmentFeedbackWithVisitPairLabels(feedback, snap);
    expect(augmented.negativeLabels).toHaveLength(3);
    expect(sortLabels(augmented.negativeLabels)).toEqual(
      [`${a}|${b}`, `${a}|${c}`, `timeline-visit:${a}|topic:T`].sort(),
    );
    const candidates = buildRankerTrainingCandidates({
      feedback: augmented,
      merged: [],
      snapshot: snap,
      randomNegativeCandidatesPerPositive: 0,
    });
    const skippedPairs = candidates
      .filter((entry) => entry.candidate.sources.includes('recently_skipped'))
      .map((entry) => `${entry.candidate.fromVisitId}|${entry.candidate.toVisitId}`)
      .sort();
    expect(skippedPairs).toEqual([`${a}|${b}`, `${a}|${c}`]);
  });

  it('passes already-(visit, visit) negatives through unchanged', () => {
    const feedback = feedbackWith([
      { fromId: 'https://example.test/a', toId: 'https://example.test/b', weight: 1 },
    ]);
    expect(deriveNegativeVisitPairLabelsFromSnapshot(feedback, snapshot([], []))).toEqual([
      { fromId: 'https://example.test/a', toId: 'https://example.test/b', weight: 1 },
    ]);
  });

  it('yields nothing for a container with no snapshot members (no crash)', () => {
    const feedback = feedbackWith([
      { fromId: 'timeline-visit:https://example.test/a', toId: 'topic:empty', weight: 1 },
    ]);
    expect(
      deriveNegativeVisitPairLabelsFromSnapshot(feedback, snapshot([topicNode('empty')], [])),
    ).toEqual([]);
  });

  it('does not create self-pairs and dedupes repeated expansions', () => {
    const a = 'https://example.test/a';
    const snap = snapshot([timelineVisitNode(a), topicNode('T')], [visitInTopicEdge(a, 'T')]);
    // The visit endpoint is itself a member of the container → the only
    // candidate pair would be A↔A, which must be dropped.
    const selfOnly = deriveNegativeVisitPairLabelsFromSnapshot(
      feedbackWith([{ fromId: `timeline-visit:${a}`, toId: 'topic:T', weight: 1 }]),
      snap,
    );
    expect(selfOnly).toEqual([]);

    // Two identical negatives against the same container collapse to one.
    const b = 'https://example.test/b';
    const dupSnap = snapshot(
      [timelineVisitNode(a), timelineVisitNode(b), topicNode('T')],
      [visitInTopicEdge(b, 'T')],
    );
    const deduped = deriveNegativeVisitPairLabelsFromSnapshot(
      feedbackWith([
        { fromId: `timeline-visit:${a}`, toId: 'topic:T', weight: 1 },
        { fromId: `timeline-visit:${a}`, toId: 'topic:T', weight: 1 },
      ]),
      dupSnap,
    );
    expect(deduped).toEqual([{ fromId: a, toId: b, weight: 1 }]);
  });

  it('resolves a workstream container transitively through topic_in_workstream', () => {
    const a = 'https://example.test/a';
    const b = 'https://example.test/b';
    const snap = snapshot(
      [timelineVisitNode(a), timelineVisitNode(b), topicNode('T'), workstreamNode('ws-1')],
      [
        visitInTopicEdge(b, 'T'),
        {
          id: 'edge:topic_in_workstream:topic:T:workstream:ws-1',
          kind: 'topic_in_workstream',
          fromNodeId: 'topic:T',
          toNodeId: 'workstream:ws-1',
          observedAt: TIMESTAMP,
          producedBy: { source: 'topic-clusterer', revisionId: 'rev-1' },
          confidence: 'inferred',
        },
      ],
    );
    const derived = deriveNegativeVisitPairLabelsFromSnapshot(
      feedbackWith([{ fromId: `timeline-visit:${a}`, toId: 'workstream:ws-1', weight: 1 }]),
      snap,
    );
    expect(sortLabels(derived)).toEqual([`${a}|${b}`]);
  });
});
