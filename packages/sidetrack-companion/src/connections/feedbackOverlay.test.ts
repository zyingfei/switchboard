import { describe, expect, it } from 'vitest';

import {
  USER_ENGAGEMENT_RELABELED,
  USER_ORGANIZED_ITEM,
  USER_TOPIC_RENAMED,
} from '../feedback/events.js';
import { projectFeedback } from '../feedback/projection.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { applyFeedbackOverlayToSnapshot } from './feedbackOverlay.js';
import type { ConnectionsSnapshot } from './types.js';

const event = (input: {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
}): AcceptedEvent => ({
  clientEventId: `feedback-${String(input.seq)}`,
  dot: { replicaId: 'replica-a', seq: input.seq },
  deps: {},
  aggregateId: `feedback-${String(input.seq)}`,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: Date.parse('2026-05-14T10:00:00.000Z') + input.seq,
});

const snapshot = (): ConnectionsSnapshot => ({
  scope: {},
  nodes: [
    {
      id: 'topic:oracle',
      kind: 'topic',
      label: 'Oracle Cloud Infrastructure Cloud Adoption Framework',
      originReplicaIds: [],
      metadata: {
        memberCount: 2,
        representativeTitles: ['Oracle Cloud Infrastructure Cloud Adoption Framework'],
      },
    },
    {
      id: 'timeline-visit:https://example.test/a',
      kind: 'timeline-visit',
      label: 'Page A',
      lastSeenAt: '2026-05-14T09:00:00.000Z',
      originReplicaIds: [],
      metadata: {
        canonicalUrl: 'https://example.test/a',
        engagement: { class: 'glanced', focusedWindowMs: 1_000 },
      },
    },
    {
      id: 'timeline-visit:https://example.test/b',
      kind: 'timeline-visit',
      label: 'Page B',
      originReplicaIds: [],
      metadata: { canonicalUrl: 'https://example.test/b' },
    },
  ],
  edges: [
    {
      id: 'edge:visit_in_topic:a',
      kind: 'visit_in_topic',
      fromNodeId: 'timeline-visit:https://example.test/a',
      toNodeId: 'topic:oracle',
      observedAt: '2026-05-14T10:00:00.000Z',
      producedBy: { source: 'topic-clusterer', revisionId: 'topic-rev' },
      confidence: 'inferred',
    },
    {
      id: 'edge:visit_in_topic:b',
      kind: 'visit_in_topic',
      fromNodeId: 'timeline-visit:https://example.test/b',
      toNodeId: 'topic:oracle',
      observedAt: '2026-05-14T10:00:00.000Z',
      producedBy: { source: 'topic-clusterer', revisionId: 'topic-rev' },
      confidence: 'inferred',
    },
  ],
  updatedAt: '2026-05-14T10:00:00.000Z',
  nodeCount: 3,
  edgeCount: 2,
  snapshotRevision: 'base-rev',
});

describe('applyFeedbackOverlayToSnapshot', () => {
  it('applies topic rename, visit removal, and engagement relabel feedback', () => {
    const projection = projectFeedback([
      event({
        seq: 1,
        type: USER_TOPIC_RENAMED,
        payload: {
          payloadVersion: 1,
          topicId: 'topic:oracle',
          previousName: 'Oracle Cloud Infrastructure Cloud Adoption Framework',
          newName: 'Oracle CAF',
          source: 'inline',
        },
      }),
      event({
        seq: 2,
        type: USER_ORGANIZED_ITEM,
        payload: {
          payloadVersion: 1,
          itemKind: 'visit',
          itemId: 'timeline-visit:https://example.test/b',
          action: 'ignore',
          fromContainer: 'topic:oracle',
        },
      }),
      event({
        seq: 3,
        type: USER_ENGAGEMENT_RELABELED,
        payload: {
          payloadVersion: 1,
          visitId: 'timeline-visit:https://example.test/a',
          fromClass: 'glanced',
          toClass: 'engaged_read',
        },
      }),
    ]);

    const overlaid = applyFeedbackOverlayToSnapshot(snapshot(), projection);

    expect(overlaid.nodes.find((node) => node.id === 'topic:oracle')?.label).toBe('Oracle CAF');
    expect(overlaid.edges.map((edge) => edge.fromNodeId)).toEqual([
      'timeline-visit:https://example.test/a',
    ]);
    expect(
      (
        overlaid.nodes.find((node) => node.id === 'timeline-visit:https://example.test/a')
          ?.metadata['engagement'] as Record<string, unknown>
      )['class'],
    ).toBe('engaged_read');
    expect(overlaid.snapshotRevision).not.toBe('base-rev');
  });

  it('lets a later move-to-topic restore a removed visit edge', () => {
    const projection = projectFeedback([
      event({
        seq: 1,
        type: USER_ORGANIZED_ITEM,
        payload: {
          payloadVersion: 1,
          itemKind: 'visit',
          itemId: 'timeline-visit:https://example.test/b',
          action: 'ignore',
          fromContainer: 'topic:oracle',
        },
      }),
      event({
        seq: 2,
        type: USER_ORGANIZED_ITEM,
        payload: {
          payloadVersion: 1,
          itemKind: 'visit',
          itemId: 'timeline-visit:https://example.test/b',
          action: 'move',
          toContainer: 'topic:oracle',
        },
      }),
    ]);

    expect(applyFeedbackOverlayToSnapshot(snapshot(), projection).edges).toHaveLength(2);
  });

  const topicSnapshot = (
    topics: readonly { readonly id: string; readonly representativeTitles: readonly string[] }[],
    lineage: readonly { readonly from: string; readonly to: string }[] = [],
  ): ConnectionsSnapshot => ({
    scope: {},
    nodes: topics.map((t) => ({
      id: t.id,
      kind: 'topic' as const,
      label: t.representativeTitles[0] ?? t.id,
      originReplicaIds: [],
      metadata: { memberCount: 3, representativeTitles: [...t.representativeTitles] },
    })),
    edges: lineage.map((l, i) => ({
      id: `edge:topic.lineage:${String(i)}`,
      kind: 'topic.lineage',
      fromNodeId: l.from,
      toNodeId: l.to,
      observedAt: '2026-05-18T00:00:00.000Z',
      producedBy: { source: 'topic-clusterer', revisionId: 'rev' },
      confidence: 'observed',
      metadata: { lineageKind: 'continue' },
    })),
    updatedAt: '2026-05-18T00:00:00.000Z',
    nodeCount: topics.length,
    edgeCount: lineage.length,
    snapshotRevision: 'base-rev',
  });

  const renameEvent = (topicId: string, previousName: string, newName: string): AcceptedEvent =>
    event({
      seq: 1,
      type: USER_TOPIC_RENAMED,
      payload: { payloadVersion: 1, topicId, previousName, newName, source: 'inline' },
    });

  it('re-binds a rename to the current topic by representative title when the id changed (the 统计学习 case)', () => {
    // Rename was recorded against the content-hash id at rename time;
    // the topic since gained members so its id changed. The algorithmic
    // title the rename captured still identifies it uniquely.
    const snap = topicSnapshot([
      { id: 'topic:topic:NEW-hash', representativeTitles: ['4_monte_carlo', '5_knn'] },
      { id: 'topic:topic:other', representativeTitles: ['unrelated'] },
    ]);
    const projection = projectFeedback([
      renameEvent('topic:topic:OLD-hash', '4_monte_carlo', '统计学习'),
    ]);
    const out = applyFeedbackOverlayToSnapshot(snap, projection);
    const topic = out.nodes.find((n) => n.id === 'topic:topic:NEW-hash');
    expect(topic?.label).toBe('统计学习');
    expect(topic?.metadata['representativeTitles']).toEqual(['统计学习']);
    // The unrelated topic is untouched.
    expect(out.nodes.find((n) => n.id === 'topic:topic:other')?.label).toBe('unrelated');
  });

  it('re-binds a rename across a topic.lineage hop when the id changed', () => {
    const snap = topicSnapshot(
      [{ id: 'topic:new', representativeTitles: ['Algorithmic title'] }],
      [{ from: 'topic:old', to: 'topic:new' }],
    );
    const projection = projectFeedback([
      // previousName intentionally does NOT match any current title, so
      // only the lineage hop can resolve this.
      renameEvent('topic:old', 'a stale title nobody has', 'Renamed via lineage'),
    ]);
    const out = applyFeedbackOverlayToSnapshot(snap, projection);
    expect(out.nodes.find((n) => n.id === 'topic:new')?.label).toBe('Renamed via lineage');
  });

  it('never mis-binds: an ambiguous representative-title match is a no-op', () => {
    const snap = topicSnapshot([
      { id: 'topic:dup-1', representativeTitles: ['Shared'] },
      { id: 'topic:dup-2', representativeTitles: ['Shared'] },
    ]);
    const projection = projectFeedback([
      renameEvent('topic:gone', 'Shared', 'should not apply'),
    ]);
    const out = applyFeedbackOverlayToSnapshot(snap, projection);
    expect(out.nodes.map((n) => n.label)).toEqual(['Shared', 'Shared']);
  });
});
