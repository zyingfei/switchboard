import { describe, expect, it } from 'vitest';

import { ANNOTATION_CREATED } from '../annotations/events.js';
import { DISPATCH_LINKED } from '../dispatches/events.js';
import { QUEUE_CREATED } from '../queue/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { THREAD_UPSERTED } from '../threads/events.js';
import type { TimelineDayProjection } from '../timeline/projection.js';
import { WORKSTREAM_UPSERTED } from '../workstreams/events.js';
import {
  buildConnectionsSnapshot,
  findPath,
  subgraphForNode,
  type ConnectionsInput,
} from './snapshot.js';
import { edgeIdFor, nodeIdFor } from './types.js';

// Reducer tests pinning the Given/Then acceptance table from
// /Users/yingfei/.claude/plans/kind-prancing-river.md plus the
// determinism + cross-replica invariants.

const emptyInput = (overrides: Partial<ConnectionsInput> = {}): ConnectionsInput => ({
  events: [],
  threads: [],
  workstreams: [],
  dispatches: [],
  queueItems: [],
  reminders: [],
  codingSessions: [],
  timelineDays: [],
  ...overrides,
});

const buildEvent = (input: {
  seq: number;
  type: string;
  payload: unknown;
  replicaId?: string;
  acceptedAtMs?: number;
  aggregateId?: string;
}): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: input.replicaId ?? 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: input.aggregateId ?? 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? Date.parse('2026-05-07T10:00:00.000Z') + input.seq * 1000,
});

describe('connections — snapshot reducer (Given/Then)', () => {
  it('thread.upserted with primaryWorkstreamId yields thread+workstream nodes and a thread_in_workstream edge', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        events: [
          buildEvent({
            seq: 1,
            type: THREAD_UPSERTED,
            payload: {
              bac_id: 'thread_a',
              provider: 'chatgpt',
              threadUrl: 'https://chatgpt.com/c/abc',
              title: 'Tax flow',
              lastSeenAt: '2026-05-07T10:00:00.000Z',
              tags: [],
              primaryWorkstreamId: 'ws_tax',
            },
          }),
        ],
      }),
    );
    const ids = snap.nodes.map((n) => n.id);
    expect(ids).toContain(nodeIdFor('thread', 'thread_a'));
    expect(ids).toContain(nodeIdFor('workstream', 'ws_tax'));
    const edge = snap.edges.find(
      (e) => e.id === edgeIdFor('thread_in_workstream', nodeIdFor('thread', 'thread_a'), nodeIdFor('workstream', 'ws_tax')),
    );
    expect(edge).toBeDefined();
    expect(edge?.kind).toBe('thread_in_workstream');
    expect(edge?.confidence).toBe('explicit');
    expect(edge?.producedBy.source).toBe('event-log');
  });

  it('workstream.upserted with parentId yields workstream_parent_of edge', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        events: [
          buildEvent({
            seq: 1,
            type: WORKSTREAM_UPSERTED,
            payload: { bac_id: 'ws_child', title: 'Child', parentId: 'ws_root' },
          }),
        ],
      }),
    );
    const edge = snap.edges.find((e) => e.kind === 'workstream_parent_of');
    expect(edge).toBeDefined();
    expect(edge?.fromNodeId).toBe(nodeIdFor('workstream', 'ws_root'));
    expect(edge?.toNodeId).toBe(nodeIdFor('workstream', 'ws_child'));
  });

  it('dispatch with sourceThreadId + workstreamId + mcpRequest produces 3 deterministic edges', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        dispatches: [
          {
            bac_id: 'disp_1',
            title: 'scaffold form parser',
            target: { provider: 'claude' },
            status: 'sent',
            createdAt: '2026-05-07T11:00:00.000Z',
            sourceThreadId: 'thread_a',
            workstreamId: 'ws_tax',
            mcpRequest: { codingSessionId: 'sess_1' },
          },
        ],
      }),
    );
    const kinds = snap.edges.map((e) => e.kind).sort();
    expect(kinds).toEqual([
      'dispatch_from_thread',
      'dispatch_in_workstream',
      'dispatch_requested_coding_session',
    ]);
  });

  it('dispatch.linked event yields dispatch_reply_landed_in_thread', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        events: [
          buildEvent({
            seq: 1,
            type: DISPATCH_LINKED,
            payload: { dispatchId: 'disp_1', threadId: 'thread_a' },
          }),
        ],
      }),
    );
    const edge = snap.edges.find((e) => e.kind === 'dispatch_reply_landed_in_thread');
    expect(edge).toBeDefined();
    expect(edge?.fromNodeId).toBe(nodeIdFor('dispatch', 'disp_1'));
    expect(edge?.toNodeId).toBe(nodeIdFor('thread', 'thread_a'));
  });

  it('queue.created with scope=thread targets the right thread', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        events: [
          buildEvent({
            seq: 1,
            type: QUEUE_CREATED,
            payload: {
              bac_id: 'q_1',
              text: 'follow up on registry',
              scope: 'thread',
              targetId: 'thread_a',
              status: 'pending',
            },
          }),
        ],
      }),
    );
    expect(snap.edges.find((e) => e.kind === 'queue_targets_thread')).toBeDefined();
    expect(snap.edges.find((e) => e.kind === 'queue_targets_workstream')).toBeUndefined();
  });

  it('queue.created with scope=workstream targets the right workstream', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        events: [
          buildEvent({
            seq: 1,
            type: QUEUE_CREATED,
            payload: { bac_id: 'q_2', text: 'foo', scope: 'workstream', targetId: 'ws_tax' },
          }),
        ],
      }),
    );
    expect(snap.edges.find((e) => e.kind === 'queue_targets_workstream')).toBeDefined();
  });

  it('reminder for a thread yields reminder_for_thread edge', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        reminders: [
          {
            bac_id: 'rem_1',
            threadId: 'thread_a',
            provider: 'chatgpt',
            detectedAt: '2026-05-07T12:00:00.000Z',
            status: 'new',
          },
        ],
      }),
    );
    const edge = snap.edges.find((e) => e.kind === 'reminder_for_thread');
    expect(edge).toBeDefined();
    expect(edge?.fromNodeId).toBe(nodeIdFor('inbound-reminder', 'rem_1'));
    expect(edge?.toNodeId).toBe(nodeIdFor('thread', 'thread_a'));
  });

  it('coding session with workstreamId yields coding_session_in_workstream', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        codingSessions: [
          {
            bac_id: 'sess_1',
            workstreamId: 'ws_tax',
            tool: 'cursor',
            cwd: '/work/tax',
            branch: 'main',
            name: '~/work/tax-flow',
            attachedAt: '2026-05-07T09:00:00.000Z',
            lastSeenAt: '2026-05-07T13:00:00.000Z',
            status: 'attached',
          },
        ],
      }),
    );
    const edge = snap.edges.find((e) => e.kind === 'coding_session_in_workstream');
    expect(edge).toBeDefined();
    expect(edge?.fromNodeId).toBe(nodeIdFor('coding-session', 'sess_1'));
  });

  it('timeline visit canonical-URL match yields timeline_same_url_as_thread', () => {
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://chatgpt.com/c/abc',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:30:00.000Z',
          url: 'https://chatgpt.com/c/abc',
          canonicalUrl: 'https://chatgpt.com/c/abc',
          visitCount: 3,
        },
      ],
      updatedAt: '2026-05-07T10:30:00.000Z',
      entryCount: 1,
    };
    const snap = buildConnectionsSnapshot(
      emptyInput({
        threads: [
          {
            bac_id: 'thread_a',
            title: 'Tax flow',
            threadUrl: 'https://chatgpt.com/c/abc',
            canonicalUrl: 'https://chatgpt.com/c/abc',
          },
        ],
        timelineDays: [day],
      }),
    );
    const edge = snap.edges.find((e) => e.kind === 'timeline_same_url_as_thread');
    expect(edge).toBeDefined();
    expect(edge?.confidence).toBe('deterministic');
    expect(edge?.producedBy.source).toBe('timeline-projection');
  });

  it('annotation URL match yields annotation_targets_thread', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        threads: [
          {
            bac_id: 'thread_a',
            threadUrl: 'https://chatgpt.com/c/abc',
            canonicalUrl: 'https://chatgpt.com/c/abc',
          },
        ],
        events: [
          buildEvent({
            seq: 1,
            type: ANNOTATION_CREATED,
            payload: {
              bac_id: 'ann_1',
              url: 'https://chatgpt.com/c/abc',
              note: 'remember to check thresholds',
              anchor: {
                textQuote: { exact: 'x', prefix: '', suffix: '' },
                textPosition: { start: 0, end: 1 },
                cssSelector: 'div',
              },
            },
          }),
        ],
      }),
    );
    const edge = snap.edges.find((e) => e.kind === 'annotation_targets_thread');
    expect(edge).toBeDefined();
    expect(edge?.confidence).toBe('deterministic');
  });
});

describe('connections — determinism + cross-replica', () => {
  it('byte-identical snapshot bytes for same input regardless of event order', () => {
    const events: AcceptedEvent[] = [
      buildEvent({
        seq: 1,
        type: THREAD_UPSERTED,
        payload: {
          bac_id: 'thread_a',
          provider: 'chatgpt',
          threadUrl: 'https://x/a',
          title: 'A',
          lastSeenAt: '2026-05-07T10:00:00.000Z',
          tags: [],
          primaryWorkstreamId: 'ws_x',
        },
      }),
      buildEvent({
        seq: 2,
        type: THREAD_UPSERTED,
        payload: {
          bac_id: 'thread_b',
          provider: 'chatgpt',
          threadUrl: 'https://x/b',
          title: 'B',
          lastSeenAt: '2026-05-07T11:00:00.000Z',
          tags: [],
          primaryWorkstreamId: 'ws_x',
        },
      }),
      buildEvent({
        seq: 3,
        type: WORKSTREAM_UPSERTED,
        payload: { bac_id: 'ws_x', title: 'X' },
      }),
    ];
    const fwd = JSON.stringify(buildConnectionsSnapshot(emptyInput({ events })));
    const rev = JSON.stringify(buildConnectionsSnapshot(emptyInput({ events: [...events].reverse() })));
    const shuffled = JSON.stringify(
      buildConnectionsSnapshot(emptyInput({ events: [events[2]!, events[0]!, events[1]!] })),
    );
    expect(rev).toBe(fwd);
    expect(shuffled).toBe(fwd);
  });

  it('cross-replica: same logical thread observed on two replicas → ONE node with two originReplicaIds', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        events: [
          buildEvent({
            seq: 1,
            replicaId: 'replica-laptop',
            type: THREAD_UPSERTED,
            payload: {
              bac_id: 'thread_a',
              provider: 'chatgpt',
              threadUrl: 'https://x/a',
              title: 'A',
              lastSeenAt: '2026-05-07T10:00:00.000Z',
              tags: [],
            },
          }),
          buildEvent({
            seq: 2,
            replicaId: 'replica-desktop',
            type: THREAD_UPSERTED,
            payload: {
              bac_id: 'thread_a',
              provider: 'chatgpt',
              threadUrl: 'https://x/a',
              title: 'A',
              lastSeenAt: '2026-05-07T11:00:00.000Z',
              tags: [],
            },
          }),
        ],
      }),
    );
    const threadNode = snap.nodes.find((n) => n.id === nodeIdFor('thread', 'thread_a'));
    expect(threadNode).toBeDefined();
    expect(threadNode!.originReplicaIds.length).toBe(2);
    expect([...threadNode!.originReplicaIds].sort()).toEqual(['replica-desktop', 'replica-laptop']);
  });

  it('updatedAt is max observedAt, never wall-clock', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        events: [
          buildEvent({
            seq: 1,
            type: THREAD_UPSERTED,
            payload: {
              bac_id: 'thread_a',
              provider: 'chatgpt',
              threadUrl: 'https://x/a',
              title: 'A',
              lastSeenAt: '2026-05-07T15:00:00.000Z',
              tags: [],
            },
            acceptedAtMs: Date.parse('2026-05-07T10:00:00.000Z'),
          }),
        ],
      }),
    );
    // updatedAt comes from max observedAt across inputs. Threads
    // contribute their lastSeenAt; events contribute acceptedAtMs.
    expect(snap.updatedAt).toBe('2026-05-07T15:00:00.000Z');
  });

  it('empty input produces empty snapshot with epoch updatedAt', () => {
    const snap = buildConnectionsSnapshot(emptyInput());
    expect(snap.nodeCount).toBe(0);
    expect(snap.edgeCount).toBe(0);
    expect(snap.updatedAt).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('connections — subgraph + path helpers', () => {
  const fixture = () =>
    buildConnectionsSnapshot(
      emptyInput({
        events: [
          buildEvent({
            seq: 1,
            type: THREAD_UPSERTED,
            payload: {
              bac_id: 'thread_a',
              provider: 'chatgpt',
              threadUrl: 'https://x/a',
              title: 'A',
              lastSeenAt: '2026-05-07T10:00:00.000Z',
              tags: [],
              primaryWorkstreamId: 'ws_x',
            },
          }),
          buildEvent({
            seq: 2,
            type: DISPATCH_LINKED,
            payload: { dispatchId: 'disp_1', threadId: 'thread_a' },
          }),
        ],
      }),
    );

  it('subgraphForNode hops=1 returns immediate neighbors', () => {
    const snap = fixture();
    const sub = subgraphForNode(snap, nodeIdFor('thread', 'thread_a'), 1);
    const ids = sub.nodes.map((n) => n.id).sort();
    expect(ids).toContain(nodeIdFor('thread', 'thread_a'));
    expect(ids).toContain(nodeIdFor('workstream', 'ws_x'));
    expect(ids).toContain(nodeIdFor('dispatch', 'disp_1'));
  });

  it('subgraphForNode hops=0 returns the anchor only (with no edges)', () => {
    const snap = fixture();
    const sub = subgraphForNode(snap, nodeIdFor('thread', 'thread_a'), 0);
    expect(sub.nodes.length).toBe(1);
    expect(sub.edges.length).toBe(0);
  });

  it('findPath returns nodes + edges along a 2-hop path', () => {
    const snap = fixture();
    const path = findPath(snap, nodeIdFor('workstream', 'ws_x'), nodeIdFor('dispatch', 'disp_1'));
    if (!path.found) throw new Error('expected path found');
    expect(path.nodes.length).toBeGreaterThanOrEqual(2);
    expect(path.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('findPath returns {found:false} when nodes are disconnected', () => {
    const snap = fixture();
    const path = findPath(snap, nodeIdFor('thread', 'thread_a'), nodeIdFor('thread', 'unknown'));
    expect(path.found).toBe(false);
  });
});
