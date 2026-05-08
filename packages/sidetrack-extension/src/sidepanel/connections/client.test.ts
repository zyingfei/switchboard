import { afterEach, describe, expect, it } from 'vitest';

import {
  contextPackInputFromConnections,
  fetchConnectionsTopicLabel,
  fetchConnectionsWhyRelated,
  setConnectionsClientTransportForTests,
  topicLabelFromConnections,
  whyRelatedReasonsFromConnections,
} from './client';
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

  it('uses the existing runtime message proxy for topic label and why-related reads', async () => {
    setConnectionsClientTransportForTests(async () => ({ ok: true, data: result }));

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
});
