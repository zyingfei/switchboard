import { afterEach, describe, expect, it } from 'vitest';

import {
  contextPackInputFromConnections,
  fetchConnectionsTopicLabel,
  fetchConnectionsWhyRelated,
  postUserEngagementRelabeled,
  postUserFlowConfirmed,
  postUserFlowRejected,
  postUserOrganizedItem,
  postUserSnippetPromoted,
  postUserTopicRenamed,
  setConnectionsClientTransportForTests,
  topicLabelFromConnections,
  whyRelatedReasonsFromConnections,
} from './client';
import { messageTypes } from '../../messages';
import type { ConnectionsScopedResult } from './types';

const result: ConnectionsScopedResult = {
  scope: 'companion-extended',
  snapshot: {
    scope: {},
    nodes: [
      {
        id: 'topic:alpha',
        kind: 'topic',
        label: 'Alpha topic',
        originReplicaIds: [],
        metadata: { cohesion: 0.91, memberCount: 1 },
      },
      {
        id: 'timeline-visit:https://example.test/a',
        kind: 'timeline-visit',
        label: 'Visit A',
        originReplicaIds: [],
        metadata: {
          canonicalUrl: 'https://example.test/a',
          focusedWindowMs: 10_000,
        },
      },
      {
        id: 'replica:mac',
        kind: 'replica',
        label: 'mac',
        originReplicaIds: [],
        metadata: {},
      },
      {
        id: 'thread:a',
        kind: 'thread',
        label: 'Thread A',
        originReplicaIds: [],
        metadata: { url: 'https://chatgpt.com/c/a' },
      },
      {
        id: 'annotation:a',
        kind: 'annotation',
        label: 'Should this be included?',
        originReplicaIds: [],
        metadata: { note: 'Should this be included?' },
      },
    ],
    edges: [
      {
        id: 'edge:visit-topic',
        kind: 'visit_in_topic',
        fromNodeId: 'timeline-visit:https://example.test/a',
        toNodeId: 'topic:alpha',
        observedAt: '2026-05-08T10:00:00.000Z',
        producedBy: { source: 'topic-clusterer' },
        confidence: 'inferred',
      },
      {
        id: 'edge:visit-replica',
        kind: 'visit_observed_on_replica',
        fromNodeId: 'timeline-visit:https://example.test/a',
        toNodeId: 'replica:mac',
        observedAt: '2026-05-08T10:00:00.000Z',
        producedBy: { source: 'cross-replica' },
        confidence: 'observed',
      },
    ],
    updatedAt: '2026-05-08T10:00:00.000Z',
    nodeCount: 5,
    edgeCount: 2,
  },
};

describe('connections client helpers', () => {
  afterEach(() => {
    setConnectionsClientTransportForTests(null);
  });

  it('derives topic labels, why-related reasons, and context-pack input from snapshots', () => {
    expect(topicLabelFromConnections(result, 'topic:alpha')).toEqual({
      label: 'Visit A',
      tooltip: 'cohesion=0.91 · members=1',
    });
    expect(
      whyRelatedReasonsFromConnections(result, 'timeline-visit:https://example.test/a'),
    ).toEqual([
      { code: 'SAME_TOPIC', topicId: 'topic:alpha', cohesion: 0.91 },
      { code: 'OBSERVED_ON_OTHER_REPLICA', replicaId: 'mac' },
    ]);
    expect(contextPackInputFromConnections(result, 'ws-a').threads).toEqual([
      { id: 'thread:a', title: 'Thread A', url: 'https://chatgpt.com/c/a' },
    ]);
  });

  it('reads the real cosine + threshold from visit_resembles_visit edge metadata', () => {
    // RCA: this reason was previously hardcoded to { cosine: 0.85,
    // threshold: 0.85 } in client.ts because the companion never
    // persisted the values. Once the snapshot.ts emitter passes them
    // through, the UI MUST read them off the edge. If anyone ever
    // hardcodes a number again, this test fails.
    const resultWithSim: typeof result = {
      ...result,
      snapshot: {
        ...result.snapshot,
        edges: [
          ...result.snapshot.edges,
          {
            id: 'edge:resembles',
            kind: 'visit_resembles_visit',
            fromNodeId: 'timeline-visit:https://example.test/a',
            toNodeId: 'timeline-visit:https://example.test/b',
            observedAt: '2026-05-08T10:00:00.000Z',
            producedBy: { source: 'visit-similarity', revisionId: 'rev-1' },
            confidence: 'inferred',
            metadata: { cosine: 0.93, threshold: 0.82 },
          },
        ],
      },
    };
    const reasons = whyRelatedReasonsFromConnections(
      resultWithSim,
      'timeline-visit:https://example.test/a',
    );
    expect(reasons).toContainEqual({
      code: 'COSINE_ABOVE_THRESHOLD',
      cosine: 0.93,
      threshold: 0.82,
    });
  });

  it('uses the existing runtime message proxy for topic label and why-related reads', async () => {
    setConnectionsClientTransportForTests(() => Promise.resolve({ ok: true, data: result }));

    await expect(fetchConnectionsTopicLabel('topic:alpha')).resolves.toEqual({
      ok: true,
      data: { label: 'Visit A', tooltip: 'cohesion=0.91 · members=1' },
    });
    await expect(
      fetchConnectionsWhyRelated({ fromVisitId: 'timeline-visit:https://example.test/a' }),
    ).resolves.toEqual({
      ok: true,
      data: [
        { code: 'SAME_TOPIC', topicId: 'topic:alpha', cohesion: 0.91 },
        { code: 'OBSERVED_ON_OTHER_REPLICA', replicaId: 'mac' },
      ],
    });
  });

  it('posts S23 feedback events through the runtime companion proxy', async () => {
    const sent: unknown[] = [];
    setConnectionsClientTransportForTests((message) => {
      sent.push(message);
      return Promise.resolve({
        ok: true,
        data: { accepted: { dot: { replicaId: 'local', seq: 1 } } },
      });
    });

    await postUserFlowConfirmed({
      relationKind: 'visit_resembles_visit',
      fromId: 'visit:a',
      toId: 'visit:b',
    });
    await postUserFlowRejected({
      relationKind: 'closest_visit',
      fromId: 'visit:a',
      toId: 'visit:c',
      reason: 'not-related',
    });
    await postUserEngagementRelabeled({
      visitId: 'visit:a',
      fromClass: 'skimmed',
      toClass: 'worked_on_reference',
    });
    await postUserSnippetPromoted({
      snippetId: 'snippet:1',
      targetId: 'visit:a',
      sourceVisitId: 'visit:a',
    });
    await postUserTopicRenamed({
      topicId: 'topic:alpha',
      previousName: 'Alpha',
      newName: 'Oracle research',
    });
    await postUserOrganizedItem({
      itemKind: 'thread',
      itemId: 'thread:1',
      action: 'move',
      fromContainer: 'workstream:old',
      toContainer: 'workstream:new',
      details: { memberIds: ['timeline-visit:a', 'timeline-visit:b'] },
    });

    expect(sent).toEqual([
      expect.objectContaining({
        type: messageTypes.postConnectionsFeedbackEvent,
        event: {
          type: 'user.flow.confirmed',
          payload: {
            payloadVersion: 1,
            relationKind: 'visit_resembles_visit',
            fromId: 'visit:a',
            toId: 'visit:b',
          },
        },
        clientEventId: expect.stringMatching(/^feedback-user\.flow\.confirmed-/u),
      }),
      expect.objectContaining({
        type: messageTypes.postConnectionsFeedbackEvent,
        event: {
          type: 'user.flow.rejected',
          payload: {
            payloadVersion: 1,
            relationKind: 'closest_visit',
            fromId: 'visit:a',
            toId: 'visit:c',
            reason: 'not-related',
          },
        },
        clientEventId: expect.stringMatching(/^feedback-user\.flow\.rejected-/u),
      }),
      expect.objectContaining({
        type: messageTypes.postConnectionsFeedbackEvent,
        event: {
          type: 'user.engagement.relabeled',
          payload: {
            payloadVersion: 1,
            visitId: 'visit:a',
            fromClass: 'skimmed',
            toClass: 'worked_on_reference',
          },
        },
        clientEventId: expect.stringMatching(/^feedback-user\.engagement\.relabeled-/u),
      }),
      expect.objectContaining({
        type: messageTypes.postConnectionsFeedbackEvent,
        event: {
          type: 'user.snippet.promoted',
          payload: {
            payloadVersion: 1,
            snippetId: 'snippet:1',
            targetKind: 'source',
            targetId: 'visit:a',
            sourceVisitId: 'visit:a',
          },
        },
        clientEventId: expect.stringMatching(/^feedback-user\.snippet\.promoted-/u),
      }),
      expect.objectContaining({
        type: messageTypes.postConnectionsFeedbackEvent,
        event: {
          type: 'user.topic.renamed',
          payload: {
            payloadVersion: 1,
            topicId: 'topic:alpha',
            previousName: 'Alpha',
            newName: 'Oracle research',
            source: 'inline',
          },
        },
        clientEventId: expect.stringMatching(/^feedback-user\.topic\.renamed-/u),
      }),
      expect.objectContaining({
        type: messageTypes.postConnectionsFeedbackEvent,
        event: {
          type: 'user.organized.item',
          payload: {
            payloadVersion: 1,
            itemKind: 'thread',
            itemId: 'thread:1',
            action: 'move',
            fromContainer: 'workstream:old',
            toContainer: 'workstream:new',
            details: { memberIds: ['timeline-visit:a', 'timeline-visit:b'] },
          },
        },
        clientEventId: expect.stringMatching(/^feedback-user\.organized\.item-/u),
      }),
    ]);
  });
});
