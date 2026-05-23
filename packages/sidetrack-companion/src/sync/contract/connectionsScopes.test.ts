import { describe, expect, it } from 'vitest';

import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
import type { ConnectionEdge, ConnectionNode } from '../../connections/types.js';
import type { AcceptedEvent } from '../causal.js';
import { invalidationsForEvent } from './invalidation.js';
import { invalidationKeysToScopes, scopesForGraphRows } from './connectionsScopes.js';

const event = (type: string, payload: unknown): AcceptedEvent => ({
  clientEventId: `evt-${type}`,
  dot: { replicaId: 'replica-scopes', seq: 1 },
  deps: {},
  aggregateId: 'aggregate',
  type,
  payload,
  acceptedAtMs: Date.parse('2026-05-22T10:00:00.000Z'),
});

describe('connections scope invalidation mapping', () => {
  it('maps thread upserts to thread, URL, and workstream scopes', () => {
    expect(
      invalidationKeysToScopes(
        invalidationsForEvent(
          event(THREAD_UPSERTED, {
            bac_id: 'thread-a',
            threadUrl: 'https://chatgpt.com/c/thread-a',
            primaryWorkstreamId: 'workstream-a',
          }),
        ),
      ),
    ).toEqual([
      { kind: 'thread', id: 'thread-a' },
      { kind: 'url', id: 'https://chatgpt.com/c/thread-a' },
      { kind: 'workstream', id: 'workstream-a' },
    ]);
  });

  it('maps browser observations to visit, tab-session, and URL scopes', () => {
    expect(
      invalidationKeysToScopes(
        invalidationsForEvent(
          event(BROWSER_TIMELINE_OBSERVED, {
            eventId: 'visit-a',
            observedAt: '2026-05-22T10:00:00.000Z',
            url: 'https://example.test/path',
            canonicalUrl: 'https://example.test/path',
            transition: 'activated',
            tabSessionId: 'tab-a',
          }),
        ),
      ),
    ).toEqual([
      { kind: 'tab-session', id: 'tab-a' },
      { kind: 'url', id: 'https://example.test/path' },
      { kind: 'url', id: 'visit-a' },
      { kind: 'visit', id: 'visit-a' },
    ]);
  });
});

describe('connections graph scope ownership', () => {
  it('assigns exactly one local owner per edge without endpoint expansion', () => {
    const nodes: ConnectionNode[] = [
      {
        id: 'timeline-visit:https://example.test/a',
        kind: 'timeline-visit',
        label: 'A',
        metadata: { workstreamId: 'W1' },
      },
      { id: 'workstream:W1', kind: 'workstream', label: 'W1', metadata: {} },
      { id: 'topic:topic-a', kind: 'topic', label: 'Topic A', metadata: {} },
      { id: 'thread:T1', kind: 'thread', label: 'T1', metadata: { workstreamId: 'W1' } },
    ];
    const edges: ConnectionEdge[] = [
      {
        id: 'e1',
        kind: 'visit_in_workstream',
        fromNodeId: 'timeline-visit:https://example.test/a',
        toNodeId: 'workstream:W1',
        observedAt: '2026-05-22T10:00:00.000Z',
        producedBy: { source: 'timeline-projection' },
        confidence: 'inferred',
        metadata: {},
      },
      {
        id: 'e2',
        kind: 'visit_in_topic',
        fromNodeId: 'timeline-visit:https://example.test/a',
        toNodeId: 'topic:topic-a',
        observedAt: '2026-05-22T10:00:00.000Z',
        producedBy: { source: 'topic-clusterer', revisionId: 'topics-1' },
        confidence: 'inferred',
        metadata: {},
      },
      {
        id: 'e3',
        kind: 'thread_in_workstream',
        fromNodeId: 'thread:T1',
        toNodeId: 'workstream:W1',
        observedAt: '2026-05-22T10:00:00.000Z',
        producedBy: { source: 'event-log', eventType: THREAD_UPSERTED },
        confidence: 'asserted',
        metadata: {},
      },
    ];

    const scopes = scopesForGraphRows({ nodes, edges });
    const edgeScopeRows = [...scopes.edgeScopes.values()].flat();

    expect(edgeScopeRows).toHaveLength(edges.length);
    expect(scopes.edgeScopes.get('timeline-visit:https://example.test/a\u0000workstream:W1')).toEqual([
      { kind: 'url', id: 'https://example.test/a' },
    ]);
    expect(scopes.edgeScopes.get('timeline-visit:https://example.test/a\u0000topic:topic-a')).toEqual([
      { kind: 'topic', id: 'topic-a' },
    ]);
    expect(scopes.edgeScopes.get('thread:T1\u0000workstream:W1')).toEqual([
      { kind: 'thread', id: 'T1' },
    ]);
    expect(scopes.nodeScopes.get('timeline-visit:https://example.test/a')).toEqual([
      { kind: 'url', id: 'https://example.test/a' },
    ]);
    expect(scopes.nodeScopes.get('workstream:W1')).toEqual([{ kind: 'workstream', id: 'W1' }]);
  });
});
