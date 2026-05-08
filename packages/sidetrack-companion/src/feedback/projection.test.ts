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
    expect(projection.positiveLabels).toEqual([
      { fromId: 'visit-a', toId: 'visit-b', weight: 1 },
      { fromId: 'visit-e', toId: 'topic-one', weight: 1 },
      { fromId: 'visit-source', toId: 'thread-source', weight: 1 },
    ]);
    expect(projection.negativeLabels).toEqual([
      { fromId: 'visit-c', toId: 'visit-d', weight: 1 },
    ]);
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
      positiveLabels: [],
      negativeLabels: [],
    });
  });
});
