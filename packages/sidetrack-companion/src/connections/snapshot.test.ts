import { describe, expect, it } from 'vitest';

import { ANNOTATION_CREATED } from '../annotations/events.js';
import { CONTINUATION_CLASSIFIER_REVISION_ID } from '../continuation/classifier.js';
import { DISPATCH_LINKED, DISPATCH_RECORDED } from '../dispatches/events.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import { NAVIGATION_COMMITTED, type NavigationCommittedPayload } from '../navigation/events.js';
import { QUEUE_CREATED } from '../queue/events.js';
import { FEATURE_SCHEMA_VERSION, type CandidatePairFeatures } from '../ranker/feature-schema.js';
import { CAPTURE_RECORDED } from '../recall/events.js';
import { SELECTION_COPIED, SELECTION_PASTED } from '../snippets/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  createEmptyTabSessionProjection,
  projectTabSessions,
  TAB_SESSION_PROJECTION_SCHEMA_VERSION,
  type TabSessionProjection,
} from '../tabsession/projection.js';
import { THREAD_UPSERTED } from '../threads/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../timeline/events.js';
import { projectUrls, URL_PROJECTION_SCHEMA_VERSION } from '../urls/projection.js';
import type { TimelineDayProjection } from '../timeline/projection.js';
import { TOPIC_UNION_FIND_REVISION_KEY, type TopicRevision } from '../producers/topic-revision.js';
import { VISUAL_FINGERPRINT_OBSERVED } from '../visual/events.js';
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
  tabSessionProjection: createEmptyTabSessionProjection(),
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
      { source: 'continuation-classifier', revisionId: 'continuation-classifier:v1' },
      { source: 'ranker', revisionId: 'ranker-rev-1' },
      { source: 'cross-replica' },
    ];

    expect(variants.map((variant) => variant.source)).toContain('cross-replica');
    expect(variants.map((variant) => variant.source)).toContain('continuation-classifier');
    expect(variants.map((variant) => variant.source)).toContain('ranker');
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
  readonly previousVisitId?: string | null;
  readonly openerVisitId?: string | null;
}): NavigationCommittedPayload => ({
  payloadVersion: 1,
  visitId: `visit-${input.replicaId}-${String(input.seq)}`,
  url: input.canonicalUrl,
  canonicalUrl: input.canonicalUrl,
  documentId: `doc-${input.replicaId}-${String(input.seq)}`,
  parentDocumentId: null,
  tabSessionIdHash: `tab-${input.replicaId}`,
  windowSessionIdHash: `window-${input.replicaId}`,
  openerVisitId: input.openerVisitId ?? null,
  previousVisitId: input.previousVisitId ?? null,
  navigationSequence: input.seq,
  transitionType: 'link',
  transitionQualifiers: [],
  commitTimestamp: Date.parse(input.commitAt),
  dimensions: { provenance: { source: 'test' } },
});

const rankerContributionsFor = (
  score: number,
): Readonly<Record<keyof CandidatePairFeatures, number>> => ({
  schemaVersion: 0,
  same_workstream: 0,
  opener_chain_depth: 0,
  in_navigation_chain: 0,
  same_canonical_url: 0,
  same_host: score * 0.5,
  same_repo: 0,
  same_search_query: 0,
  same_copied_snippet_count: 0,
  shared_title_tokens: score * 0.25,
  shared_path_tokens: 0,
  cosine_similarity: 0,
  recency_score_from: 0,
  recency_score_to: -0.1,
  engagement_class_match: 0,
  return_count_from: 0,
  return_count_to: 0,
  user_asserted_in_thread: 0,
  user_asserted_in_workstream: 0,
});

const organizedVisitPayload = (input: {
  readonly visitId: string;
  readonly toContainer: string;
}): unknown => ({
  payloadVersion: 1,
  itemKind: 'visit',
  itemId: input.visitId,
  action: 'move',
  toContainer: input.toContainer,
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
      (e) =>
        e.id ===
        edgeIdFor(
          'thread_in_workstream',
          nodeIdFor('thread', 'thread_a'),
          nodeIdFor('workstream', 'ws_tax'),
        ),
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

  it('timeline visit canonical-URL match yields timeline_same_url_as_thread when the T5 gates pass', () => {
    // Stage 5 / T5: the unconditional canonical-URL match was demoted.
    // The edge now requires `provider match OR title-overlap >= 0.25`
    // AND (recency ≤ 24h when thread.lastSeenAt is available). This
    // fixture passes by matching provider + recent observed times.
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://chatgpt.com/c/abc',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:30:00.000Z',
          url: 'https://chatgpt.com/c/abc',
          canonicalUrl: 'https://chatgpt.com/c/abc',
          provider: 'chatgpt',
          title: 'Tax flow chat',
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
            title: 'Tax flow chat',
            threadUrl: 'https://chatgpt.com/c/abc',
            canonicalUrl: 'https://chatgpt.com/c/abc',
            provider: 'chatgpt',
            lastSeenAt: '2026-05-07T10:35:00.000Z',
          },
        ],
        timelineDays: [day],
      }),
    );
    const edge = snap.edges.find((e) => e.kind === 'timeline_same_url_as_thread');
    expect(edge).toBeDefined();
    expect(edge?.confidence).toBe('inferred');
    expect(edge?.producedBy.source).toBe('timeline-projection');
    // Stage 5.0 follow-up — evidence is stored on `edge.metadata.evidence`,
    // NOT `producedBy.evidence`. Assert both halves so a future move
    // back to producedBy doesn't pass silently.
    expect((edge?.producedBy as Record<string, unknown> | undefined)?.['evidence']).toBeUndefined();
    const evidence = (edge?.metadata as { readonly evidence?: Record<string, unknown> } | undefined)
      ?.evidence;
    expect(evidence).toBeDefined();
    expect(evidence?.['providerMatched']).toBe(true);
    expect(evidence?.['titleJaccard']).toBeGreaterThanOrEqual(0.25);
    expect(evidence?.['recencyDeltaMs']).toBeTypeOf('number');
    expect(evidence?.['recencyDeltaMs']).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('drops timeline_same_url_as_thread when provider differs, titles do not overlap, and recency is irrelevant', () => {
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://chatgpt.com/c/abc',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:30:00.000Z',
          url: 'https://chatgpt.com/c/abc',
          canonicalUrl: 'https://chatgpt.com/c/abc',
          provider: 'generic',
          title: 'Quarterly revenue spreadsheet',
          visitCount: 1,
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
            title: 'Linux kernel boot sequence',
            threadUrl: 'https://chatgpt.com/c/abc',
            canonicalUrl: 'https://chatgpt.com/c/abc',
            provider: 'chatgpt',
          },
        ],
        timelineDays: [day],
      }),
    );
    expect(snap.edges.find((e) => e.kind === 'timeline_same_url_as_thread')).toBeUndefined();
  });

  it('drops timeline_same_url_as_thread when recency exceeds the 24-hour window', () => {
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://chatgpt.com/c/abc',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:30:00.000Z',
          url: 'https://chatgpt.com/c/abc',
          canonicalUrl: 'https://chatgpt.com/c/abc',
          provider: 'chatgpt',
          title: 'Tax flow',
          visitCount: 1,
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
            provider: 'chatgpt',
            // ~7 days earlier — fails the 24-hour recency gate.
            lastSeenAt: '2026-04-30T10:30:00.000Z',
          },
        ],
        timelineDays: [day],
      }),
    );
    expect(snap.edges.find((e) => e.kind === 'timeline_same_url_as_thread')).toBeUndefined();
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
              turns: [{ ordinal: 0, role: 'user', text: 'see https://copy.fail/exploit' }],
            },
          }),
          buildEvent({
            seq: 2,
            replicaId: 'replica-desktop',
            type: CAPTURE_RECORDED,
            payload: {
              bac_id: 'thread_a',
              capturedAt: '2026-05-07T10:00:00.000Z',
              turns: [{ ordinal: 0, role: 'user', text: 'see https://copy.fail/exploit' }],
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
    const SHARED_CODE_BLOCK = 'function calculateTaxOwed(income, year) { return';

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
          provider: 'claude',
          title: 'Tax helper question',
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
            provider: 'claude',
            lastSeenAt: '2026-05-07T09:35:00.000Z',
            primaryWorkstreamId: 'ws_research',
          },
          {
            bac_id: 'thread_chatgpt',
            title: 'Code review',
            threadUrl: CHATGPT_THREAD_URL,
            canonicalUrl: CHATGPT_THREAD_URL,
            provider: 'chatgpt',
            lastSeenAt: '2026-05-07T09:35:00.000Z',
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
    // Locks in metadata round-trip: the cosine + threshold were
    // previously dropped here, forcing the UI to hardcode 0.85 in
    // `extension/src/sidepanel/connections/client.ts:455`. The fix
    // persists them on the edge so the why-related panel can show
    // the real score.
    expect(edge?.metadata).toEqual({ cosine: 0.91, threshold: 0.85 });
    expect(
      snap.edges.filter((candidate) => candidate.kind === 'visit_resembles_visit'),
    ).toHaveLength(1);
  });

  it('Pass 12 emits closest_visit top-K edges with score and feature contributions', () => {
    const urls = [
      'https://ranker.test/a',
      'https://ranker.test/b',
      'https://ranker.test/c',
      'https://ranker.test/d',
      'https://ranker.test/e',
    ] as const;
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: urls.map((url, index) => ({
        id: url,
        firstSeenAt: `2026-05-07T09:${String(index).padStart(2, '0')}:00.000Z`,
        lastSeenAt: `2026-05-07T09:${String(index).padStart(2, '0')}:30.000Z`,
        url,
        canonicalUrl: url,
        title: `Ranker fixture ${String(index)}`,
        provider: 'generic',
        visitCount: 1,
      })),
      updatedAt: '2026-05-07T09:04:30.000Z',
      entryCount: urls.length,
    };
    const scoreByToVisit = new Map<string, number>([
      ['https://ranker.test/b', 0.91],
      ['https://ranker.test/c', 0.62],
      ['https://ranker.test/d', 0.44],
      ['https://ranker.test/e', 0.29],
    ]);

    const snap = buildConnectionsSnapshot(
      emptyInput({
        events: urls.map((url, index) =>
          buildEvent({
            seq: index + 1,
            type: BROWSER_TIMELINE_OBSERVED,
            payload: {
              eventId: `tl-ranker-${String(index)}`,
              observedAt: `2026-05-07T09:${String(index).padStart(2, '0')}:30.000Z`,
              url,
              canonicalUrl: url,
              title: `Ranker fixture ${String(index)}`,
              provider: 'generic',
              transition: 'updated',
              tabSessionId: `tses_ranker_${String(index)}`,
            },
          }),
        ),
        timelineDays: [day],
        closestVisitRanker: {
          revisionId: 'ranker-rev-1',
          threshold: 0.3,
          topK: 2,
          predict: (_features, candidate) => {
            const score = scoreByToVisit.get(candidate.toVisitId) ?? 0.1;
            return { score, contributions: rankerContributionsFor(score) };
          },
        },
      }),
    );

    const fromA = snap.edges.filter(
      (edge) =>
        edge.kind === 'closest_visit' &&
        edge.fromNodeId === nodeIdFor('timeline-visit', 'https://ranker.test/a'),
    );
    expect(fromA.map((edge) => edge.toNodeId)).toEqual([
      nodeIdFor('timeline-visit', 'https://ranker.test/b'),
      nodeIdFor('timeline-visit', 'https://ranker.test/c'),
    ]);
    expect(fromA[0]).toMatchObject({
      observedAt: '2026-05-07T09:01:30.000Z',
      producedBy: { source: 'ranker', revisionId: 'ranker-rev-1' },
      confidence: 'inferred',
      family: 'urlmatch',
      metadata: {
        score: 0.91,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        topContributions: [
          { feature: 'same_host', weight: 0.455 },
          { feature: 'shared_title_tokens', weight: 0.2275 },
          { feature: 'recency_score_to', weight: -0.1 },
        ],
      },
    });
    expect(fromA.some((edge) => edge.toNodeId === nodeIdFor('timeline-visit', urls[3]))).toBe(
      false,
    );
    expect(fromA.some((edge) => edge.toNodeId === nodeIdFor('timeline-visit', urls[4]))).toBe(
      false,
    );
  });

  it('tab-session nodes and visit edges replace active-pointer visit_in_workstream edges', () => {
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
          tabSessionId: 'tses_child',
          openerTabSessionId: 'tses_parent',
        },
        {
          id: 'https://www.youtube.com/watch?v=rY44ViY45q8',
          firstSeenAt: '2026-05-07T10:01:00.000Z',
          lastSeenAt: '2026-05-07T10:30:00.000Z',
          url: 'https://www.youtube.com/watch?v=rY44ViY45q8',
          canonicalUrl: 'https://www.youtube.com/watch?v=rY44ViY45q8',
          visitCount: 1,
          tabSessionId: 'tses_child',
        },
      ],
      updatedAt: '2026-05-07T10:30:00.000Z',
      entryCount: 2,
    };
    const snap = buildConnectionsSnapshot(emptyInput({ timelineDays: [day] }));
    // 2026-05 fix: visit_in_workstream is now emitted from
    // `entry.workstreamId` (the timeline observer stamps it again).
    // The earlier assertion expected zero edges because the
    // "Phase 2 restore" comment in `timeline/events.ts` said the
    // edge would come from explicit tab-session attribution — that
    // path never landed, leaving the edge absent and breaking every
    // downstream consumer (ranker, similarity, resolver). Restored.
    expect(snap.edges.some((e) => e.kind === 'visit_in_workstream')).toBe(true);
    expect(snap.nodes.some((n) => n.id === nodeIdFor('tab-session', 'tses_child'))).toBe(true);
    expect(snap.nodes.some((n) => n.id === nodeIdFor('tab-session', 'tses_parent'))).toBe(true);
    const visitEdges = snap.edges.filter((e) => e.kind === 'visit_instance_in_tab_session');
    expect(visitEdges.length).toBe(2);
    expect(
      visitEdges.some(
        (edge) =>
          edge.fromNodeId.startsWith('visit-instance:tses_child:') &&
          edge.fromNodeId.includes('https://copy.fail') &&
          edge.toNodeId === nodeIdFor('tab-session', 'tses_child') &&
          edge.confidence === 'observed' &&
          edge.producedBy.source === 'timeline-projection',
      ),
    ).toBe(true);
    expect(
      snap.edges.some(
        (edge) =>
          edge.kind === 'tab_session_opener_chain' &&
          edge.fromNodeId === nodeIdFor('tab-session', 'tses_child') &&
          edge.toNodeId === nodeIdFor('tab-session', 'tses_parent'),
      ),
    ).toBe(true);
    const taggedVisit = snap.nodes.find(
      (n) => n.id === nodeIdFor('timeline-visit', 'https://copy.fail'),
    );
    expect(taggedVisit?.metadata['tabSessionId']).toBeUndefined();
    // 2026-05 fix: timeline-visit metadata now carries the active
    // workstreamId the observer stamped on the event, matching the
    // e2e suite's expectation at `connections-real-tabs.spec.ts:228`.
    // The visit_in_workstream edge below is still the authoritative
    // attribution link; this is the redundant breadcrumb that lets
    // the side panel render the active-workstream chip without
    // resolving the edge.
    expect(taggedVisit?.metadata['workstreamId']).toBe('ws_security');
    expect(
      snap.edges.some(
        (edge) =>
          edge.kind === 'visit_instance_same_url_as_timeline_visit' &&
          edge.fromNodeId.startsWith('visit-instance:tses_child:') &&
          edge.toNodeId === nodeIdFor('timeline-visit', 'https://copy.fail'),
      ),
    ).toBe(true);
  });

  it('tab-session nodes carry latestTitle/latestUrl from the projection so frontend labels are human-readable', () => {
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://chatgpt.com/g/g-p-x/c/y',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:00:30.000Z',
          url: 'https://chatgpt.com/g/g-p-x/c/y',
          canonicalUrl: 'https://chatgpt.com/g/g-p-x/c/y',
          visitCount: 1,
          tabSessionId: 'tses_chat',
        },
      ],
      updatedAt: '2026-05-07T10:00:30.000Z',
      entryCount: 1,
    };
    const tabSessionProjection: TabSessionProjection = {
      schemaVersion: TAB_SESSION_PROJECTION_SCHEMA_VERSION,
      bySessionId: new Map([
        [
          'tses_chat',
          {
            tabSessionId: 'tses_chat',
            openedAt: '2026-05-07T09:55:00.000Z',
            lastActivityAt: '2026-05-07T10:00:30.000Z',
            latestUrl: 'https://chatgpt.com/g/g-p-x/c/y',
            latestTitle: 'Codex collector — design notes',
            provider: 'chatgpt',
            attributionHistory: [],
          },
        ],
      ]),
      openSessionsByTabId: new Map(),
    };
    const snap = buildConnectionsSnapshot(
      emptyInput({ timelineDays: [day], tabSessionProjection }),
    );
    const tabNode = snap.nodes.find((n) => n.id === nodeIdFor('tab-session', 'tses_chat'));
    expect(tabNode?.label).toBe('Codex collector — design notes');
    expect(tabNode?.metadata['latestTitle']).toBe('Codex collector — design notes');
    expect(tabNode?.metadata['latestUrl']).toBe('https://chatgpt.com/g/g-p-x/c/y');
    expect(tabNode?.metadata['provider']).toBe('chatgpt');
  });

  it('URL attribution drives visit_instance_in_workstream edges (URL beats tab-session)', () => {
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://example.test/article',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:00:30.000Z',
          url: 'https://example.test/article',
          canonicalUrl: 'https://example.test/article',
          visitCount: 1,
          workstreamId: 'ws_tabFallback',
          tabSessionId: 'tses_a',
        },
      ],
      updatedAt: '2026-05-07T10:00:30.000Z',
      entryCount: 1,
    };
    // The tab session is attributed to ws_tabFallback. The URL is
    // attributed to ws_urlPrimary. URL wins.
    const tabSessionProjection: TabSessionProjection = {
      schemaVersion: TAB_SESSION_PROJECTION_SCHEMA_VERSION,
      bySessionId: new Map([
        [
          'tses_a',
          {
            tabSessionId: 'tses_a',
            openedAt: '2026-05-07T09:55:00.000Z',
            lastActivityAt: '2026-05-07T10:00:30.000Z',
            currentAttribution: {
              workstreamId: 'ws_tabFallback',
              source: 'user_asserted',
              observedAt: '2026-05-07T10:01:00.000Z',
              clientEventId: 'evt-1',
              replicaId: 'r1',
              seq: 1,
            },
            attributionHistory: [],
          },
        ],
      ]),
      openSessionsByTabId: new Map(),
    };
    const urlProjection = {
      schemaVersion: 1 as const,
      byCanonicalUrl: new Map([
        [
          'https://example.test/article',
          {
            canonicalUrl: 'https://example.test/article',
            firstSeenAt: '2026-05-07T10:00:00.000Z',
            lastSeenAt: '2026-05-07T10:00:30.000Z',
            visitCount: 1,
            tabSessionIds: ['tses_a'],
            attributionHistory: [],
            currentAttribution: {
              workstreamId: 'ws_urlPrimary',
              source: 'user_asserted' as const,
              observedAt: '2026-05-07T10:02:00.000Z',
              clientEventId: 'evt-url-1',
              replicaId: 'r1',
              seq: 2,
            },
          },
        ],
      ]),
    };
    const snap = buildConnectionsSnapshot(
      emptyInput({ timelineDays: [day], tabSessionProjection, urlProjection }),
    );
    const visitInstanceEdge = snap.edges.find(
      (edge) =>
        edge.kind === 'visit_instance_in_workstream' &&
        edge.fromNodeId.startsWith('visit-instance:tses_a:'),
    );
    expect(visitInstanceEdge?.toNodeId).toBe(nodeIdFor('workstream', 'ws_urlPrimary'));
    expect(visitInstanceEdge?.metadata?.['attributionOrigin']).toBe('canonical-url');
    const timelineVisit = snap.nodes.find(
      (node) => node.id === nodeIdFor('timeline-visit', 'https://example.test/article'),
    );
    expect(timelineVisit?.metadata['workstreamId']).toBe('ws_urlPrimary');
    expect(timelineVisit?.metadata['workstreamAttributionOrigin']).toBe('canonical-url');
    expect(
      snap.edges.filter(
        (edge) =>
          edge.kind === 'visit_in_workstream' &&
          edge.fromNodeId === nodeIdFor('timeline-visit', 'https://example.test/article'),
      ),
    ).toEqual([
      expect.objectContaining({
        toNodeId: nodeIdFor('workstream', 'ws_urlPrimary'),
        confidence: 'asserted',
        metadata: expect.objectContaining({ attributionOrigin: 'canonical-url' }),
      }),
    ]);
    // Tab-session attribution still drives the tab_session_in_workstream
    // edge — it's a separate signal about the whole tab.
    const tabSessionEdge = snap.edges.find(
      (edge) =>
        edge.kind === 'tab_session_in_workstream' &&
        edge.fromNodeId === nodeIdFor('tab-session', 'tses_a'),
    );
    expect(tabSessionEdge?.toNodeId).toBe(nodeIdFor('workstream', 'ws_tabFallback'));
  });

  it('explicit null URL attribution suppresses stale timeline workstream stamps', () => {
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://example.test/article',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:00:30.000Z',
          url: 'https://example.test/article',
          canonicalUrl: 'https://example.test/article',
          visitCount: 1,
          workstreamId: 'ws_old',
          tabSessionId: 'tses_a',
        },
      ],
      updatedAt: '2026-05-07T10:00:30.000Z',
      entryCount: 1,
    };
    const urlProjection = {
      schemaVersion: 1 as const,
      byCanonicalUrl: new Map([
        [
          'https://example.test/article',
          {
            canonicalUrl: 'https://example.test/article',
            firstSeenAt: '2026-05-07T10:00:00.000Z',
            lastSeenAt: '2026-05-07T10:00:30.000Z',
            visitCount: 1,
            tabSessionIds: ['tses_a'],
            attributionHistory: [],
            currentAttribution: {
              workstreamId: null,
              source: 'user_asserted' as const,
              observedAt: '2026-05-07T10:02:00.000Z',
              clientEventId: 'evt-url-1',
              replicaId: 'r1',
              seq: 2,
            },
          },
        ],
      ]),
    };
    const snap = buildConnectionsSnapshot(emptyInput({ timelineDays: [day], urlProjection }));
    const timelineVisit = snap.nodes.find(
      (node) => node.id === nodeIdFor('timeline-visit', 'https://example.test/article'),
    );
    expect(timelineVisit?.metadata['workstreamId']).toBeUndefined();
    expect(
      snap.edges.some(
        (edge) =>
          edge.kind === 'visit_in_workstream' &&
          edge.fromNodeId === nodeIdFor('timeline-visit', 'https://example.test/article'),
      ),
    ).toBe(false);
  });

  it('tab-session label falls back to host when the projection has a URL but no title', () => {
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://chatgpt.com/g/g-p-x/c/y',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:00:30.000Z',
          url: 'https://chatgpt.com/g/g-p-x/c/y',
          canonicalUrl: 'https://chatgpt.com/g/g-p-x/c/y',
          visitCount: 1,
          tabSessionId: 'tses_chat',
        },
      ],
      updatedAt: '2026-05-07T10:00:30.000Z',
      entryCount: 1,
    };
    const tabSessionProjection: TabSessionProjection = {
      schemaVersion: TAB_SESSION_PROJECTION_SCHEMA_VERSION,
      bySessionId: new Map([
        [
          'tses_chat',
          {
            tabSessionId: 'tses_chat',
            openedAt: '2026-05-07T09:55:00.000Z',
            lastActivityAt: '2026-05-07T10:00:30.000Z',
            latestUrl: 'https://chatgpt.com/g/g-p-x/c/y',
            attributionHistory: [],
          },
        ],
      ]),
      openSessionsByTabId: new Map(),
    };
    const snap = buildConnectionsSnapshot(
      emptyInput({ timelineDays: [day], tabSessionProjection }),
    );
    const tabNode = snap.nodes.find((n) => n.id === nodeIdFor('tab-session', 'tses_chat'));
    expect(tabNode?.label).toBe('chatgpt.com');
  });

  it('explicit tab-session attribution emits tab_session_in_workstream and visit_instance_in_workstream edges', () => {
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'https://copy.fail',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:00:30.000Z',
          url: 'https://copy.fail',
          canonicalUrl: 'https://copy.fail',
          visitCount: 1,
          tabSessionId: 'tses_child',
        },
      ],
      updatedAt: '2026-05-07T10:00:30.000Z',
      entryCount: 1,
    };
    const events: AcceptedEvent[] = [
      buildEvent({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'tl-1',
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://copy.fail',
          canonicalUrl: 'https://copy.fail',
          transition: 'updated',
          tabIdHash: 'tab_a',
          tabSessionId: 'tses_child',
        },
      }),
      buildEvent({
        seq: 2,
        type: USER_ORGANIZED_ITEM,
        payload: {
          payloadVersion: 1,
          itemKind: 'tab-session',
          itemId: 'tses_child',
          action: 'move',
          toContainer: 'ws_security',
        },
      }),
    ];
    const snap = buildConnectionsSnapshot(
      emptyInput({ events, timelineDays: [day], tabSessionProjection: projectTabSessions(events) }),
    );

    expect(
      snap.edges.find(
        (edge) =>
          edge.kind === 'tab_session_in_workstream' &&
          edge.fromNodeId === nodeIdFor('tab-session', 'tses_child') &&
          edge.toNodeId === nodeIdFor('workstream', 'ws_security'),
      ),
    ).toMatchObject({
      confidence: 'asserted',
      producedBy: { source: 'event-log', eventType: USER_ORGANIZED_ITEM },
      metadata: { attributionSource: 'user_asserted' },
    });
    expect(
      snap.edges.find(
        (edge) =>
          edge.kind === 'visit_instance_in_workstream' &&
          edge.fromNodeId.startsWith('visit-instance:tses_child:') &&
          edge.toNodeId === nodeIdFor('workstream', 'ws_security'),
      ),
    ).toMatchObject({
      confidence: 'asserted',
      producedBy: { source: 'event-log', eventType: USER_ORGANIZED_ITEM },
      metadata: { attributionSource: 'user_asserted' },
    });
  });

  it('same canonicalUrl in two tab sessions only attributes the asserted session', () => {
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      entries: [
        {
          id: 'copy-fail-tses-a',
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:00:30.000Z',
          url: 'https://copy.fail',
          canonicalUrl: 'https://copy.fail',
          visitCount: 1,
          tabSessionId: 'tses_a',
        },
        {
          id: 'copy-fail-tses-b',
          firstSeenAt: '2026-05-07T10:05:00.000Z',
          lastSeenAt: '2026-05-07T10:05:30.000Z',
          url: 'https://copy.fail',
          canonicalUrl: 'https://copy.fail',
          visitCount: 1,
          tabSessionId: 'tses_b',
        },
      ],
      updatedAt: '2026-05-07T10:05:30.000Z',
      entryCount: 2,
    };
    const events: AcceptedEvent[] = [
      buildEvent({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'tl-a',
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://copy.fail',
          canonicalUrl: 'https://copy.fail',
          transition: 'updated',
          tabIdHash: 'tab_a',
          tabSessionId: 'tses_a',
        },
      }),
      buildEvent({
        seq: 2,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'tl-b',
          observedAt: '2026-05-07T10:05:00.000Z',
          url: 'https://copy.fail',
          canonicalUrl: 'https://copy.fail',
          transition: 'updated',
          tabIdHash: 'tab_b',
          tabSessionId: 'tses_b',
        },
      }),
      buildEvent({
        seq: 3,
        type: USER_ORGANIZED_ITEM,
        payload: {
          payloadVersion: 1,
          itemKind: 'tab-session',
          itemId: 'tses_a',
          action: 'move',
          toContainer: 'ws_security',
        },
      }),
    ];
    const tabSessionProjection = projectTabSessions(events);
    const snap = buildConnectionsSnapshot(
      emptyInput({ events, timelineDays: [day], tabSessionProjection }),
    );

    expect([...tabSessionProjection.bySessionId.keys()].sort()).toEqual(['tses_a', 'tses_b']);
    expect(tabSessionProjection.bySessionId.get('tses_a')?.currentAttribution).toMatchObject({
      workstreamId: 'ws_security',
      source: 'user_asserted',
    });
    expect(tabSessionProjection.bySessionId.get('tses_b')?.currentAttribution).toBeUndefined();

    expect(
      snap.edges.filter(
        (edge) =>
          edge.kind === 'visit_instance_in_tab_session' &&
          edge.fromNodeId.startsWith('visit-instance:'),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toNodeId: nodeIdFor('tab-session', 'tses_a') }),
        expect.objectContaining({ toNodeId: nodeIdFor('tab-session', 'tses_b') }),
      ]),
    );
    expect(
      snap.edges.filter(
        (edge) =>
          edge.kind === 'tab_session_in_workstream' &&
          edge.toNodeId === nodeIdFor('workstream', 'ws_security'),
      ),
    ).toEqual([expect.objectContaining({ fromNodeId: nodeIdFor('tab-session', 'tses_a') })]);
    expect(
      snap.edges.filter(
        (edge) =>
          edge.kind === 'visit_instance_in_workstream' &&
          edge.fromNodeId.startsWith('visit-instance:'),
      ),
    ).toEqual([
      expect.objectContaining({
        fromNodeId: expect.stringContaining('visit-instance:tses_a:'),
        toNodeId: nodeIdFor('workstream', 'ws_security'),
      }),
    ]);
    expect(
      snap.edges.some(
        (edge) =>
          edge.kind === 'visit_in_workstream' &&
          edge.fromNodeId === nodeIdFor('timeline-visit', 'https://copy.fail'),
      ),
    ).toBe(false);
  });

  it('visit_instance_in_tab_session subgraph: anchored on tab-session reaches every session visit', () => {
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
          tabSessionId: 'tses_security_research',
        },
        {
          id: 'https://www.youtube.com/watch?v=rY44ViY45q8',
          firstSeenAt: '2026-05-07T10:30:00.000Z',
          lastSeenAt: '2026-05-07T10:35:00.000Z',
          url: 'https://www.youtube.com/watch?v=rY44ViY45q8',
          canonicalUrl: 'https://www.youtube.com/watch?v=rY44ViY45q8',
          visitCount: 1,
          tabSessionId: 'tses_security_research',
        },
      ],
      updatedAt: '2026-05-07T10:35:00.000Z',
      entryCount: 2,
    };
    const snap = buildConnectionsSnapshot(emptyInput({ timelineDays: [day] }));
    const sub = subgraphForNode(snap, nodeIdFor('tab-session', 'tses_security_research'), 2);
    const ids = new Set(sub.nodes.map((n) => n.id));
    expect([...ids].some((id) => id.startsWith('visit-instance:tses_security_research:'))).toBe(
      true,
    );
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
      algorithmVersion: TOPIC_UNION_FIND_REVISION_KEY,
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
          secondaryAffiliations: [
            {
              canonicalUrl: 'https://topic.test/e',
              score: 0.79,
              reasons: ['edge_support', 'member_similarity'],
              supportCount: 1,
              maxCosine: 0.9,
              lexicalScore: 0.1,
              reciprocalSupport: 0,
            },
          ],
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
        },
        {
          id: 'https://topic.test/b',
          firstSeenAt: '2026-05-07T09:10:00.000Z',
          lastSeenAt: '2026-05-07T10:10:00.000Z',
          url: 'https://topic.test/b',
          canonicalUrl: 'https://topic.test/b',
          title: 'Topic B',
          visitCount: 1,
        },
        {
          id: 'https://topic.test/c',
          firstSeenAt: '2026-05-07T09:20:00.000Z',
          lastSeenAt: '2026-05-07T10:20:00.000Z',
          url: 'https://topic.test/c',
          canonicalUrl: 'https://topic.test/c',
          title: 'Topic C',
          visitCount: 1,
        },
        {
          id: 'https://topic.test/d',
          firstSeenAt: '2026-05-07T09:30:00.000Z',
          lastSeenAt: '2026-05-07T10:30:00.000Z',
          url: 'https://topic.test/d',
          canonicalUrl: 'https://topic.test/d',
          title: 'Topic D',
          visitCount: 1,
        },
        {
          id: 'https://topic.test/e',
          firstSeenAt: '2026-05-07T09:40:00.000Z',
          lastSeenAt: '2026-05-07T10:40:00.000Z',
          url: 'https://topic.test/e',
          canonicalUrl: 'https://topic.test/e',
          title: 'Topic E',
          visitCount: 1,
        },
      ],
      updatedAt: '2026-05-07T10:30:00.000Z',
      entryCount: 4,
    };

    const snap = buildConnectionsSnapshot(
      emptyInput({
        timelineDays: [day],
        topicRevision,
        topicWorkstreamShareThreshold: 0,
      }),
    );
    const topicNodeId = nodeIdFor('topic', 'topic:abc123');
    const topicNode = snap.nodes.find((node) => node.id === topicNodeId);

    expect(topicNode?.label).toBe('Topic A');
    expect(topicNode?.metadata['cohesion']).toBe(0.91);
    const topicMembershipEdges = snap.edges.filter((edge) => edge.kind === 'visit_in_topic');
    expect(topicMembershipEdges).toHaveLength(5);
    expect(
      topicMembershipEdges.find(
        (edge) => edge.fromNodeId === nodeIdFor('timeline-visit', 'https://topic.test/e'),
      )?.metadata,
    ).toMatchObject({
      affiliation: 'secondary',
      score: 0.79,
      reasons: ['edge_support', 'member_similarity'],
    });
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

  it('Pass 13 emits visit_in_template edges for visits sharing a DOM skeleton hash', () => {
    const domHash = 'd'.repeat(64);
    const events = ['visit-a', 'visit-b', 'visit-c'].map((visitId, index) =>
      buildEvent({
        seq: index + 1,
        type: VISUAL_FINGERPRINT_OBSERVED,
        payload: {
          payloadVersion: 1,
          visitId,
          domHash,
          observedAt: `2026-05-07T10:0${String(index)}:00.000Z`,
        },
      }),
    );

    const snap = buildConnectionsSnapshot(emptyInput({ events }));
    const templateNodeId = nodeIdFor('template', domHash);

    expect(snap.nodes.filter((node) => node.id === templateNodeId)).toHaveLength(1);
    expect(
      snap.edges
        .filter((edge) => edge.kind === 'visit_in_template')
        .map((edge) => [edge.fromNodeId, edge.toNodeId]),
    ).toEqual([
      [nodeIdFor('timeline-visit', 'visit-a'), templateNodeId],
      [nodeIdFor('timeline-visit', 'visit-b'), templateNodeId],
      [nodeIdFor('timeline-visit', 'visit-c'), templateNodeId],
    ]);
    expect(
      snap.edges
        .filter((edge) => edge.kind === 'visit_in_template')
        .every(
          (edge) =>
            edge.confidence === 'observed' &&
            edge.family === 'urlmatch' &&
            edge.producedBy.source === 'event-log',
        ),
    ).toBe(true);
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
          turns: [{ ordinal: 0, role: 'user', text: `please review: ${QUOTED_BLOCK} 0;` }],
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
    const rev = JSON.stringify(
      buildConnectionsSnapshot(emptyInput({ events: [...events].reverse() })),
    );
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

  it('Pass 9 emits same-tab and opener navigation spine edges from navigation.committed', () => {
    const root = 'https://example.com/root';
    const next = 'https://example.com/next';
    const opened = 'https://example.com/opened';
    const rootPayload = navigationCommittedPayload({
      replicaId: 'replica-A',
      seq: 1,
      canonicalUrl: root,
      commitAt: '2026-05-07T09:00:00.000Z',
    });
    const nextPayload = navigationCommittedPayload({
      replicaId: 'replica-A',
      seq: 2,
      canonicalUrl: next,
      commitAt: '2026-05-07T09:01:00.000Z',
      previousVisitId: rootPayload.visitId,
    });
    const openedPayload = navigationCommittedPayload({
      replicaId: 'replica-A',
      seq: 3,
      canonicalUrl: opened,
      commitAt: '2026-05-07T09:02:00.000Z',
      openerVisitId: rootPayload.visitId,
    });

    const snap = buildConnectionsSnapshot(
      emptyInput({
        events: [
          buildEvent({ seq: 1, type: NAVIGATION_COMMITTED, payload: rootPayload }),
          buildEvent({ seq: 2, type: NAVIGATION_COMMITTED, payload: nextPayload }),
          buildEvent({ seq: 3, type: NAVIGATION_COMMITTED, payload: openedPayload }),
        ],
      }),
    );

    const previous = snap.edges.find((edge) => edge.kind === 'previous_visit_in_tab_session');
    expect(previous).toMatchObject({
      fromNodeId: nodeIdFor('timeline-visit', root),
      toNodeId: nodeIdFor('timeline-visit', next),
      confidence: 'observed',
      producedBy: {
        source: 'event-log',
        eventType: NAVIGATION_COMMITTED,
        dot: { replicaId: 'replica-A', seq: 2 },
      },
    });
    expect(previous?.metadata).toMatchObject({
      currentVisitId: nextPayload.visitId,
      navigationSequence: 2,
      tabSessionIdHash: 'tab-replica-A',
    });

    const opener = snap.edges.find((edge) => edge.kind === 'opener_visit');
    expect(opener).toMatchObject({
      fromNodeId: nodeIdFor('timeline-visit', root),
      toNodeId: nodeIdFor('timeline-visit', opened),
      confidence: 'observed',
      producedBy: {
        source: 'event-log',
        eventType: NAVIGATION_COMMITTED,
        dot: { replicaId: 'replica-A', seq: 3 },
      },
    });
  });

  it('Pass 11 emits visit_continues_visit for high-confidence cross-replica handoffs', () => {
    const url = 'https://example.com/shared';
    const sourceVisitId = 'visit-replica-A-1';
    const continuedVisitId = 'visit-replica-B-2';
    const copied = {
      payloadVersion: 1,
      selectionHash: 'abcdef1234567890abcdef1234567890',
      simhash64: 'AAAAAAAAAAA=',
      charCount: 64,
      lineCount: 3,
      contentKindHint: 'code-block',
      rawTextStored: false,
    };
    const day: TimelineDayProjection = {
      date: '2026-05-07',
      updatedAt: '2026-05-07T10:30:00.000Z',
      entryCount: 1,
      entries: [
        {
          id: url,
          firstSeenAt: '2026-05-07T10:00:00.000Z',
          lastSeenAt: '2026-05-07T10:25:00.000Z',
          url,
          canonicalUrl: url,
          title: 'Shared research',
          provider: 'generic',
          visitCount: 2,
        },
      ],
    };
    const snap = buildConnectionsSnapshot(
      emptyInput({
        timelineDays: [day],
        events: [
          buildEvent({
            seq: 1,
            replicaId: 'replica-A',
            type: NAVIGATION_COMMITTED,
            payload: navigationCommittedPayload({
              replicaId: 'replica-A',
              seq: 1,
              canonicalUrl: url,
              commitAt: '2026-05-07T10:00:00.000Z',
            }),
            acceptedAtMs: Date.parse('2026-05-07T10:00:01.000Z'),
          }),
          buildEvent({
            seq: 2,
            replicaId: 'replica-B',
            type: NAVIGATION_COMMITTED,
            payload: navigationCommittedPayload({
              replicaId: 'replica-B',
              seq: 2,
              canonicalUrl: url,
              commitAt: '2026-05-07T10:25:00.000Z',
            }),
            acceptedAtMs: Date.parse('2026-05-07T10:25:01.000Z'),
          }),
          buildEvent({
            seq: 3,
            type: SELECTION_COPIED,
            payload: { ...copied, visitId: sourceVisitId },
          }),
          buildEvent({
            seq: 4,
            type: SELECTION_COPIED,
            payload: { ...copied, visitId: continuedVisitId },
          }),
          buildEvent({
            seq: 5,
            type: USER_ORGANIZED_ITEM,
            payload: organizedVisitPayload({
              visitId: sourceVisitId,
              toContainer: 'workstream:ws-research',
            }),
          }),
          buildEvent({
            seq: 6,
            type: USER_ORGANIZED_ITEM,
            payload: organizedVisitPayload({
              visitId: continuedVisitId,
              toContainer: 'workstream:ws-research',
            }),
          }),
        ],
      }),
    );

    const edge = snap.edges.find((candidate) => candidate.kind === 'visit_continues_visit');
    expect(edge).toBeDefined();
    expect(edge?.fromNodeId).toBe(nodeIdFor('timeline-visit', sourceVisitId));
    expect(edge?.toNodeId).toBe(nodeIdFor('timeline-visit', continuedVisitId));
    expect(edge?.confidence).toBe('inferred');
    expect(edge?.family).toBe('flow');
    expect(edge?.producedBy).toEqual({
      source: 'continuation-classifier',
      revisionId: CONTINUATION_CLASSIFIER_REVISION_ID,
    });
    expect(edge?.metadata).toMatchObject({
      canonicalUrl: url,
      fromReplicaId: 'replica-A',
      toReplicaId: 'replica-B',
      sameWorkstream: 1,
      copyPasteLineageContinuity: 1,
    });
    expect(typeof edge?.metadata?.['score']).toBe('number');
    expect(
      snap.nodes.find((node) => node.id === nodeIdFor('timeline-visit', sourceVisitId)),
    ).toBeDefined();
    expect(
      snap.nodes.find((node) => node.id === nodeIdFor('timeline-visit', continuedVisitId)),
    ).toBeDefined();
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
    expect(snap.edges.filter((edge) => edge.kind === 'snippet_reused_across_threads')).toHaveLength(
      2,
    );
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

// Stage 5.2 R1 + R4 — snapshot extension: every snapshot must embed the
// URL + tab-session projections (so HTTP routes serve from the committed
// snapshot, no event-log re-derivation) and carry a stable revision id.
describe('connections — Stage 5.2 R1/R4 snapshot extension', () => {
  const observation = buildEvent({
    seq: 1,
    type: BROWSER_TIMELINE_OBSERVED,
    payload: {
      eventId: 'tl-1',
      tabSessionId: 'tses_test',
      canonicalUrl: 'https://example.com/a',
      url: 'https://example.com/a',
      observedAt: '2026-05-07T10:00:00.000Z',
      transition: 'activated',
      title: 'A page',
    },
  });

  it('snapshot includes a populated tabSessionProjection field', () => {
    const tabSessionProjection = projectTabSessions([observation]);
    const snap = buildConnectionsSnapshot(
      emptyInput({ events: [observation], tabSessionProjection }),
    );
    expect(snap.tabSessionProjection?.schemaVersion).toBe(TAB_SESSION_PROJECTION_SCHEMA_VERSION);
    expect(Object.keys(snap.tabSessionProjection?.bySessionId ?? {})).toContain('tses_test');
  });

  it('snapshot includes a populated urlProjection field when wired', () => {
    const urlProjection = projectUrls([observation]);
    const tabSessionProjection = projectTabSessions([observation]);
    const snap = buildConnectionsSnapshot(
      emptyInput({ events: [observation], tabSessionProjection, urlProjection }),
    );
    expect(snap.urlProjection?.schemaVersion).toBe(URL_PROJECTION_SCHEMA_VERSION);
    expect(Object.keys(snap.urlProjection?.byCanonicalUrl ?? {})).toContain(
      'https://example.com/a',
    );
  });

  it('omits urlProjection when ConnectionsInput.urlProjection is undefined (back-compat)', () => {
    const snap = buildConnectionsSnapshot(emptyInput({ events: [observation] }));
    expect(snap.urlProjection).toBeUndefined();
    expect(snap.tabSessionProjection).toBeDefined();
  });

  it('emits a stable snapshotRevision that changes when content changes', () => {
    const tabSessionProjection = projectTabSessions([observation]);
    const urlProjection = projectUrls([observation]);
    const snap1 = buildConnectionsSnapshot(
      emptyInput({ events: [observation], tabSessionProjection, urlProjection }),
    );
    const snap2 = buildConnectionsSnapshot(
      emptyInput({ events: [observation], tabSessionProjection, urlProjection }),
    );
    expect(snap1.snapshotRevision).toBeDefined();
    expect(snap1.snapshotRevision).toBe(snap2.snapshotRevision);

    const observation2 = buildEvent({
      seq: 2,
      type: BROWSER_TIMELINE_OBSERVED,
      payload: {
        ...(observation.payload as Record<string, unknown>),
        eventId: 'tl-2',
        canonicalUrl: 'https://example.com/b',
        url: 'https://example.com/b',
      },
    });
    const snap3 = buildConnectionsSnapshot(
      emptyInput({
        events: [observation, observation2],
        tabSessionProjection: projectTabSessions([observation, observation2]),
        urlProjection: projectUrls([observation, observation2]),
      }),
    );
    expect(snap3.snapshotRevision).not.toBe(snap1.snapshotRevision);
  });
});
