import { describe, expect, it } from 'vitest';

import {
  FEEDBACK_EVENT_TYPES,
  isUserEngagementRelabeledPayload,
  isUserFlowConfirmedPayload,
  isUserFlowRejectedPayload,
  isUserOrganizedItemPayload,
  isUserRejectedRelationPayload,
  isUserSnippetPromotedPayload,
  isUserTopicRenamedPayload,
} from './events.js';
import { CONTRACT_REGISTRY } from '../sync/contract/registry.js';

interface GuardCase {
  readonly name: string;
  readonly guard: (value: unknown) => boolean;
  readonly valid: Record<string, unknown>;
  readonly missingRequiredKey: string;
  readonly invalidEnumPatch: Record<string, unknown>;
}

const omit = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

const cases: readonly GuardCase[] = [
  {
    name: 'user.organized.item',
    guard: isUserOrganizedItemPayload,
    valid: {
      payloadVersion: 1,
      itemKind: 'thread',
      itemId: 'thread-1',
      action: 'move',
      fromContainer: 'workstream-old',
      toContainer: 'workstream-new',
      details: { mergeMembers: ['thread-1', 'thread-2'] },
    },
    missingRequiredKey: 'itemId',
    invalidEnumPatch: { action: 'delete' },
  },
  {
    name: 'user.engagement.relabeled',
    guard: isUserEngagementRelabeledPayload,
    valid: {
      payloadVersion: 1,
      visitId: 'visit-1',
      fromClass: 'skimmed',
      toClass: 'worked_on_reference',
    },
    missingRequiredKey: 'visitId',
    invalidEnumPatch: { toClass: 'deeply_interested' },
  },
  {
    name: 'user.flow.confirmed',
    guard: isUserFlowConfirmedPayload,
    valid: {
      payloadVersion: 1,
      relationKind: 'closest_visit',
      fromId: 'visit-a',
      toId: 'visit-b',
    },
    missingRequiredKey: 'fromId',
    invalidEnumPatch: { relationKind: 'thread_in_workstream' },
  },
  {
    name: 'user.flow.rejected',
    guard: isUserFlowRejectedPayload,
    valid: {
      payloadVersion: 1,
      relationKind: 'visit_resembles_visit',
      fromId: 'visit-a',
      toId: 'visit-b',
      reason: 'not-related',
    },
    missingRequiredKey: 'toId',
    invalidEnumPatch: { reason: 'maybe-related' },
  },
  {
    name: 'user.topic.renamed',
    guard: isUserTopicRenamedPayload,
    valid: {
      payloadVersion: 1,
      topicId: 'topic-1',
      previousName: 'Old topic',
      newName: 'New topic',
      source: 'inline',
    },
    missingRequiredKey: 'newName',
    invalidEnumPatch: { source: 'system-generated' },
  },
  {
    name: 'user.snippet.promoted',
    guard: isUserSnippetPromotedPayload,
    valid: {
      payloadVersion: 1,
      snippetId: 'snippet-1',
      targetKind: 'source',
      targetId: 'source-1',
      sourceVisitId: 'visit-1',
    },
    missingRequiredKey: 'targetId',
    invalidEnumPatch: { targetKind: 'bookmark' },
  },
  {
    name: 'user.rejected.relation',
    guard: isUserRejectedRelationPayload,
    valid: {
      payloadVersion: 1,
      fromRef: 'https://example.test/a',
      toRef: 'https://example.test/b',
      surface: 'connections',
      reason: 'not-related',
    },
    missingRequiredKey: 'toRef',
    invalidEnumPatch: { surface: 'nowhere' },
  },
];

describe('feedback event payload guards', () => {
  it.each(cases)('$name accepts a valid payload', ({ guard, valid }) => {
    expect(guard(valid)).toBe(true);
  });

  it.each(cases)(
    '$name rejects missing required fields',
    ({ guard, valid, missingRequiredKey }) => {
      expect(guard(omit(valid, missingRequiredKey))).toBe(false);
    },
  );

  it.each(cases)('$name rejects invalid enum values', ({ guard, valid, invalidEnumPatch }) => {
    expect(guard({ ...valid, ...invalidEnumPatch })).toBe(false);
  });

  it.each(cases)('$name rejects dimensions', ({ guard, valid }) => {
    expect(guard({ ...valid, dimensions: {} })).toBe(false);
  });

  it('rejects malformed optional organized-item details', () => {
    expect(
      isUserOrganizedItemPayload({
        payloadVersion: 1,
        itemKind: 'topic',
        itemId: 'topic-1',
        action: 'split',
        details: { splitInto: ['topic-a', 42] },
      }),
    ).toBe(false);
  });

  it('accepts immutable member snapshots for promoted computed topics', () => {
    expect(
      isUserOrganizedItemPayload({
        payloadVersion: 1,
        itemKind: 'topic',
        itemId: 'topic:computed-rust',
        action: 'promote',
        toContainer: 'workstream:rust',
        details: { memberIds: ['timeline-visit:rust-a', 'timeline-visit:rust-b'] },
      }),
    ).toBe(true);
    expect(
      isUserOrganizedItemPayload({
        payloadVersion: 1,
        itemKind: 'topic',
        itemId: 'topic:computed-rust',
        action: 'promote',
        toContainer: 'workstream:rust',
        details: { memberIds: ['timeline-visit:rust-a', 42] },
      }),
    ).toBe(false);
  });

  it('accepts suggestion action details used by Focus controls', () => {
    expect(
      isUserOrganizedItemPayload({
        payloadVersion: 1,
        itemKind: 'visit',
        itemId: 'timeline-visit:https://example.test/noisy',
        action: 'ignore',
        fromContainer: 'topic:topic-alpha',
        details: {
          reason: 'not-related',
          targetTopicId: 'topic:topic-alpha',
          memberIds: ['timeline-visit:https://example.test/a'],
        },
      }),
    ).toBe(true);
    expect(
      isUserOrganizedItemPayload({
        payloadVersion: 1,
        itemKind: 'topic',
        itemId: 'topic:topic-alpha',
        action: 'ignore',
        details: { reason: 'unsupported' },
      }),
    ).toBe(false);
  });

  it('accepts a rejected-relation payload without an optional reason', () => {
    expect(
      isUserRejectedRelationPayload({
        payloadVersion: 1,
        fromRef: 'https://example.test/a',
        toRef: 'https://example.test/b',
        surface: 'related-strip',
      }),
    ).toBe(true);
    // Empty refs and unknown surfaces are rejected.
    expect(
      isUserRejectedRelationPayload({
        payloadVersion: 1,
        fromRef: '',
        toRef: 'https://example.test/b',
        surface: 'related-strip',
      }),
    ).toBe(false);
  });

  it('rejects renaming computed topics through the organized-item path', () => {
    expect(
      isUserOrganizedItemPayload({
        payloadVersion: 1,
        itemKind: 'topic',
        itemId: 'topic:computed-rust',
        action: 'rename',
        details: { rename: 'Rust' },
      }),
    ).toBe(false);
    expect(
      isUserOrganizedItemPayload({
        payloadVersion: 1,
        itemKind: 'workstream',
        itemId: 'workstream:rust',
        action: 'rename',
        details: { rename: 'Rust' },
      }),
    ).toBe(true);
  });
});

describe('feedback event registry entries', () => {
  it('covers every feedback event with payload version 1 and no dimensions', () => {
    const entries = new Map(CONTRACT_REGISTRY.map((entry) => [entry.eventType, entry]));

    for (const eventType of FEEDBACK_EVENT_TYPES) {
      const entry = entries.get(eventType);
      expect(entry, `missing registry entry for ${eventType}`).toBeDefined();
      expect(entry?.currentPayloadVersion).toBe(1);
      expect(entry?.allowedDimensions).toEqual([]);
      expect(entry?.surfaces).toHaveLength(2);
      expect(entry?.surfaces[0]).toMatchObject({
        surface: 'feedback-action-projection',
        class: 'aggregate-projection',
        materializer: 'projection',
        recovery: 'class-A',
      });
      expect(entry?.surfaces[1]).toMatchObject({
        surface: 'feedback-projection',
        class: 'derived-cache',
        materializer: 'projection',
        recovery: 'replay-event-log',
      });
    }
  });
});
