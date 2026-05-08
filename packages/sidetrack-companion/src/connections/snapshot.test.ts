import { describe, expect, it } from 'vitest';

import { ANNOTATION_CREATED } from '../annotations/events.js';
import { DISPATCH_LINKED, DISPATCH_RECORDED } from '../dispatches/events.js';
import { NAVIGATION_COMMITTED, type NavigationCommittedPayload } from '../navigation/events.js';
import { QUEUE_CREATED } from '../queue/events.js';
import { CAPTURE_RECORDED } from '../recall/events.js';
import { SELECTION_COPIED, SELECTION_PASTED } from '../snippets/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { THREAD_UPSERTED } from '../threads/events.js';
import type { TimelineDayProjection } from '../timeline/projection.js';
import type { TopicRevision } from '../producers/topic-revision.js';
import { WORKSTREAM_UPSERTED } from '../workstreams/events.js';
import {
  buildConnectionsSnapshot,
  findPath,
  subgraphForNode,
  type ConnectionsInput,
} from './snapshot.js';
import { edgeIdFor, nodeIdFor, type ConnectionEdgeProducedBy } from './types.js';

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

describe('connections — producedBy provenance variants', () => {
  it('accepts existing event/store provenance plus new revision producers', () => {
    const variants: readonly ConnectionEdgeProducedBy[] = [
      { source: 'event-log', eventType: THREAD_UPSERTED, dot: { replicaId: 'replica-A', seq: 1 } },
      { source: 'workboard-state', recordId: 'thread_a' },
      { source: 'timeline-projection' },
      { source: 'visit-similarity', revisionId: 'visit-resembles:v1:cosine' },
      { source: 'topic-clusterer', revisionId: 'topic-cluster:v1:union-find' },
      { source: 'engagement-classifier', revisionId: 'engagement-class:v1:rules' },
      { source: 'snippet-lineage', revisionId: 'snippet-lineage:v1:hash' },
      { source: 'cross-replica' },
    ];

    expect(variants.map((variant) => variant.source)).toContain('cross-replica');
  });
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

const navigationCommittedPayload = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly canonicalUrl: string;
  readonly commitAt: string;
}): NavigationCommittedPayload => ({
  payloadVersion: 1,
  visitId: `visit-${input.replicaId}-${String(input.seq)}`,
  url: input.canonicalUrl,
  canonicalUrl: input.canonicalUrl,
  documentId: `doc-${input.replicaId}-${String(input.seq)}`,
  parentDocumentId: null,
  tabSessionIdHash: `tab-${input.replicaId}`,
  windowSessionIdHash: `window-${input.replicaId}`,
  openerVisitId: null,
  previousVisitId: null,
  navigationSequence: input.seq,
  transitionType: 'link',
  transitionQualifiers: [],
  commitTimestamp: Date.parse(input.commitAt),
  dimensions: { provenance: { source: 'test' } },
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
    expect(edge?.confidence).toBe('asserted');
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
    expect(edge?.confidence).toBe('inferred');
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
    expect(edge?.confidence).toBe('observed');
  });
});

describe('connections — content-derived edges', () => {
  // Reusable shared block — long enough that 9 overlapping 40-char
  // shingles fit, well above the MIN_CONTIG_RUN=4 threshold.
  const QUOTED_BLOCK = 'function calculateTaxOwed(income, year) { return';
  const dayWith = (canonicalUrl: string): TimelineDayProjection => ({
    date: '2026-05-07',
    entries: [
      {
        id: canonicalUrl,
        firstSeenAt: '2026-05-07T09:00:00.000Z',
        lastSeenAt: '2026-05-07T09:30:00.000Z',
        url: canonicalUrl,
        canonicalUrl,
        visitCount: 1,
      },
    ],
    updatedAt: '2026-05-07T09:30:00.000Z',
    entryCount: 1,
  });

  it('thread_references_url fires when a capture turn cites a tracked timeline visit URL', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        timelineDays: [dayWith('https://copy.fail/exploit')],
        events: [
          buildEvent({
            seq: 1,
            type: CAPTURE_RECORDED,
            payload: {
              bac_id: 'thread_a',
              capturedAt: '2026-05-07T10:00:00.000Z',
              turns: [
                {
                  ordinal: 0,
                  role: 'user',
                  text: 'check this https://copy.fail/exploit#frag for context',
                },
              ],
            },
          }),
        ],
      }),
    );
    const edge = snap.edges.find((e) => e.kind === 'thread_references_url');
    expect(edge).toBeDefined();
    expect(edge?.fromNodeId).toBe(nodeIdFor('thread', 'thread_a'));
    expect(edge?.toNodeId).toBe(nodeIdFor('timeline-visit', 'https://copy.fail/exploit'));
    expect(edge?.confidence).toBe('observed');
    expect(edge?.producedBy.eventType).toBe(CAPTURE_RECORDED);
  });

  it('dispatch_references_url fires when a dispatch body cites a tracked URL', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        timelineDays: [dayWith('https://example.com/spec')],
        events: [
          buildEvent({
            seq: 1,
            type: DISPATCH_RECORDED,
            payload: {
              bac_id: 'disp_1',
              target: { provider: 'claude' },
              createdAt: '2026-05-07T10:00:00.000Z',
              body: 'reference doc: https://example.com/spec — please summarize',
            },
          }),
        ],
      }),
    );
    const edge = snap.edges.find((e) => e.kind === 'dispatch_references_url');
    expect(edge).toBeDefined();
    expect(edge?.fromNodeId).toBe(nodeIdFor('dispatch', 'disp_1'));
    expect(edge?.toNodeId).toBe(nodeIdFor('timeline-visit', 'https://example.com/spec'));
  });

  it('annotation_references_url fires when an annotation note cites a tracked URL', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        timelineDays: [dayWith('https://example.com/related')],
        events: [
          buildEvent({
            seq: 1,
            type: ANNOTATION_CREATED,
            payload: {
              bac_id: 'ann_1',
              url: 'https://other.example/page',
              note: 'see also https://example.com/related',
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
    const edge = snap.edges.find((e) => e.kind === 'annotation_references_url');
    expect(edge).toBeDefined();
    expect(edge?.fromNodeId).toBe(nodeIdFor('annotation', 'ann_1'));
    expect(edge?.toNodeId).toBe(nodeIdFor('timeline-visit', 'https://example.com/related'));
  });

  it('URL with auth-token query param gets sanitized before matching', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        // The timeline visit's canonical URL was sanitized BEFORE
        // landing in the projection; the capture text contains the
        // unsanitized form. Both must canonicalize to the same key.
        timelineDays: [dayWith('https://copy.fail/exploit')],
        events: [
          buildEvent({
            seq: 1,
            type: CAPTURE_RECORDED,
            payload: {
              bac_id: 'thread_a',
              capturedAt: '2026-05-07T10:00:00.000Z',
              turns: [
                {
                  ordinal: 0,
                  role: 'user',
                  text: 'leaked link: https://copy.fail/exploit?token=abc',
                },
              ],
            },
          }),
        ],
      }),
    );
    const edge = snap.edges.find((e) => e.kind === 'thread_references_url');
    expect(edge).toBeDefined();
    // Stored visit id has no token — the edge points at the canonical visit.
    expect(edge?.toNodeId).toBe(nodeIdFor('timeline-visit', 'https://copy.fail/exploit'));
  });

  it('thread_quotes_thread fires when one capture turn contains a ≥40-char substring of another', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        events: [
          buildEvent({
            seq: 1,
            type: CAPTURE_RECORDED,
            payload: {
              bac_id: 'thread_a',
              capturedAt: '2026-05-07T10:00:00.000Z',
              turns: [
                {
                  ordinal: 0,
                  role: 'assistant',
                  text: `here's the helper:\n${QUOTED_BLOCK} 0;\n}`,
                },
              ],
            },
          }),
          buildEvent({
            seq: 2,
            type: CAPTURE_RECORDED,
            payload: {
              bac_id: 'thread_b',
              capturedAt: '2026-05-07T11:00:00.000Z',
              turns: [
                {
                  ordinal: 0,
                  role: 'user',
                  text: `please review:\n${QUOTED_BLOCK} 0;\n}`,
                },
              ],
            },
          }),
        ],
      }),
    );
    const edges = snap.edges.filter((e) => e.kind === 'thread_quotes_thread');
    expect(edges.length).toBeGreaterThanOrEqual(1);
    const ids = edges.map((e) => `${e.fromNodeId}->${e.toNodeId}`).sort();
    // Both directions emit (each thread quotes the other).
    expect(ids).toContain(`${nodeIdFor('thread', 'thread_a')}->${nodeIdFor('thread', 'thread_b')}`);
    expect(ids).toContain(`${nodeIdFor('thread', 'thread_b')}->${nodeIdFor('thread', 'thread_a')}`);
    expect(edges[0]?.producedBy.recordId).toBeDefined();
    expect(edges[0]?.producedBy.recordId?.length).toBe(12);
  });

  it('cross-replica: same capture observed on two replicas dedupes to one edge', () => {
    const snap = buildConnectionsSnapshot(
      emptyInput({
        timelineDays: [dayWith('https://copy.fail/exploit')],
        events: [
          buildEvent({
            seq: 1,
            replicaId: 'replica-laptop',
            type: CAPTURE_RECORDED,
            payload: {
              bac_id: 'thread_a',
              capturedAt: '2026-05-07T10:00:00.000Z',
              turns: [
                { ordinal: 0, role: 'user', text: 'see https://copy.fail/exploit' },
              ],
            },
          }),
          buildEvent({
            seq: 2,
            replicaId: 'replica-desktop',
            type: CAPTURE_RECORDED,
            payload: {
              bac_id: 'thread_a',
              capturedAt: '2026-05-07T10:00:00.000Z',
              turns: [
                { ordinal: 0, role: 'user', text: 'see https://copy.fail/exploit' },
              ],
            },
          }),
        ],
      }),
    );
    const refs = snap.edges.filter((e) => e.kind === 'thread_references_url');
    expect(refs.length).toBe(1);
  });

  it('user-story walk: HN→Claude→Codex→ChatGPT produces every emitted edge kind', () => {
    // The user's narrated story:
    //   1. read HN + copy.fail + Google searches            → timeline-visit
    //   2. asked Claude (filed under research workstream)   → thread, ws
    //   3. coding session via dispatch                       → dispatch + cs
    //   4. URL pasted into Claude turn                       → references_url
    //   5. dispatch reply landed in a sibling thread         → dispatch.linked
    //   6. ChatGPT review of Claude's code                   → quotes_thread
    //   7. dispatch body cites the search URL                → references_url
    //   8. annotation note cites a URL                       → ann_references_url
    //   9. annotation URL matches the Claude thread URL      → ann_targets_thread
    //  10. queue + reminder for both scopes                   → defer family
    //
    // The fixture produces every edge kind the reducer emits
    // (16 of the 17 declared kinds; annotation_targets_workstream
    // is declared-but-unused and intentionally absent).
    const HN_URL = 'https://news.ycombinator.com/item?id=42';
    const COPY_FAIL_URL = 'https://copy.fail/exploit';
    const CLAUDE_THREAD_URL = 'https://claude.ai/chat/abc';
    const CHATGPT_THREAD_URL = 'https://chatgpt.com/c/def';
    // 50 chars — ten 40-char shingles after concat overlap, well
    // above the 4-shingle contiguous-run threshold.
    const SHARED_CODE_BLOCK =
      'function calculateTaxOwed(income, year) { return';

    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: HN_URL,
          firstSeenAt: '2026-05-07T09:00:00.000Z',
          lastSeenAt: '2026-05-07T09:15:00.000Z',
          url: HN_URL,
          canonicalUrl: HN_URL,
          visitCount: 1,
        },
        {
          id: COPY_FAIL_URL,
          firstSeenAt: '2026-05-07T09:20:00.000Z',
          lastSeenAt: '2026-05-07T09:25:00.000Z',
          url: COPY_FAIL_URL,
          canonicalUrl: COPY_FAIL_URL,
          visitCount: 1,
        },
        {
          id: CLAUDE_THREAD_URL,
          firstSeenAt: '2026-05-07T09:30:00.000Z',
          lastSeenAt: '2026-05-07T09:35:00.000Z',
          url: CLAUDE_THREAD_URL,
          canonicalUrl: CLAUDE_THREAD_URL,
          visitCount: 1,
        },
      ],
      updatedAt: '2026-05-07T09:35:00.000Z',
      entryCount: 3,
    };

    const snap = buildConnectionsSnapshot(
      emptyInput({
        threads: [
          {
            bac_id: 'thread_claude',
            title: 'Tax helper question',
            threadUrl: CLAUDE_THREAD_URL,
            canonicalUrl: CLAUDE_THREAD_URL,
            primaryWorkstreamId: 'ws_research',
          },
          {
            bac_id: 'thread_chatgpt',
            title: 'Code review',
            threadUrl: CHATGPT_THREAD_URL,
            canonicalUrl: CHATGPT_THREAD_URL,
            primaryWorkstreamId: 'ws_research',
          },
        ],
        workstreams: [
          { bac_id: 'ws_research', title: 'Research', parentId: 'ws_root' },
          { bac_id: 'ws_root', title: 'Engineering', children: ['ws_research'] },
        ],
        dispatches: [
          {
            bac_id: 'disp_codex',
            title: 'Codex: scaffold tax helper',
            target: { provider: 'codex' },
            status: 'sent',
            createdAt: '2026-05-07T10:30:00.000Z',
            sourceThreadId: 'thread_claude',
            workstreamId: 'ws_research',
            mcpRequest: { codingSessionId: 'cs_tax' },
          },
        ],
        codingSessions: [
          {
            bac_id: 'cs_tax',
            workstreamId: 'ws_research',
            tool: 'codex',
            cwd: '/work/tax',
            name: 'tax-helper',
            attachedAt: '2026-05-07T10:32:00.000Z',
            lastSeenAt: '2026-05-07T11:30:00.000Z',
            status: 'attached',
          },
        ],
        reminders: [
          {
            bac_id: 'rem_followup',
            threadId: 'thread_claude',
            provider: 'claude',
            detectedAt: '2026-05-07T13:00:00.000Z',
            status: 'new',
          },
        ],
        timelineDays: [day],
        events: [
          // 1. user pastes HN + copy.fail URLs into Claude turn → 2x thread_references_url
          buildEvent({
            seq: 1,
            type: CAPTURE_RECORDED,
            payload: {
              bac_id: 'thread_claude',
              capturedAt: '2026-05-07T10:00:00.000Z',
              turns: [
                {
                  ordinal: 0,
                  role: 'user',
                  text: `i want a tax helper. context: ${HN_URL} and ${COPY_FAIL_URL}`,
                },
                {
                  ordinal: 1,
                  role: 'assistant',
                  text: `here's the code: ${SHARED_CODE_BLOCK} 0; }\n use it for the helper.`,
                },
              ],
            },
          }),
          // 2. dispatch.recorded body cites the HN URL → dispatch_references_url
          buildEvent({
            seq: 2,
            type: DISPATCH_RECORDED,
            payload: {
              bac_id: 'disp_codex',
              target: { provider: 'codex' },
              createdAt: '2026-05-07T10:30:00.000Z',
              body: `please scaffold the helper. background: ${HN_URL}`,
            },
          }),
          // 3. dispatch.linked event → dispatch_reply_landed_in_thread
          buildEvent({
            seq: 3,
            type: DISPATCH_LINKED,
            payload: { dispatchId: 'disp_codex', threadId: 'thread_chatgpt' },
          }),
          // 4. user pastes Claude's code into ChatGPT for review → thread_quotes_thread
          buildEvent({
            seq: 4,
            type: CAPTURE_RECORDED,
            payload: {
              bac_id: 'thread_chatgpt',
              capturedAt: '2026-05-07T11:00:00.000Z',
              turns: [
                {
                  ordinal: 0,
                  role: 'user',
                  text: `please review this snippet:\n${SHARED_CODE_BLOCK} 0; }\n is it right?`,
                },
              ],
            },
          }),
          // 5. queue both kinds: thread + workstream
          buildEvent({
            seq: 5,
            type: QUEUE_CREATED,
            payload: {
              bac_id: 'q_thread',
              text: 'follow up on tax helper',
              scope: 'thread',
              targetId: 'thread_claude',
              status: 'pending',
            },
          }),
          buildEvent({
            seq: 6,
            type: QUEUE_CREATED,
            payload: {
              bac_id: 'q_ws',
              text: 'review research progress',
              scope: 'workstream',
              targetId: 'ws_research',
              status: 'pending',
            },
          }),
          // 6. annotation on the Claude thread URL → annotation_targets_thread
          //    + the note also cites the HN URL → annotation_references_url
          buildEvent({
            seq: 7,
            type: ANNOTATION_CREATED,
            payload: {
              bac_id: 'ann_1',
              url: CLAUDE_THREAD_URL,
              note: `cross-ref: ${HN_URL}`,
              anchor: {
                textQuote: { exact: 'helper', prefix: 'tax ', suffix: '' },
                textPosition: { start: 0, end: 6 },
                cssSelector: 'div',
              },
            },
          }),
        ],
      }),
    );

    // Every edge kind the reducer emits should appear at least once.
    const expectedKinds = new Set<string>([
      'thread_in_workstream',
      'workstream_parent_of',
      'dispatch_from_thread',
      'dispatch_in_workstream',
      'dispatch_reply_landed_in_thread',
      'dispatch_requested_coding_session',
      'queue_targets_thread',
      'queue_targets_workstream',
      'reminder_for_thread',
      'coding_session_in_workstream',
      'timeline_same_url_as_thread',
      'annotation_targets_thread',
      'thread_references_url',
      'dispatch_references_url',
      'annotation_references_url',
      'thread_quotes_thread',
    ]);
    const actualKinds = new Set<string>(snap.edges.map((e) => e.kind as string));
    const missing = [...expectedKinds].filter((k) => !actualKinds.has(k));
    expect(missing).toEqual([]);

    // Spot-check the cross-tool bridge: ChatGPT thread quotes the
    // Claude thread (or vice versa — both directions emit).
    const quotes = snap.edges.filter((e) => e.kind === 'thread_quotes_thread');
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes[0]?.producedBy.recordId).toBeDefined();

    // Spot-check that timeline-visit nodes exist for both tracked
    // URLs and that thread_references_url points to them.
    const refEdges = snap.edges.filter((e) => e.kind === 'thread_references_url');
    const visitTargets = new Set(refEdges.map((e) => e.toNodeId));
    expect(visitTargets.has(nodeIdFor('timeline-visit', HN_URL))).toBe(true);
    expect(visitTargets.has(nodeIdFor('timeline-visit', COPY_FAIL_URL))).toBe(true);
  });

  it('CAPTURE_RECORDED with separate `threadId` attributes URL-ref edges to the thread, not to the per-capture bac_id', () => {
    // This mirrors what /v1/events POSTs: payload.bac_id is the
    // capture event's own id; payload.threadId is the thread the
    // capture belongs to. The reducer must use threadId as the
    // thread-node key.
    const snap = buildConnectionsSnapshot(
      emptyInput({
        timelineDays: [dayWith('https://news.ycombinator.com/item?id=42')],
        events: [
          buildEvent({
            seq: 1,
            type: CAPTURE_RECORDED,
            payload: {
              // capture event's own bac_id (per-call), NOT the thread id
              bac_id: 'capture_evt_001',
              threadId: 't_anchor',
              threadUrl: 'https://claude.ai/chat/anchor',
              capturedAt: '2026-05-07T10:00:00.000Z',
              turns: [
                {
                  ordinal: 0,
                  role: 'user',
                  text: 'context: https://news.ycombinator.com/item?id=42',
                },
              ],
            },
          }),
        ],
      }),
    );
    const refEdge = snap.edges.find((e) => e.kind === 'thread_references_url');
    expect(refEdge).toBeDefined();
    // Edge must point to the thread id (t_anchor), NOT the capture
    // event id (capture_evt_001).
    expect(refEdge?.fromNodeId).toBe(nodeIdFor('thread', 't_anchor'));
    // No phantom thread node for the capture event id.
    const ids = snap.nodes.map((n) => n.id);
    expect(ids).not.toContain(nodeIdFor('thread', 'capture_evt_001'));
  });

  it('thread_text_mentions_search_query fires when chat text contains a tracked search visit query', () => {
    // Search visit with query "Linux crypto subsystem" + a chat
    // whose user turn mentions the same phrase verbatim. The chat
    // never pastes the search URL — only the topic text.
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://www.google.com/search?q=Linux+crypto+subsystem',
          firstSeenAt: '2026-05-07T09:00:00.000Z',
          lastSeenAt: '2026-05-07T09:05:00.000Z',
          url: 'https://www.google.com/search?q=Linux+crypto+subsystem',
          canonicalUrl: 'https://www.google.com/search?q=Linux+crypto+subsystem',
          visitCount: 1,
        },
      ],
      updatedAt: '2026-05-07T09:05:00.000Z',
      entryCount: 1,
    };
    const snap = buildConnectionsSnapshot(
      emptyInput({
        timelineDays: [day],
        events: [
          buildEvent({
            seq: 1,
            type: CAPTURE_RECORDED,
            payload: {
              bac_id: 'thread_a',
              threadId: 'thread_a',
              capturedAt: '2026-05-07T10:00:00.000Z',
              turns: [
                {
                  ordinal: 0,
                  role: 'user',
                  text: 'explain the Linux crypto subsystem angle on this CVE',
                },
              ],
            },
          }),
        ],
      }),
    );
    const edge = snap.edges.find((e) => e.kind === 'thread_text_mentions_search_query');
    expect(edge, 'search-query edge expected').toBeDefined();
    expect(edge?.fromNodeId).toBe(nodeIdFor('thread', 'thread_a'));
    expect(edge?.toNodeId).toBe(
      nodeIdFor('timeline-visit', 'https://www.google.com/search?q=Linux+crypto+subsystem'),
    );
    // The visit node carries the searchQuery metadata.
    const visitNode = snap.nodes.find((n) => n.kind === 'timeline-visit');
    expect(visitNode?.metadata['searchQuery']).toBe('linux crypto subsystem');
  });

  it('thread_text_mentions_search_query is whole-word, case-insensitive', () => {
    const buildSnap = (chatText: string) => {
      const day: TimelineDayProjection = {
        date: '2026-05-07',
        entries: [
          {
            id: 'https://example.com/search?q=react',
            firstSeenAt: '2026-05-07T09:00:00.000Z',
            lastSeenAt: '2026-05-07T09:05:00.000Z',
            url: 'https://example.com/search?q=react',
            canonicalUrl: 'https://example.com/search?q=react',
            visitCount: 1,
          },
        ],
        updatedAt: '2026-05-07T09:05:00.000Z',
        entryCount: 1,
      };
      return buildConnectionsSnapshot(
        emptyInput({
          timelineDays: [day],
          events: [
            buildEvent({
              seq: 1,
              type: CAPTURE_RECORDED,
              payload: {
                bac_id: 'thread_a',
                threadId: 'thread_a',
                capturedAt: '2026-05-07T10:00:00.000Z',
                turns: [{ ordinal: 0, role: 'user', text: chatText }],
              },
            }),
          ],
        }),
      );
    };
    // "react" too short (3 chars) — actually 5 chars, should match
    const matching = buildSnap('I love using REACT for this');
    expect(
      matching.edges.some((e) => e.kind === 'thread_text_mentions_search_query'),
      'case-insensitive whole-word match',
    ).toBe(true);
    // Substring "reactivity" must NOT match the whole word "react"
    const nonMatching = buildSnap('I care about reactivity in Vue.');
    expect(
      nonMatching.edges.some((e) => e.kind === 'thread_text_mentions_search_query'),
      'must require whole-word boundary',
    ).toBe(false);
  });

  it('thread_text_mentions_search_query skips queries shorter than 4 chars (noise floor)', () => {
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://www.google.com/search?q=ai',
          firstSeenAt: '2026-05-07T09:00:00.000Z',
          lastSeenAt: '2026-05-07T09:05:00.000Z',
          url: 'https://www.google.com/search?q=ai',
          canonicalUrl: 'https://www.google.com/search?q=ai',
          visitCount: 1,
        },
      ],
      updatedAt: '2026-05-07T09:05:00.000Z',
      entryCount: 1,
    };
    const snap = buildConnectionsSnapshot(
      emptyInput({
        timelineDays: [day],
        events: [
          buildEvent({
            seq: 1,
            type: CAPTURE_RECORDED,
            payload: {
              bac_id: 'thread_a',
              threadId: 'thread_a',
              capturedAt: '2026-05-07T10:00:00.000Z',
              turns: [{ ordinal: 0, role: 'user', text: 'I work on AI tooling' }],
            },
          }),
        ],
      }),
    );
    expect(
      snap.edges.some((e) => e.kind === 'thread_text_mentions_search_query'),
      'short queries should not connect everything',
    ).toBe(false);
  });

  it('Pass 7 emits visit_resembles_visit edges from the active similarity revision', () => {
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://example.test/a',
          firstSeenAt: '2026-05-07T09:00:00.000Z',
          lastSeenAt: '2026-05-07T09:05:00.000Z',
          url: 'https://example.test/a',
          canonicalUrl: 'https://example.test/a',
          title: 'A',
          provider: 'generic',
          visitCount: 1,
        },
        {
          id: 'https://example.test/b',
          firstSeenAt: '2026-05-07T09:10:00.000Z',
          lastSeenAt: '2026-05-07T09:15:00.000Z',
          url: 'https://example.test/b',
          canonicalUrl: 'https://example.test/b',
          title: 'B',
          provider: 'generic',
          visitCount: 1,
        },
      ],
      updatedAt: '2026-05-07T09:15:00.000Z',
      entryCount: 2,
    };
    const snap = buildConnectionsSnapshot(
      emptyInput({
        timelineDays: [day],
        visitSimilarity: {
          revisionId: 'visit-sim-rev-1',
          modelId: 'Xenova/multilingual-e5-small',
          modelRevision: 'model-rev',
          featureSchemaVersion: 1,
          threshold: 0.85,
          edges: [
            {
              fromVisitKey: 'https://example.test/a',
              toVisitKey: 'https://example.test/b',
              cosine: 0.91,
            },
            {
              fromVisitKey: 'https://example.test/a',
              toVisitKey: 'https://example.test/missing',
              cosine: 0.99,
            },
          ],
          producedAt: 1_777_777_777_000,
        },
      }),
    );

    const edge = snap.edges.find((candidate) => candidate.kind === 'visit_resembles_visit');
    expect(edge).toBeDefined();
    expect(edge?.fromNodeId).toBe(nodeIdFor('timeline-visit', 'https://example.test/a'));
    expect(edge?.toNodeId).toBe(nodeIdFor('timeline-visit', 'https://example.test/b'));
    expect(edge?.observedAt).toBe('2026-05-07T09:15:00.000Z');
    expect(edge?.confidence).toBe('inferred');
    expect(edge?.family).toBe('urlmatch');
    expect(edge?.producedBy).toEqual({
      source: 'visit-similarity',
      revisionId: 'visit-sim-rev-1',
    });
    expect(snap.edges.filter((candidate) => candidate.kind === 'visit_resembles_visit')).toHaveLength(1);
  });

  it('visit_in_workstream fires when the timeline entry carries a workstreamId (active-workstream attribution)', () => {
    // Active-workstream attribution: the observer stamps
    // workstreamId on visits when the user has a workstream
    // focused. Two visits — one with workstreamId, one without.
    // Only the tagged one emits visit_in_workstream.
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://copy.fail/',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:00:30.000Z',
          url: 'https://copy.fail/',
          canonicalUrl: 'https://copy.fail/',
          visitCount: 1,
          workstreamId: 'ws_security',
        },
        {
          id: 'https://www.youtube.com/watch?v=rY44ViY45q8',
          firstSeenAt: '2026-05-07T10:01:00.000Z',
          lastSeenAt: '2026-05-07T10:30:00.000Z',
          url: 'https://www.youtube.com/watch?v=rY44ViY45q8',
          canonicalUrl: 'https://www.youtube.com/watch?v=rY44ViY45q8',
          visitCount: 1,
          // intentionally no workstreamId — stays orphan
        },
      ],
      updatedAt: '2026-05-07T10:30:00.000Z',
      entryCount: 2,
    };
    const snap = buildConnectionsSnapshot(emptyInput({ timelineDays: [day] }));
    const visitEdges = snap.edges.filter((e) => e.kind === 'visit_in_workstream');
    expect(visitEdges.length).toBe(1);
    expect(visitEdges[0]?.fromNodeId).toBe(nodeIdFor('timeline-visit', 'https://copy.fail'));
    expect(visitEdges[0]?.toNodeId).toBe(nodeIdFor('workstream', 'ws_security'));
    expect(visitEdges[0]?.confidence).toBe('inferred');
    expect(visitEdges[0]?.producedBy.source).toBe('timeline-projection');
    // The visit-node metadata also carries the workstreamId.
    const taggedVisit = snap.nodes.find(
      (n) => n.id === nodeIdFor('timeline-visit', 'https://copy.fail'),
    );
    expect(taggedVisit?.metadata['workstreamId']).toBe('ws_security');
    // The untagged visit has no metadata.workstreamId.
    const orphanVisit = snap.nodes.find(
      (n) =>
        n.id === nodeIdFor('timeline-visit', 'https://www.youtube.com/watch?v=rY44ViY45q8'),
    );
    expect(orphanVisit?.metadata['workstreamId']).toBeUndefined();
  });

  it('visit_in_workstream subgraph: anchored on workstream reaches every tagged ambient visit', () => {
    // The acceptance-criteria scenario: visits to copy.fail/ and
    // YouTube (ambient — no chat / dispatch / annotation references
    // them) attach to the workstream when the active-workstream
    // observer tagged them. Anchoring on the workstream reaches
    // both via 1-hop visit_in_workstream edges.
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://copy.fail/',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:00:30.000Z',
          url: 'https://copy.fail/',
          canonicalUrl: 'https://copy.fail/',
          visitCount: 1,
          workstreamId: 'ws_security',
        },
        {
          id: 'https://www.youtube.com/watch?v=rY44ViY45q8',
          firstSeenAt: '2026-05-07T10:30:00.000Z',
          lastSeenAt: '2026-05-07T10:35:00.000Z',
          url: 'https://www.youtube.com/watch?v=rY44ViY45q8',
          canonicalUrl: 'https://www.youtube.com/watch?v=rY44ViY45q8',
          visitCount: 1,
          workstreamId: 'ws_security',
        },
      ],
      updatedAt: '2026-05-07T10:35:00.000Z',
      entryCount: 2,
    };
    const snap = buildConnectionsSnapshot(emptyInput({ timelineDays: [day] }));
    const sub = subgraphForNode(snap, nodeIdFor('workstream', 'ws_security'), 1);
    const ids = new Set(sub.nodes.map((n) => n.id));
    expect(ids.has(nodeIdFor('timeline-visit', 'https://copy.fail'))).toBe(true);
    expect(
      ids.has(nodeIdFor('timeline-visit', 'https://www.youtube.com/watch?v=rY44ViY45q8')),
    ).toBe(true);
  });

  it('Pass 8 emits topic nodes, membership, workstream, and lineage edges', () => {
    const topicRevision: TopicRevision = {
      revisionId: 'topic-rev-1',
      visitSimilarityRevisionId: 'visit-sim-1',
      cosineThreshold: 0.85,
      algorithmVersion: 'union-find:v1',
      topics: [
        {
          topicId: 'topic:abc123',
          memberCanonicalUrls: [
            'https://topic.test/a',
            'https://topic.test/b',
            'https://topic.test/c',
            'https://topic.test/d',
          ],
          metadata: {
            memberCount: 4,
            dominantWorkstreamId: 'ws_topic',
            representativeTitles: ['Topic A', 'Topic B'],
            firstObservedAt: '2026-05-07T09:00:00.000Z',
            lastObservedAt: '2026-05-07T12:00:00.000Z',
            cohesion: 0.91,
          },
        },
      ],
      lineage: [
        {
          fromTopicId: 'topic:old',
          toTopicId: 'topic:abc123',
          kind: 'merge',
          observedAt: '2026-05-07T12:00:00.000Z',
        },
      ],
      producedAt: Date.parse('2026-05-07T12:00:00.000Z'),
    };
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://topic.test/a',
          firstSeenAt: '2026-05-07T09:00:00.000Z',
          lastSeenAt: '2026-05-07T10:00:00.000Z',
          url: 'https://topic.test/a',
          canonicalUrl: 'https://topic.test/a',
          title: 'Topic A',
          visitCount: 1,
          workstreamId: 'ws_topic',
        },
        {
          id: 'https://topic.test/b',
          firstSeenAt: '2026-05-07T09:10:00.000Z',
          lastSeenAt: '2026-05-07T10:10:00.000Z',
          url: 'https://topic.test/b',
          canonicalUrl: 'https://topic.test/b',
          title: 'Topic B',
          visitCount: 1,
          workstreamId: 'ws_topic',
        },
        {
          id: 'https://topic.test/c',
          firstSeenAt: '2026-05-07T09:20:00.000Z',
          lastSeenAt: '2026-05-07T10:20:00.000Z',
          url: 'https://topic.test/c',
          canonicalUrl: 'https://topic.test/c',
          title: 'Topic C',
          visitCount: 1,
          workstreamId: 'ws_topic',
        },
        {
          id: 'https://topic.test/d',
          firstSeenAt: '2026-05-07T09:30:00.000Z',
          lastSeenAt: '2026-05-07T10:30:00.000Z',
          url: 'https://topic.test/d',
          canonicalUrl: 'https://topic.test/d',
          title: 'Topic D',
          visitCount: 1,
          workstreamId: 'ws_other',
        },
      ],
      updatedAt: '2026-05-07T10:30:00.000Z',
      entryCount: 4,
    };

    const snap = buildConnectionsSnapshot(
      emptyInput({ timelineDays: [day], topicRevision }),
    );
    const topicNodeId = nodeIdFor('topic', 'topic:abc123');
    const topicNode = snap.nodes.find((node) => node.id === topicNodeId);

    expect(topicNode?.label).toBe('Topic A');
    expect(topicNode?.metadata['cohesion']).toBe(0.91);
    expect(snap.edges.filter((edge) => edge.kind === 'visit_in_topic')).toHaveLength(4);
    expect(
      snap.edges.find(
        (edge) =>
          edge.kind === 'topic_in_workstream' &&
          edge.fromNodeId === topicNodeId &&
          edge.toNodeId === nodeIdFor('workstream', 'ws_topic'),
      ),
    ).toBeDefined();
    const lineage = snap.edges.find((edge) => edge.kind === 'topic.lineage');
    expect(lineage?.fromNodeId).toBe(nodeIdFor('topic', 'topic:old'));
    expect(lineage?.toNodeId).toBe(topicNodeId);
    expect(lineage?.metadata?.['lineageKind']).toBe('merge');
    expect(lineage?.producedBy).toEqual({
      source: 'topic-clusterer',
      revisionId: 'topic-rev-1',
    });
  });

  it('determinism: same fixture in two event orders produces byte-identical snapshots', () => {
    const events: AcceptedEvent[] = [
      buildEvent({
        seq: 1,
        type: CAPTURE_RECORDED,
        payload: {
          bac_id: 'thread_a',
          capturedAt: '2026-05-07T10:00:00.000Z',
          turns: [
            { ordinal: 0, role: 'assistant', text: `${QUOTED_BLOCK} 0;` },
            { ordinal: 1, role: 'user', text: 'check https://copy.fail/exploit' },
          ],
        },
      }),
      buildEvent({
        seq: 2,
        type: DISPATCH_RECORDED,
        payload: {
          bac_id: 'disp_1',
          target: { provider: 'claude' },
          createdAt: '2026-05-07T10:30:00.000Z',
          body: 'see also https://copy.fail/exploit',
        },
      }),
      buildEvent({
        seq: 3,
        type: CAPTURE_RECORDED,
        payload: {
          bac_id: 'thread_b',
          capturedAt: '2026-05-07T11:00:00.000Z',
          turns: [
            { ordinal: 0, role: 'user', text: `please review: ${QUOTED_BLOCK} 0;` },
          ],
        },
      }),
    ];
    const fwd = JSON.stringify(
      buildConnectionsSnapshot(
        emptyInput({ events, timelineDays: [dayWith('https://copy.fail/exploit')] }),
      ),
    );
    const rev = JSON.stringify(
      buildConnectionsSnapshot(
        emptyInput({
          events: [...events].reverse(),
          timelineDays: [dayWith('https://copy.fail/exploit')],
        }),
      ),
    );
    const shuffled = JSON.stringify(
      buildConnectionsSnapshot(
        emptyInput({
          events: [events[2]!, events[0]!, events[1]!],
          timelineDays: [dayWith('https://copy.fail/exploit')],
        }),
      ),
    );
    expect(rev).toBe(fwd);
    expect(shuffled).toBe(fwd);
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

  it('Pass 9 emits visit_observed_on_replica edges and replica nodes from navigation.committed', () => {
    const url = 'https://example.com/shared';
    const snap = buildConnectionsSnapshot(
      emptyInput({
        events: [
          buildEvent({
            seq: 1,
            replicaId: 'replica-A',
            type: NAVIGATION_COMMITTED,
            payload: navigationCommittedPayload({
              replicaId: 'replica-A',
              seq: 1,
              canonicalUrl: url,
              commitAt: '2026-05-07T09:00:00.000Z',
            }),
            acceptedAtMs: Date.parse('2026-05-07T09:00:01.000Z'),
          }),
          buildEvent({
            seq: 2,
            replicaId: 'replica-A',
            type: NAVIGATION_COMMITTED,
            payload: navigationCommittedPayload({
              replicaId: 'replica-A',
              seq: 2,
              canonicalUrl: 'https://example.com/only-a',
              commitAt: '2026-05-07T09:30:00.000Z',
            }),
            acceptedAtMs: Date.parse('2026-05-07T09:30:01.000Z'),
          }),
          buildEvent({
            seq: 1,
            replicaId: 'replica-B',
            type: NAVIGATION_COMMITTED,
            payload: navigationCommittedPayload({
              replicaId: 'replica-B',
              seq: 1,
              canonicalUrl: url,
              commitAt: '2026-05-07T10:00:00.000Z',
            }),
            acceptedAtMs: Date.parse('2026-05-07T10:00:01.000Z'),
          }),
        ],
      }),
    );

    const crossReplicaEdges = snap.edges.filter(
      (edge) => edge.kind === 'visit_observed_on_replica',
    );
    expect(crossReplicaEdges).toHaveLength(2);
    expect(crossReplicaEdges.map((edge) => `${edge.fromNodeId}->${edge.toNodeId}`)).toEqual([
      `${nodeIdFor('timeline-visit', url)}->${nodeIdFor('replica', 'replica-A')}`,
      `${nodeIdFor('timeline-visit', url)}->${nodeIdFor('replica', 'replica-B')}`,
    ]);
    expect(crossReplicaEdges.every((edge) => edge.confidence === 'observed')).toBe(true);
    expect(crossReplicaEdges.every((edge) => edge.producedBy.source === 'cross-replica')).toBe(
      true,
    );

    const replicaA = snap.nodes.find((node) => node.id === nodeIdFor('replica', 'replica-A'));
    expect(replicaA?.kind).toBe('replica');
    expect(replicaA?.metadata).toEqual({
      firstSeenAt: '2026-05-07T09:00:00.000Z',
      lastSeenAt: '2026-05-07T09:30:00.000Z',
      replicaId: 'replica-A',
    });
    expect(replicaA?.firstSeenAt).toBe('2026-05-07T09:00:00.000Z');
    expect(replicaA?.lastSeenAt).toBe('2026-05-07T09:30:00.000Z');
    expect(snap.nodes.find((node) => node.id === nodeIdFor('timeline-visit', url))).toBeDefined();
    expect(
      snap.edges.some(
        (edge) => edge.fromNodeId === nodeIdFor('timeline-visit', 'https://example.com/only-a'),
      ),
    ).toBe(false);
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

  it('Pass 10 emits snippet lineage edges from copy/paste fixtures', () => {
    const copied = {
      payloadVersion: 1,
      visitId: 'visit:source',
      selectionHash: 'abcdef1234567890abcdef1234567890',
      simhash64: 'AAAAAAAAAAA=',
      charCount: 20,
      lineCount: 1,
      contentKindHint: 'prose',
      rawTextStored: false,
    };
    const pasted = {
      payloadVersion: 1,
      destinationKind: 'thread',
      selectionHash: copied.selectionHash,
      simhash64: copied.simhash64,
      charCount: 20,
      rawTextStored: false,
    };
    const snap = buildConnectionsSnapshot(
      emptyInput({
        events: [
          buildEvent({ seq: 1, type: SELECTION_COPIED, payload: copied }),
          buildEvent({
            seq: 2,
            type: SELECTION_PASTED,
            payload: { ...pasted, destinationId: 'thread_a' },
          }),
          buildEvent({
            seq: 3,
            type: SELECTION_PASTED,
            payload: { ...pasted, destinationId: 'thread_b' },
          }),
        ],
      }),
    );
    expect(snap.nodes.find((node) => node.kind === 'snippet')).toBeDefined();
    expect(snap.edges.find((edge) => edge.kind === 'snippet_copied_from_visit')).toBeDefined();
    expect(snap.edges.filter((edge) => edge.kind === 'snippet_pasted_into_thread')).toHaveLength(2);
    expect(snap.edges.filter((edge) => edge.kind === 'snippet_reused_across_threads')).toHaveLength(2);
    expect(
      snap.edges.every((edge) =>
        edge.kind.startsWith('snippet_') ? edge.producedBy.source === 'snippet-lineage' : true,
      ),
    ).toBe(true);
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
