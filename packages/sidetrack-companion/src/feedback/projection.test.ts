import { describe, expect, it } from 'vitest';

import type { AcceptedEvent } from '../sync/causal.js';
import {
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
  USER_TOPIC_RENAMED,
} from './events.js';
import { projectFeedback } from './projection.js';

const event = (input: {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly acceptedAtMs?: number;
}): AcceptedEvent => ({
  clientEventId: `feedback-${String(input.seq)}`,
  dot: { replicaId: 'replica-a', seq: input.seq },
  deps: {},
  aggregateId: `feedback-${String(input.seq)}`,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? Date.parse('2026-05-08T12:00:00.000Z') + input.seq,
});

describe('feedback projection', () => {
  it('aggregates per-item user actions and positive/negative training labels', () => {
    const projection = projectFeedback([
      event({
        seq: 1,
        type: USER_FLOW_CONFIRMED,
        payload: {
          payloadVersion: 1,
          relationKind: 'visit_resembles_visit',
          fromId: 'visit-a',
          toId: 'visit-b',
        },
      }),
      event({
        seq: 2,
        type: USER_FLOW_REJECTED,
        payload: {
          payloadVersion: 1,
          relationKind: 'closest_visit',
          fromId: 'visit-c',
          toId: 'visit-d',
        },
      }),
      event({
        seq: 3,
        type: USER_SNIPPET_PROMOTED,
        payload: {
          payloadVersion: 1,
          snippetId: 'snippet-a',
          targetKind: 'source',
          targetId: 'thread-source',
          sourceVisitId: 'visit-source',
        },
      }),
      event({
        seq: 4,
        type: USER_ORGANIZED_ITEM,
        payload: {
          payloadVersion: 1,
          itemKind: 'visit',
          itemId: 'visit-e',
          action: 'move',
          toContainer: 'topic-one',
        },
      }),
    ]);

    expect(Object.keys(projection.perItem)).toEqual([
      'snippet-a',
      'visit-a\u0000visit-b',
      'visit-c\u0000visit-d',
      'visit-e',
    ]);
    expect(projection.containerByItem).toEqual({
      'visit-e': {
        itemId: 'visit-e',
        containerId: 'topic-one',
        sourceItemId: 'visit-e',
        sourceItemKind: 'visit',
        action: 'move',
        acceptedAtMs: Date.parse('2026-05-08T12:00:00.000Z') + 4,
        replicaId: 'replica-a',
        seq: 4,
      },
    });
    expect(projection.organizedItemsByContainer).toEqual({
      'topic-one': [
        {
          itemId: 'visit-e',
          containerId: 'topic-one',
          sourceItemId: 'visit-e',
          sourceItemKind: 'visit',
          action: 'move',
          acceptedAtMs: Date.parse('2026-05-08T12:00:00.000Z') + 4,
          replicaId: 'replica-a',
          seq: 4,
        },
      ],
    });
    expect(projection.positiveLabels).toEqual([
      { fromId: 'visit-a', toId: 'visit-b', weight: 1 },
      { fromId: 'visit-e', toId: 'topic-one', weight: 1 },
      { fromId: 'visit-source', toId: 'thread-source', weight: 1 },
    ]);
    expect(projection.negativeLabels).toEqual([{ fromId: 'visit-c', toId: 'visit-d', weight: 1 }]);
  });

  it('keeps byte-identical output when events arrive in a different order', () => {
    const events = [
      event({
        seq: 1,
        type: USER_TOPIC_RENAMED,
        payload: {
          payloadVersion: 1,
          topicId: 'topic-a',
          previousName: 'Old',
          newName: 'New',
          source: 'inline',
        },
      }),
      event({
        seq: 2,
        type: USER_FLOW_CONFIRMED,
        payload: {
          payloadVersion: 1,
          relationKind: 'closest_visit',
          fromId: 'visit-a',
          toId: 'visit-b',
        },
      }),
    ];

    expect(JSON.stringify(projectFeedback([...events].reverse()))).toBe(
      JSON.stringify(projectFeedback(events)),
    );
  });

  it('freezes promoted topic members as durable container membership', () => {
    const projection = projectFeedback([
      event({
        seq: 1,
        type: USER_ORGANIZED_ITEM,
        payload: {
          payloadVersion: 1,
          itemKind: 'topic',
          itemId: 'topic:computed-rust',
          action: 'promote',
          toContainer: 'workstream:rust',
          details: {
            memberIds: ['timeline-visit:rust-b', 'timeline-visit:rust-a'],
          },
        },
      }),
      event({
        seq: 2,
        type: USER_ORGANIZED_ITEM,
        payload: {
          payloadVersion: 1,
          itemKind: 'topic',
          itemId: 'topic:computed-rust',
          action: 'promote',
          toContainer: 'workstream:later-suggestion',
        },
      }),
    ]);

    expect(projection.containerByItem).toEqual({
      'timeline-visit:rust-a': {
        itemId: 'timeline-visit:rust-a',
        containerId: 'workstream:rust',
        sourceItemId: 'topic:computed-rust',
        sourceItemKind: 'topic',
        action: 'promote',
        acceptedAtMs: Date.parse('2026-05-08T12:00:00.000Z') + 1,
        replicaId: 'replica-a',
        seq: 1,
      },
      'timeline-visit:rust-b': {
        itemId: 'timeline-visit:rust-b',
        containerId: 'workstream:rust',
        sourceItemId: 'topic:computed-rust',
        sourceItemKind: 'topic',
        action: 'promote',
        acceptedAtMs: Date.parse('2026-05-08T12:00:00.000Z') + 1,
        replicaId: 'replica-a',
        seq: 1,
      },
      'topic:computed-rust': {
        itemId: 'topic:computed-rust',
        containerId: 'workstream:later-suggestion',
        sourceItemId: 'topic:computed-rust',
        sourceItemKind: 'topic',
        action: 'promote',
        acceptedAtMs: Date.parse('2026-05-08T12:00:00.000Z') + 2,
        replicaId: 'replica-a',
        seq: 2,
      },
    });
    expect(projection.organizedItemsByContainer['workstream:rust']?.map((m) => m.itemId)).toEqual([
      'timeline-visit:rust-a',
      'timeline-visit:rust-b',
    ]);
  });

  it('projects computed-topic renames as label-only actions', () => {
    const projection = projectFeedback([
      event({
        seq: 1,
        type: USER_TOPIC_RENAMED,
        payload: {
          payloadVersion: 1,
          topicId: 'topic:computed-rust',
          previousName: 'Old',
          newName: 'Rust',
          source: 'inline',
        },
      }),
    ]);

    expect(projection.perItem['topic:computed-rust']?.map((action) => action.action)).toEqual([
      'renamed',
    ]);
    expect(projection.containerByItem).toEqual({});
    expect(projection.organizedItemsByContainer).toEqual({});
    expect(projection.positiveLabels).toEqual([]);
    expect(projection.negativeLabels).toEqual([]);
  });

  it('ignores malformed feedback-like events', () => {
    expect(
      projectFeedback([
        event({
          seq: 1,
          type: USER_FLOW_CONFIRMED,
          payload: {
            payloadVersion: 1,
            relationKind: 'closest_visit',
            fromId: 'visit-a',
          },
        }),
      ]),
    ).toEqual({
      schemaVersion: 1,
      perItem: {},
      containerByItem: {},
      organizedItemsByContainer: {},
      positiveLabels: [],
      negativeLabels: [],
    });
  });
});
