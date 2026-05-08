import { describe, expect, it } from 'vitest';

import {
  edgeIdFor,
  nodeIdFor,
  type ConnectionEdge,
  type ConnectionNode,
  type ConnectionsSnapshot,
} from '../connections/types.js';
import { NAVIGATION_COMMITTED, type NavigationCommittedPayload } from '../navigation/events.js';
import { SELECTION_COPIED } from '../snippets/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  CONTINUATION_CLASSIFIER_REVISION_ID,
  buildContinuationEdges,
  classifyCrossReplicaContinuations,
  scoreCrossReplicaContinuationCandidates,
} from './classifier.js';

const BASE_TIME = Date.parse('2026-05-07T10:00:00.000Z');

const event = (input: {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly replicaId?: string;
  readonly acceptedAtMs?: number;
}): AcceptedEvent => ({
  clientEventId: `evt-${input.replicaId ?? 'replica-a'}-${String(input.seq)}`,
  dot: { replicaId: input.replicaId ?? 'replica-a', seq: input.seq },
  deps: {},
  aggregateId: `agg-${String(input.seq)}`,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? BASE_TIME + input.seq * 1_000,
});

const navigationPayload = (input: {
  readonly visitId: string;
  readonly canonicalUrl: string;
  readonly commitAt: string;
}): NavigationCommittedPayload => ({
  payloadVersion: 1,
  visitId: input.visitId,
  url: input.canonicalUrl,
  canonicalUrl: input.canonicalUrl,
  documentId: `doc-${input.visitId}`,
  parentDocumentId: null,
  tabSessionIdHash: `tab-${input.visitId}`,
  windowSessionIdHash: `window-${input.visitId}`,
  openerVisitId: null,
  previousVisitId: null,
  navigationSequence: 1,
  transitionType: 'link',
  transitionQualifiers: [],
  commitTimestamp: Date.parse(input.commitAt),
});

const selectionCopiedPayload = (input: {
  readonly visitId: string;
  readonly selectionHash: string;
}): unknown => ({
  payloadVersion: 1,
  visitId: input.visitId,
  selectionHash: input.selectionHash,
  simhash64: 'AAAAAAAAAAA=',
  charCount: 64,
  lineCount: 3,
  contentKindHint: 'code-block',
  rawTextStored: false,
});

const timelineNode = (input: {
  readonly key: string;
  readonly workstreamId?: string;
  readonly engagementClass?: string;
}): ConnectionNode => ({
  id: nodeIdFor('timeline-visit', input.key),
  kind: 'timeline-visit',
  label: input.key,
  firstSeenAt: new Date(BASE_TIME).toISOString(),
  lastSeenAt: new Date(BASE_TIME).toISOString(),
  originReplicaIds: [],
  metadata: {
    canonicalUrl: input.key,
    ...(input.workstreamId === undefined ? {} : { workstreamId: input.workstreamId }),
    ...(input.engagementClass === undefined
      ? {}
      : { engagement: { class: input.engagementClass } }),
  },
});

const crossReplicaEdge = (input: {
  readonly canonicalUrl: string;
  readonly replicaId: string;
  readonly observedAt: string;
}): ConnectionEdge => ({
  id: edgeIdFor(
    'visit_observed_on_replica',
    nodeIdFor('timeline-visit', input.canonicalUrl),
    nodeIdFor('replica', input.replicaId),
  ),
  kind: 'visit_observed_on_replica',
  fromNodeId: nodeIdFor('timeline-visit', input.canonicalUrl),
  toNodeId: nodeIdFor('replica', input.replicaId),
  observedAt: input.observedAt,
  producedBy: { source: 'cross-replica' },
  confidence: 'observed',
});

const snapshot = (
  input: {
    readonly nodes?: readonly ConnectionNode[];
    readonly edges?: readonly ConnectionEdge[];
  } = {},
): ConnectionsSnapshot => ({
  scope: {},
  nodes: input.nodes ?? [],
  edges: input.edges ?? [],
  updatedAt: new Date(BASE_TIME).toISOString(),
  nodeCount: input.nodes?.length ?? 0,
  edgeCount: input.edges?.length ?? 0,
});

describe('cross-replica continuation classifier', () => {
  it('emits a high-confidence continuation from S18 and continuation-specific features', () => {
    const canonicalUrl = 'https://example.test/shared';
    const merged: readonly AcceptedEvent[] = [
      event({
        seq: 1,
        replicaId: 'replica-laptop',
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-laptop',
          canonicalUrl,
          commitAt: '2026-05-07T10:00:00.000Z',
        }),
      }),
      event({
        seq: 2,
        replicaId: 'replica-desktop',
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-desktop',
          canonicalUrl,
          commitAt: '2026-05-07T10:25:00.000Z',
        }),
      }),
      event({
        seq: 3,
        type: SELECTION_COPIED,
        payload: selectionCopiedPayload({
          visitId: 'visit-laptop',
          selectionHash: 'sha256:shared-snippet',
        }),
      }),
      event({
        seq: 4,
        type: SELECTION_COPIED,
        payload: selectionCopiedPayload({
          visitId: 'visit-desktop',
          selectionHash: 'sha256:shared-snippet',
        }),
      }),
    ];
    const current = snapshot({
      nodes: [
        timelineNode({
          key: canonicalUrl,
          workstreamId: 'ws-research',
          engagementClass: 'active',
        }),
      ],
      edges: [
        crossReplicaEdge({
          canonicalUrl,
          replicaId: 'replica-laptop',
          observedAt: '2026-05-07T10:00:00.000Z',
        }),
        crossReplicaEdge({
          canonicalUrl,
          replicaId: 'replica-desktop',
          observedAt: '2026-05-07T10:25:00.000Z',
        }),
      ],
    });

    const predictions = classifyCrossReplicaContinuations({ merged, snapshot: current });

    expect(predictions).toHaveLength(1);
    expect(predictions[0]).toMatchObject({
      fromVisitId: 'visit-laptop',
      toVisitId: 'visit-desktop',
      canonicalUrl,
      fromReplicaId: 'replica-laptop',
      toReplicaId: 'replica-desktop',
    });
    expect(predictions[0]?.features).toMatchObject({
      same_canonical_url: 1,
      same_workstream: 1,
      engagement_class_match: 1,
      same_copied_snippet_count: 1,
      copy_paste_lineage_continuity: 1,
      time_since_prior_visit_minutes: 25,
    });
    expect(predictions[0]?.score).toBeGreaterThanOrEqual(0.7);

    const edges = buildContinuationEdges({ merged, snapshot: current });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      kind: 'visit_continues_visit',
      fromNodeId: nodeIdFor('timeline-visit', 'visit-laptop'),
      toNodeId: nodeIdFor('timeline-visit', 'visit-desktop'),
      observedAt: '2026-05-07T10:25:00.000Z',
      producedBy: {
        source: 'continuation-classifier',
        revisionId: CONTINUATION_CLASSIFIER_REVISION_ID,
      },
      confidence: 'inferred',
      family: 'flow',
    });
    expect(edges[0]?.metadata?.['score']).toBe(predictions[0]?.score);
  });

  it('scores low when only same-URL cross-replica evidence exists', () => {
    const canonicalUrl = 'https://example.test/shared';
    const merged: readonly AcceptedEvent[] = [
      event({
        seq: 1,
        replicaId: 'replica-laptop',
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-laptop',
          canonicalUrl,
          commitAt: '2026-05-07T10:00:00.000Z',
        }),
      }),
      event({
        seq: 2,
        replicaId: 'replica-desktop',
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-desktop',
          canonicalUrl,
          commitAt: '2026-05-14T10:00:00.000Z',
        }),
      }),
    ];
    const current = snapshot({
      edges: [
        crossReplicaEdge({
          canonicalUrl,
          replicaId: 'replica-laptop',
          observedAt: '2026-05-07T10:00:00.000Z',
        }),
        crossReplicaEdge({
          canonicalUrl,
          replicaId: 'replica-desktop',
          observedAt: '2026-05-14T10:00:00.000Z',
        }),
      ],
    });

    const scored = scoreCrossReplicaContinuationCandidates({ merged, snapshot: current });

    expect(scored).toHaveLength(1);
    expect(scored[0]?.score).toBeLessThan(0.7);
    expect(classifyCrossReplicaContinuations({ merged, snapshot: current })).toEqual([]);
  });

  it('requires existing visit_observed_on_replica evidence before scoring pairs', () => {
    const canonicalUrl = 'https://example.test/shared';
    const merged: readonly AcceptedEvent[] = [
      event({
        seq: 1,
        replicaId: 'replica-laptop',
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-laptop',
          canonicalUrl,
          commitAt: '2026-05-07T10:00:00.000Z',
        }),
      }),
      event({
        seq: 2,
        replicaId: 'replica-desktop',
        type: NAVIGATION_COMMITTED,
        payload: navigationPayload({
          visitId: 'visit-desktop',
          canonicalUrl,
          commitAt: '2026-05-07T10:01:00.000Z',
        }),
      }),
    ];

    expect(scoreCrossReplicaContinuationCandidates({ merged, snapshot: snapshot() })).toEqual([]);
  });
});
