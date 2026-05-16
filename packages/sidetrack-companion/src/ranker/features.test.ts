import { describe, expect, it } from 'vitest';

import {
  type ConnectionEdge,
  type ConnectionEdgeKind,
  type ConnectionNode,
  type ConnectionNodeKind,
  type ConnectionNodeMetadata,
  nodeIdFor,
} from '../connections/types.js';
import { ENGAGEMENT_SESSION_AGGREGATED, type EngagementDimensions } from '../engagement/events.js';
import { USER_ORGANIZED_ITEM } from '../feedback/events.js';
import { NAVIGATION_COMMITTED } from '../navigation/events.js';
import { PAGE_CONTENT_EXTRACTED, PAGE_CONTENT_TOMBSTONED } from '../page-content/types.js';
import { SELECTION_COPIED } from '../snippets/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  CANDIDATE_PAIR_FEATURE_KEYS,
  FEATURE_SCHEMA_VERSION,
  type CandidatePairFeatures,
} from './feature-schema.js';
import { extractFeatures } from './features.js';
import type { Candidate } from './types.js';

const BASE_TIME = Date.parse('2026-05-07T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1_000;

const iso = (offsetMs = 0): string => new Date(BASE_TIME + offsetMs).toISOString();

const event = (input: {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly acceptedAtMs?: number;
  readonly replicaId?: string;
}): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: input.replicaId ?? 'replica-a', seq: input.seq },
  deps: {},
  aggregateId: `agg-${String(input.seq)}`,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? BASE_TIME + input.seq * 1_000,
});

const candidate = (
  input: {
    readonly fromVisitId?: string;
    readonly toVisitId?: string;
  } = {},
): Candidate => ({
  fromVisitId: input.fromVisitId ?? 'visit-a',
  toVisitId: input.toVisitId ?? 'visit-b',
  sources: [],
  generatedAt: BASE_TIME,
});

const snapshot = (
  input: {
    readonly nodes?: readonly ConnectionNode[];
    readonly edges?: readonly ConnectionEdge[];
    readonly updatedAt?: string;
  } = {},
) => ({
  scope: {},
  nodes: input.nodes ?? [],
  edges: input.edges ?? [],
  updatedAt: input.updatedAt ?? iso(),
  nodeCount: input.nodes?.length ?? 0,
  edgeCount: input.edges?.length ?? 0,
});

const node = (input: {
  readonly kind?: ConnectionNodeKind;
  readonly key: string;
  readonly label?: string;
  readonly firstSeenAt?: string;
  readonly lastSeenAt?: string;
  readonly metadata?: ConnectionNodeMetadata;
}): ConnectionNode => ({
  id: nodeIdFor(input.kind ?? 'timeline-visit', input.key),
  kind: input.kind ?? 'timeline-visit',
  label: input.label ?? input.key,
  ...(input.firstSeenAt === undefined ? {} : { firstSeenAt: input.firstSeenAt }),
  ...(input.lastSeenAt === undefined ? {} : { lastSeenAt: input.lastSeenAt }),
  originReplicaIds: [],
  metadata: input.metadata ?? {},
});

const edge = (input: {
  readonly kind: ConnectionEdgeKind;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly observedAt?: string;
  readonly confidence?: ConnectionEdge['confidence'];
  readonly metadata?: ConnectionEdge['metadata'];
}): ConnectionEdge => ({
  id: `edge:${input.kind}:${input.fromNodeId}:${input.toNodeId}`,
  kind: input.kind,
  fromNodeId: input.fromNodeId,
  toNodeId: input.toNodeId,
  observedAt: input.observedAt ?? iso(),
  producedBy: { source: 'timeline-projection' },
  confidence: input.confidence ?? 'inferred',
  ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
});

const navigationPayload = (input: {
  readonly visitId: string;
  readonly canonicalUrl: string;
  readonly openerVisitId?: string | null;
  readonly previousVisitId?: string | null;
  readonly commitTimestamp?: number;
}): unknown => ({
  payloadVersion: 1,
  visitId: input.visitId,
  url: input.canonicalUrl,
  canonicalUrl: input.canonicalUrl,
  documentId: `doc-${input.visitId}`,
  parentDocumentId: null,
  tabSessionIdHash: 'tab-a',
  windowSessionIdHash: 'window-a',
  openerVisitId: input.openerVisitId ?? null,
  previousVisitId: input.previousVisitId ?? null,
  navigationSequence: 1,
  transitionType: 'link',
  transitionQualifiers: [],
  commitTimestamp: input.commitTimestamp ?? BASE_TIME,
});

const snippetPayload = (input: {
  readonly visitId: string;
  readonly selectionHash: string;
}): unknown => ({
  payloadVersion: 1,
  visitId: input.visitId,
  selectionHash: input.selectionHash,
  simhash64: 'AAAAAAAAAAA=',
  charCount: 42,
  lineCount: 2,
  contentKindHint: 'code-block',
  rawTextStored: false,
});

const emptyEngagement = (): EngagementDimensions => ({
  activeMs: 0,
  visibleMs: 0,
  focusedWindowMs: 0,
  idleMs: 0,
  foregroundBursts: 0,
  returnCount: 0,
  scrollEvents: 0,
  maxScrollRatio: 0,
  copyCount: 0,
  pasteCount: 0,
});

const engagementPayload = (input: {
  readonly visitId: string;
  readonly sessionId: string;
  readonly returnCount: number;
}): unknown => ({
  payloadVersion: 1,
  visitId: input.visitId,
  sessionId: input.sessionId,
  dimensions: {
    engagement: {
      ...emptyEngagement(),
      returnCount: input.returnCount,
    },
  },
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

const pageContentPayload = (input: {
  readonly canonicalUrl: string;
  readonly quality: 'high' | 'medium' | 'low';
}): unknown => ({
  payloadVersion: 1,
  canonicalUrl: input.canonicalUrl,
  url: input.canonicalUrl,
  extractedAt: iso(),
  extractionSource: 'reader-mode',
  extractionPolicy: { trigger: 'manual' },
  quality: input.quality,
  qualitySignals: {
    extractedWordCount: 800,
    contentToDomRatio: 0.6,
    boilerplateFraction: 0.1,
    extractionStrategy: 'reader-mode',
  },
  content: {
    text: 'extracted body text',
    contentHash: `hash-${input.canonicalUrl}`,
    charCount: 19,
  },
});

const pageContentTombstonePayload = (canonicalUrl: string): unknown => ({
  payloadVersion: 1,
  canonicalUrl,
  tombstonedAt: iso(),
  reason: 'user-delete',
});

const extract = (
  input: {
    readonly candidate?: Candidate;
    readonly merged?: readonly AcceptedEvent[];
    readonly nodes?: readonly ConnectionNode[];
    readonly edges?: readonly ConnectionEdge[];
    readonly updatedAt?: string;
  } = {},
): CandidatePairFeatures => {
  const snapshotInput = {
    ...(input.nodes === undefined ? {} : { nodes: input.nodes }),
    ...(input.edges === undefined ? {} : { edges: input.edges }),
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
  };
  return extractFeatures(input.candidate ?? candidate(), {
    merged: [...(input.merged ?? [])],
    snapshot: snapshot(snapshotInput),
  });
};

describe('ranker feature schema', () => {
  it('keeps schema version 1 and byte-stable feature serialization', () => {
    const first = JSON.stringify(extract());
    const second = JSON.stringify(extract());

    expect(FEATURE_SCHEMA_VERSION).toBe(3);
    expect(first).toBe(second);
    expect(Object.keys(JSON.parse(first) as Record<string, unknown>)).toEqual(
      CANDIDATE_PAIR_FEATURE_KEYS,
    );
    expect(JSON.parse(first) as CandidatePairFeatures).toEqual({
      schemaVersion: 3,
      same_workstream: 0,
      opener_chain_depth: 0,
      in_navigation_chain: 0,
      same_canonical_url: 0,
      same_host: 0,
      same_repo: 0,
      same_search_query: 0,
      same_copied_snippet_count: 0,
      shared_title_tokens: 0,
      shared_path_tokens: 0,
      cosine_similarity: 0,
      recency_score_from: 0,
      recency_score_to: 0,
      engagement_class_match: 0,
      return_count_from: 0,
      return_count_to: 0,
      user_asserted_in_thread: 0,
      user_asserted_in_workstream: 0,
      same_active_topic: 0,
      topic_lineage_merge_split_related: 0,
      page_quality_tier_from: 0,
      page_quality_tier_to: 0,
    });
  });
});

describe('ranker graph and navigation features', () => {
  it('sets same_workstream when snapshot visits share a workstream', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/a',
        toVisitId: 'https://bravo.test/b',
      }),
      nodes: [
        node({ key: 'https://alpha.test/a', metadata: { workstreamId: 'ws-a' } }),
        node({ key: 'https://bravo.test/b', metadata: { workstreamId: 'ws-a' } }),
      ],
    });

    expect(features.same_workstream).toBe(1);
  });

  it('computes opener_chain_depth as shortest opener distance', () => {
    const features = extract({
      candidate: candidate({ fromVisitId: 'visit-a', toVisitId: 'visit-c' }),
      merged: [
        event({
          seq: 1,
          type: NAVIGATION_COMMITTED,
          payload: navigationPayload({
            visitId: 'visit-a',
            canonicalUrl: 'https://alpha.test/a',
          }),
        }),
        event({
          seq: 2,
          type: NAVIGATION_COMMITTED,
          payload: navigationPayload({
            visitId: 'visit-b',
            canonicalUrl: 'https://alpha.test/b',
            openerVisitId: 'visit-a',
          }),
        }),
        event({
          seq: 3,
          type: NAVIGATION_COMMITTED,
          payload: navigationPayload({
            visitId: 'visit-c',
            canonicalUrl: 'https://alpha.test/c',
            openerVisitId: 'visit-b',
          }),
        }),
      ],
    });

    expect(features.opener_chain_depth).toBe(2);
  });

  it('sets in_navigation_chain for previous-visit chains', () => {
    const features = extract({
      candidate: candidate({ fromVisitId: 'visit-a', toVisitId: 'visit-c' }),
      merged: [
        event({
          seq: 1,
          type: NAVIGATION_COMMITTED,
          payload: navigationPayload({
            visitId: 'visit-a',
            canonicalUrl: 'https://alpha.test/a',
          }),
        }),
        event({
          seq: 2,
          type: NAVIGATION_COMMITTED,
          payload: navigationPayload({
            visitId: 'visit-b',
            canonicalUrl: 'https://alpha.test/b',
            previousVisitId: 'visit-a',
          }),
        }),
        event({
          seq: 3,
          type: NAVIGATION_COMMITTED,
          payload: navigationPayload({
            visitId: 'visit-c',
            canonicalUrl: 'https://alpha.test/c',
            previousVisitId: 'visit-b',
          }),
        }),
      ],
    });

    expect(features.in_navigation_chain).toBe(1);
  });
});

describe('ranker URL and text features', () => {
  it('sets same_canonical_url for normalized matching canonical URLs', () => {
    const features = extract({
      candidate: candidate({ fromVisitId: 'visit-a', toVisitId: 'visit-b' }),
      merged: [
        event({
          seq: 1,
          type: NAVIGATION_COMMITTED,
          payload: navigationPayload({
            visitId: 'visit-a',
            canonicalUrl: 'https://docs.test/page#intro',
          }),
        }),
        event({
          seq: 2,
          type: NAVIGATION_COMMITTED,
          payload: navigationPayload({
            visitId: 'visit-b',
            canonicalUrl: 'https://docs.test/page/',
          }),
        }),
      ],
    });

    expect(features.same_canonical_url).toBe(1);
  });

  it('sets same_host for matching normalized hosts', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://www.docs.test/a',
        toVisitId: 'https://docs.test/b',
      }),
    });

    expect(features.same_host).toBe(1);
  });

  it('sets same_repo only for matching Git repo paths', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://github.com/Org/Repo',
        toVisitId: 'https://github.com/org/repo/issues/1',
      }),
    });

    expect(features.same_repo).toBe(1);
  });

  it('sets same_search_query for normalized search query matches', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://search.test/search?q=Ranker%20Features',
        toVisitId: 'https://search.test/?q=ranker+features',
      }),
    });

    expect(features.same_search_query).toBe(1);
  });

  it('counts shared title tokens', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://docs.test/a',
        toVisitId: 'https://docs.test/b',
      }),
      nodes: [
        node({
          key: 'https://docs.test/a',
          metadata: { title: 'Ranker feature extraction design' },
        }),
        node({ key: 'https://docs.test/b', metadata: { title: 'Feature extraction checklist' } }),
      ],
    });

    expect(features.shared_title_tokens).toBe(2);
  });

  it('counts shared path tokens', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://docs.test/reference/ranker/features',
        toVisitId: 'https://docs.test/guide/ranker/features',
      }),
    });

    expect(features.shared_path_tokens).toBe(2);
  });
});

describe('ranker content, recency, and engagement features', () => {
  it('counts shared copied snippets from copy events', () => {
    const features = extract({
      merged: [
        event({
          seq: 1,
          type: SELECTION_COPIED,
          payload: snippetPayload({ visitId: 'visit-a', selectionHash: 'hash-1' }),
        }),
        event({
          seq: 2,
          type: SELECTION_COPIED,
          payload: snippetPayload({ visitId: 'visit-b', selectionHash: 'hash-1' }),
        }),
        event({
          seq: 3,
          type: SELECTION_COPIED,
          payload: snippetPayload({ visitId: 'visit-a', selectionHash: 'hash-2' }),
        }),
        event({
          seq: 4,
          type: SELECTION_COPIED,
          payload: snippetPayload({ visitId: 'visit-b', selectionHash: 'hash-2' }),
        }),
        event({
          seq: 5,
          type: SELECTION_COPIED,
          payload: snippetPayload({ visitId: 'visit-a', selectionHash: 'hash-3' }),
        }),
      ],
    });

    expect(features.same_copied_snippet_count).toBe(2);
  });

  it('uses snapshot similarity metadata for cosine_similarity without recomputation', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/a',
        toVisitId: 'https://alpha.test/b',
      }),
      edges: [
        edge({
          kind: 'visit_resembles_visit',
          fromNodeId: nodeIdFor('timeline-visit', 'https://alpha.test/a'),
          toNodeId: nodeIdFor('timeline-visit', 'https://alpha.test/b'),
          metadata: { cosine: 0.87 },
        }),
      ],
    });

    expect(features.cosine_similarity).toBe(0.87);
  });

  it('computes recency scores from deterministic snapshot time', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/recent',
        toVisitId: 'https://alpha.test/older',
      }),
      updatedAt: iso(),
      nodes: [
        node({ key: 'https://alpha.test/recent', lastSeenAt: iso(-30 * DAY_MS) }),
        node({ key: 'https://alpha.test/older', lastSeenAt: iso(-60 * DAY_MS) }),
      ],
    });

    expect(features.recency_score_from).toBeCloseTo(Math.exp(-1), 12);
    expect(features.recency_score_to).toBeCloseTo(Math.exp(-2), 12);
  });

  it('sets engagement_class_match when both visits have the same class', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/a',
        toVisitId: 'https://alpha.test/b',
      }),
      nodes: [
        node({
          key: 'https://alpha.test/a',
          metadata: { engagement: { class: 'worked_on_reference' } },
        }),
        node({
          key: 'https://alpha.test/b',
          metadata: { engagement: { class: 'worked_on_reference' } },
        }),
      ],
    });

    expect(features.engagement_class_match).toBe(1);
  });

  it('returns engagement_class_match 0 when either class is missing', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/a',
        toVisitId: 'https://alpha.test/b',
      }),
      nodes: [
        node({
          key: 'https://alpha.test/a',
          metadata: { engagement: { class: 'worked_on_reference' } },
        }),
        node({ key: 'https://alpha.test/b' }),
      ],
    });

    expect(features.engagement_class_match).toBe(0);
  });

  it('sums latest return_count_from and return_count_to by visit/session', () => {
    const features = extract({
      merged: [
        event({
          seq: 1,
          type: ENGAGEMENT_SESSION_AGGREGATED,
          payload: engagementPayload({
            visitId: 'visit-a',
            sessionId: 'session-1',
            returnCount: 1,
          }),
          acceptedAtMs: BASE_TIME + 1,
        }),
        event({
          seq: 2,
          type: ENGAGEMENT_SESSION_AGGREGATED,
          payload: engagementPayload({
            visitId: 'visit-a',
            sessionId: 'session-1',
            returnCount: 3,
          }),
          acceptedAtMs: BASE_TIME + 2,
        }),
        event({
          seq: 3,
          type: ENGAGEMENT_SESSION_AGGREGATED,
          payload: engagementPayload({
            visitId: 'visit-a',
            sessionId: 'session-2',
            returnCount: 2,
          }),
        }),
        event({
          seq: 4,
          type: ENGAGEMENT_SESSION_AGGREGATED,
          payload: engagementPayload({
            visitId: 'visit-b',
            sessionId: 'session-1',
            returnCount: 7,
          }),
        }),
      ],
    });

    expect(features.return_count_from).toBe(5);
    expect(features.return_count_to).toBe(7);
  });
});

describe('ranker user-asserted features', () => {
  it('sets user_asserted_in_thread from organized visit feedback', () => {
    const features = extract({
      merged: [
        event({
          seq: 1,
          type: USER_ORGANIZED_ITEM,
          payload: organizedVisitPayload({ visitId: 'visit-a', toContainer: 'thread:thread-1' }),
        }),
        event({
          seq: 2,
          type: USER_ORGANIZED_ITEM,
          payload: organizedVisitPayload({ visitId: 'visit-b', toContainer: 'thread:thread-1' }),
        }),
      ],
    });

    expect(features.user_asserted_in_thread).toBe(1);
  });

  it('sets user_asserted_in_workstream from asserted snapshot edges', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/a',
        toVisitId: 'https://alpha.test/b',
      }),
      edges: [
        edge({
          kind: 'visit_in_workstream',
          fromNodeId: nodeIdFor('timeline-visit', 'https://alpha.test/a'),
          toNodeId: nodeIdFor('workstream', 'ws-a'),
          confidence: 'asserted',
        }),
        edge({
          kind: 'visit_in_workstream',
          fromNodeId: nodeIdFor('timeline-visit', 'https://alpha.test/b'),
          toNodeId: nodeIdFor('workstream', 'ws-a'),
          confidence: 'asserted',
        }),
      ],
    });

    expect(features.user_asserted_in_workstream).toBe(1);
  });
});

describe('ranker lineage-aware topic features', () => {
  const visitInTopic = (input: {
    readonly canonicalUrl: string;
    readonly topicId: string;
    readonly affiliation?: 'primary' | 'secondary';
  }): ConnectionEdge =>
    edge({
      kind: 'visit_in_topic',
      fromNodeId: nodeIdFor('timeline-visit', input.canonicalUrl),
      toNodeId: nodeIdFor('topic', input.topicId),
      metadata: { affiliation: input.affiliation ?? 'primary' },
    });

  const topicLineage = (input: {
    readonly fromTopicId: string;
    readonly toTopicId: string;
    readonly lineageKind: 'birth' | 'continue' | 'split' | 'merge' | 'death' | 'resurface';
  }): ConnectionEdge =>
    edge({
      kind: 'topic.lineage',
      fromNodeId: nodeIdFor('topic', input.fromTopicId),
      toNodeId: nodeIdFor('topic', input.toTopicId),
      confidence: 'observed',
      metadata: { lineageKind: input.lineageKind },
    });

  it('sets same_active_topic when both visits are primary members of one topic', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/a',
        toVisitId: 'https://alpha.test/b',
      }),
      edges: [
        visitInTopic({ canonicalUrl: 'https://alpha.test/a', topicId: 'topic-1' }),
        visitInTopic({ canonicalUrl: 'https://alpha.test/b', topicId: 'topic-1' }),
      ],
    });

    expect(features.same_active_topic).toBe(1);
    expect(features.topic_lineage_merge_split_related).toBe(0);
  });

  it('ignores secondary affiliations for same_active_topic', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/a',
        toVisitId: 'https://alpha.test/b',
      }),
      edges: [
        visitInTopic({ canonicalUrl: 'https://alpha.test/a', topicId: 'topic-1' }),
        visitInTopic({
          canonicalUrl: 'https://alpha.test/b',
          topicId: 'topic-1',
          affiliation: 'secondary',
        }),
      ],
    });

    expect(features.same_active_topic).toBe(0);
  });

  it('sets topic_lineage_merge_split_related across a split lineage edge', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/a',
        toVisitId: 'https://alpha.test/b',
      }),
      edges: [
        visitInTopic({ canonicalUrl: 'https://alpha.test/a', topicId: 'topic-old' }),
        visitInTopic({ canonicalUrl: 'https://alpha.test/b', topicId: 'topic-new' }),
        topicLineage({
          fromTopicId: 'topic-old',
          toTopicId: 'topic-new',
          lineageKind: 'split',
        }),
      ],
    });

    expect(features.same_active_topic).toBe(0);
    expect(features.topic_lineage_merge_split_related).toBe(1);
  });

  it('sets topic_lineage_merge_split_related for merge lineage regardless of edge direction', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/b',
        toVisitId: 'https://alpha.test/a',
      }),
      edges: [
        visitInTopic({ canonicalUrl: 'https://alpha.test/a', topicId: 'topic-old' }),
        visitInTopic({ canonicalUrl: 'https://alpha.test/b', topicId: 'topic-new' }),
        topicLineage({
          fromTopicId: 'topic-old',
          toTopicId: 'topic-new',
          lineageKind: 'merge',
        }),
      ],
    });

    expect(features.topic_lineage_merge_split_related).toBe(1);
  });

  it('does not treat continue/birth lineage as a merge/split relation', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/a',
        toVisitId: 'https://alpha.test/b',
      }),
      edges: [
        visitInTopic({ canonicalUrl: 'https://alpha.test/a', topicId: 'topic-old' }),
        visitInTopic({ canonicalUrl: 'https://alpha.test/b', topicId: 'topic-new' }),
        topicLineage({
          fromTopicId: 'topic-old',
          toTopicId: 'topic-new',
          lineageKind: 'continue',
        }),
      ],
    });

    expect(features.topic_lineage_merge_split_related).toBe(0);
  });
});

describe('ranker page-content quality features', () => {
  it('encodes the from/to page quality tier from extracted content events', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/high',
        toVisitId: 'https://alpha.test/low',
      }),
      merged: [
        event({
          seq: 1,
          type: PAGE_CONTENT_EXTRACTED,
          payload: pageContentPayload({
            canonicalUrl: 'https://alpha.test/high',
            quality: 'high',
          }),
        }),
        event({
          seq: 2,
          type: PAGE_CONTENT_EXTRACTED,
          payload: pageContentPayload({
            canonicalUrl: 'https://alpha.test/low',
            quality: 'low',
          }),
        }),
      ],
    });

    expect(features.page_quality_tier_from).toBe(3);
    expect(features.page_quality_tier_to).toBe(1);
  });

  it('keeps the latest extracted quality and 0 when no content was extracted', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/upgraded',
        toVisitId: 'https://alpha.test/unknown',
      }),
      merged: [
        event({
          seq: 1,
          type: PAGE_CONTENT_EXTRACTED,
          payload: pageContentPayload({
            canonicalUrl: 'https://alpha.test/upgraded',
            quality: 'low',
          }),
          acceptedAtMs: BASE_TIME + 1,
        }),
        event({
          seq: 2,
          type: PAGE_CONTENT_EXTRACTED,
          payload: pageContentPayload({
            canonicalUrl: 'https://alpha.test/upgraded',
            quality: 'medium',
          }),
          acceptedAtMs: BASE_TIME + 2,
        }),
      ],
    });

    expect(features.page_quality_tier_from).toBe(2);
    expect(features.page_quality_tier_to).toBe(0);
  });

  it('treats a later page-content tombstone as unknown quality', () => {
    const features = extract({
      candidate: candidate({
        fromVisitId: 'https://alpha.test/deleted',
        toVisitId: 'https://alpha.test/recreated',
      }),
      merged: [
        event({
          seq: 1,
          type: PAGE_CONTENT_EXTRACTED,
          payload: pageContentPayload({
            canonicalUrl: 'https://alpha.test/deleted',
            quality: 'high',
          }),
          acceptedAtMs: BASE_TIME + 1,
        }),
        event({
          seq: 2,
          type: PAGE_CONTENT_TOMBSTONED,
          payload: pageContentTombstonePayload('https://alpha.test/deleted'),
          acceptedAtMs: BASE_TIME + 2,
        }),
        event({
          seq: 3,
          type: PAGE_CONTENT_TOMBSTONED,
          payload: pageContentTombstonePayload('https://alpha.test/recreated'),
          acceptedAtMs: BASE_TIME + 1,
        }),
        event({
          seq: 4,
          type: PAGE_CONTENT_EXTRACTED,
          payload: pageContentPayload({
            canonicalUrl: 'https://alpha.test/recreated',
            quality: 'medium',
          }),
          acceptedAtMs: BASE_TIME + 2,
        }),
      ],
    });

    expect(features.page_quality_tier_from).toBe(0);
    expect(features.page_quality_tier_to).toBe(2);
  });
});
