import {
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  type UserFlowRelationKind,
} from '../../feedback/events.js';
import {
  NAVIGATION_COMMITTED,
  type NavigationTransitionType,
} from '../../navigation/events.js';
import { SELECTION_COPIED } from '../../snippets/events.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { WORKSTREAM_UPSERTED } from '../../workstreams/events.js';

export const WORK_GRAPH_EVAL_WORKSTREAM_ID = 'wg_eval_ws';
export const WORK_GRAPH_EVAL_BASE_ISO = '2026-05-08T16:00:00.000Z';
export const WORK_GRAPH_EVAL_BASE_MS = Date.parse(WORK_GRAPH_EVAL_BASE_ISO);

export interface WorkGraphEvalVisit {
  readonly key: string;
  readonly url: string;
  readonly title: string;
  readonly cluster: 'postgres' | 'kubernetes' | 'negative';
  readonly offsetMinutes: number;
  readonly focusedWindowMs: number;
}

export const WORK_GRAPH_EVAL_VISITS = [
  {
    key: 'pg_merge_a',
    url: 'https://eval.sidetrack.local/postgres/sidetrack_eval_postgres/merge-a',
    title: 'sidetrack_eval_postgres merge concurrency write skew',
    cluster: 'postgres',
    offsetMinutes: 0,
    focusedWindowMs: 14_000,
  },
  {
    key: 'pg_merge_b',
    url: 'https://eval.sidetrack.local/postgres/sidetrack_eval_postgres/merge-b',
    title: 'sidetrack_eval_postgres merge lock ordering diagnostics',
    cluster: 'postgres',
    offsetMinutes: 4,
    focusedWindowMs: 13_500,
  },
  {
    key: 'pg_merge_c',
    url: 'https://eval.sidetrack.local/postgres/sidetrack_eval_postgres/merge-c',
    title: 'sidetrack_eval_postgres merge retry plan',
    cluster: 'postgres',
    offsetMinutes: 8,
    focusedWindowMs: 12_500,
  },
  {
    key: 'k8s_eviction_a',
    url: 'https://eval.sidetrack.local/kubernetes/sidetrack_eval_kubernetes/eviction-a',
    title: 'sidetrack_eval_kubernetes pod eviction pressure',
    cluster: 'kubernetes',
    offsetMinutes: 45,
    focusedWindowMs: 11_000,
  },
  {
    key: 'k8s_eviction_b',
    url: 'https://eval.sidetrack.local/kubernetes/sidetrack_eval_kubernetes/eviction-b',
    title: 'sidetrack_eval_kubernetes pod restart budget',
    cluster: 'kubernetes',
    offsetMinutes: 49,
    focusedWindowMs: 10_500,
  },
  {
    key: 'negative_invoice',
    url: 'https://eval.sidetrack.local/accounting/sidetrack_eval_negative/invoice-aging',
    title: 'sidetrack_eval_negative invoice aging reconciliation',
    cluster: 'negative',
    offsetMinutes: 90,
    focusedWindowMs: 9_500,
  },
] as const satisfies readonly WorkGraphEvalVisit[];

export const WORK_GRAPH_EVAL_VISIT_BY_KEY = Object.fromEntries(
  WORK_GRAPH_EVAL_VISITS.map((visit) => [visit.key, visit]),
) as Record<(typeof WORK_GRAPH_EVAL_VISITS)[number]['key'], WorkGraphEvalVisit>;

export const WORK_GRAPH_EVAL_EXPECTED = {
  positivePairs: [
    ['pg_merge_a', 'pg_merge_b'],
    ['pg_merge_a', 'pg_merge_c'],
    ['pg_merge_b', 'pg_merge_c'],
    ['k8s_eviction_a', 'k8s_eviction_b'],
  ],
  negativePairs: [['pg_merge_a', 'negative_invoice']],
  expectedTopicClusters: [
    { cluster: 'postgres', minimumMembers: 3 },
    { cluster: 'kubernetes', minimumMembers: 2 },
  ],
  continuationPairs: [['visit_pg_merge_a_replica_a', 'visit_pg_merge_a_replica_b']],
  feedbackEffect: {
    rejectedPair: ['pg_merge_a', 'pg_merge_b'],
    expected: 'score-decreases-or-edge-disappears',
  },
} as const;

export interface BuildWorkGraphEvalEventsOptions {
  readonly includeSeedFeedback?: boolean;
}

const isoAt = (offsetMinutes: number): string =>
  new Date(WORK_GRAPH_EVAL_BASE_MS + offsetMinutes * 60_000).toISOString();

const event = (
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  acceptedAtMs: number,
  replicaId = 'eval-companion',
  aggregateId = 'work-graph-eval',
): AcceptedEvent => ({
  clientEventId: `work-graph-eval-${replicaId}-${String(seq)}`,
  dot: { replicaId, seq },
  deps: {},
  aggregateId,
  type,
  payload,
  acceptedAtMs,
});

const timelineEvent = (seq: number, visit: WorkGraphEvalVisit): AcceptedEvent => {
  const observedAt = isoAt(visit.offsetMinutes);
  return event(
    seq,
    BROWSER_TIMELINE_OBSERVED,
    {
      eventId: `timeline-${visit.key}`,
      observedAt,
      url: visit.url,
      canonicalUrl: visit.url,
      title: visit.title,
      provider: 'generic',
      transition: 'completed',
      workstreamId: WORK_GRAPH_EVAL_WORKSTREAM_ID,
      payloadVersion: 1,
      dimensions: {
        engagement: {
          focusedWindowMs: visit.focusedWindowMs,
        },
      },
    },
    Date.parse(observedAt),
    'eval-timeline',
    observedAt.slice(0, 10),
  );
};

const navigationEvent = (input: {
  seq: number;
  replicaId: string;
  visitId: string;
  visit: WorkGraphEvalVisit;
  offsetMinutes: number;
  previousVisitId?: string | null;
  transitionType?: NavigationTransitionType;
}): AcceptedEvent => {
  const commitTimestamp = WORK_GRAPH_EVAL_BASE_MS + input.offsetMinutes * 60_000;
  return event(
    input.seq,
    NAVIGATION_COMMITTED,
    {
      payloadVersion: 1,
      visitId: input.visitId,
      url: input.visit.url,
      canonicalUrl: input.visit.url,
      documentId: `doc_${input.visitId}`,
      parentDocumentId: null,
      tabSessionIdHash: `tab_${input.replicaId}`,
      windowSessionIdHash: `window_${input.replicaId}`,
      openerVisitId: null,
      previousVisitId: input.previousVisitId ?? null,
      navigationSequence: input.previousVisitId === undefined ? 1 : 2,
      transitionType: input.transitionType ?? 'link',
      transitionQualifiers: [],
      commitTimestamp,
      dimensions: {
        provenance: {
          fixture: 'work-graph-eval',
        },
      },
    },
    commitTimestamp,
    input.replicaId,
    input.visit.url,
  );
};

const selectionCopiedEvent = (input: {
  seq: number;
  replicaId: string;
  visitId: string;
  offsetMinutes: number;
}): AcceptedEvent => {
  const acceptedAtMs = WORK_GRAPH_EVAL_BASE_MS + input.offsetMinutes * 60_000;
  return event(
    input.seq,
    SELECTION_COPIED,
    {
      payloadVersion: 1,
      visitId: input.visitId,
      selectionHash: 'sha256:work-graph-eval-postgres-merge-handoff',
      simhash64: 'AAAAAAAAAAA=',
      charCount: 96,
      lineCount: 4,
      contentKindHint: 'code-block',
      rawTextStored: false,
    },
    acceptedAtMs,
    input.replicaId,
    `snippet:${input.visitId}`,
  );
};

const feedbackEvent = (input: {
  seq: number;
  type: typeof USER_FLOW_CONFIRMED | typeof USER_FLOW_REJECTED;
  relationKind: UserFlowRelationKind;
  fromKey: keyof typeof WORK_GRAPH_EVAL_VISIT_BY_KEY;
  toKey: keyof typeof WORK_GRAPH_EVAL_VISIT_BY_KEY;
}): AcceptedEvent => {
  const from = WORK_GRAPH_EVAL_VISIT_BY_KEY[input.fromKey];
  const to = WORK_GRAPH_EVAL_VISIT_BY_KEY[input.toKey];
  const acceptedAtMs = WORK_GRAPH_EVAL_BASE_MS + (120 + input.seq) * 60_000;
  return event(
    input.seq,
    input.type,
    {
      payloadVersion: 1,
      relationKind: input.relationKind,
      fromId: `timeline-visit:${from.url}`,
      toId: `timeline-visit:${to.url}`,
      ...(input.type === USER_FLOW_REJECTED ? { reason: 'not-related' } : {}),
    },
    acceptedAtMs,
    'eval-feedback',
    `feedback:flow:${input.relationKind}:timeline-visit:${from.url}:timeline-visit:${to.url}`,
  );
};

export const buildWorkGraphEvalAcceptedEvents = (
  options: BuildWorkGraphEvalEventsOptions = {},
): readonly AcceptedEvent[] => {
  const includeSeedFeedback = options.includeSeedFeedback ?? true;
  const pgA = WORK_GRAPH_EVAL_VISIT_BY_KEY.pg_merge_a;
  const pgB = WORK_GRAPH_EVAL_VISIT_BY_KEY.pg_merge_b;
  const pgC = WORK_GRAPH_EVAL_VISIT_BY_KEY.pg_merge_c;
  const negative = WORK_GRAPH_EVAL_VISIT_BY_KEY.negative_invoice;
  const events: AcceptedEvent[] = [
    event(
      1,
      WORKSTREAM_UPSERTED,
      {
        bac_id: WORK_GRAPH_EVAL_WORKSTREAM_ID,
        title: 'Work graph deterministic eval',
        payloadVersion: 1,
      },
      WORK_GRAPH_EVAL_BASE_MS,
    ),
    ...WORK_GRAPH_EVAL_VISITS.map((visit, index) => timelineEvent(index + 2, visit)),
    navigationEvent({
      seq: 20,
      replicaId: 'eval-replica-a',
      visitId: 'visit_pg_merge_a_replica_a',
      visit: pgA,
      offsetMinutes: 1,
    }),
    navigationEvent({
      seq: 21,
      replicaId: 'eval-replica-b',
      visitId: 'visit_pg_merge_a_replica_b',
      visit: pgA,
      offsetMinutes: 7,
    }),
    navigationEvent({
      seq: 22,
      replicaId: 'eval-replica-a',
      visitId: 'visit_pg_merge_b_replica_a',
      visit: pgB,
      offsetMinutes: 11,
      previousVisitId: 'visit_pg_merge_a_replica_a',
    }),
    navigationEvent({
      seq: 23,
      replicaId: 'eval-replica-a',
      visitId: 'visit_pg_merge_c_replica_a',
      visit: pgC,
      offsetMinutes: 16,
      previousVisitId: 'visit_pg_merge_b_replica_a',
    }),
    navigationEvent({
      seq: 24,
      replicaId: 'eval-replica-a',
      visitId: 'visit_negative_invoice_replica_a',
      visit: negative,
      offsetMinutes: 95,
    }),
    selectionCopiedEvent({
      seq: 30,
      replicaId: 'eval-replica-a',
      visitId: 'visit_pg_merge_a_replica_a',
      offsetMinutes: 2,
    }),
    selectionCopiedEvent({
      seq: 31,
      replicaId: 'eval-replica-b',
      visitId: 'visit_pg_merge_a_replica_b',
      offsetMinutes: 8,
    }),
  ];

  if (includeSeedFeedback) {
    events.push(
      feedbackEvent({
        seq: 40,
        type: USER_FLOW_CONFIRMED,
        relationKind: 'closest_visit',
        fromKey: 'pg_merge_a',
        toKey: 'pg_merge_b',
      }),
      feedbackEvent({
        seq: 41,
        type: USER_FLOW_CONFIRMED,
        relationKind: 'closest_visit',
        fromKey: 'pg_merge_a',
        toKey: 'pg_merge_c',
      }),
      feedbackEvent({
        seq: 42,
        type: USER_FLOW_REJECTED,
        relationKind: 'closest_visit',
        fromKey: 'pg_merge_a',
        toKey: 'negative_invoice',
      }),
    );
  }

  return events.sort(
    (left, right) =>
      left.acceptedAtMs - right.acceptedAtMs ||
      left.dot.replicaId.localeCompare(right.dot.replicaId) ||
      left.dot.seq - right.dot.seq,
  );
};
