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
});
