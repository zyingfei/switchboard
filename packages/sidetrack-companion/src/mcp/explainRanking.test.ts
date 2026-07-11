import { describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot } from '../connections/types.js';
import type { CandidatePairFeatures } from '../ranker/feature-schema.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  EXPLAIN_RANKING_TOOL_NAME,
  explainRanking,
  type ExplainRankingDeps,
  type ExplainRankingPrediction,
} from './explainRanking.js';
import {
  registerCompanionMcpTools,
  type CompanionMcpToolDefinition,
  type CompanionMcpToolHandler,
  type CompanionMcpToolRegistry,
} from './server.js';

const fromVisit = 'https://example.test/ranker/debug-alpha';
const toVisit = 'https://example.test/ranker/debug-beta';
const observedAt = '2026-05-08T00:00:00.000Z';

const emptyEvents: readonly AcceptedEvent[] = [];

const snapshot: ConnectionsSnapshot = {
  scope: {},
  nodes: [
    {
      id: `timeline-visit:${fromVisit}`,
      kind: 'timeline-visit',
      label: 'Ranker Debug Alpha',
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      originReplicaIds: ['replica-a'],
      metadata: {
        canonicalUrl: fromVisit,
        url: fromVisit,
        title: 'Ranker Debug Alpha',
        workstreamId: 'ws_debug',
        engagement: { class: 'focused_reference' },
      },
    },
    {
      id: `timeline-visit:${toVisit}`,
      kind: 'timeline-visit',
      label: 'Ranker Debug Beta',
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      originReplicaIds: ['replica-a'],
      metadata: {
        canonicalUrl: toVisit,
        url: toVisit,
        title: 'Ranker Debug Beta',
        workstreamId: 'ws_debug',
        engagement: { class: 'focused_reference' },
      },
    },
    {
      id: 'workstream:ws_debug',
      kind: 'workstream',
      label: 'Debug',
      originReplicaIds: ['replica-a'],
      metadata: {},
    },
  ],
  edges: [
    {
      id: `edge:visit_resembles_visit:timeline-visit:${fromVisit}:timeline-visit:${toVisit}`,
      kind: 'visit_resembles_visit',
      fromNodeId: `timeline-visit:${fromVisit}`,
      toNodeId: `timeline-visit:${toVisit}`,
      observedAt,
      producedBy: { source: 'visit-similarity', revisionId: 'visit-sim-fixture' },
      confidence: 'inferred',
      family: 'urlmatch',
      metadata: { cosine: 0.82 },
    },
    {
      id: `edge:visit_in_workstream:timeline-visit:${fromVisit}:workstream:ws_debug`,
      kind: 'visit_in_workstream',
      fromNodeId: `timeline-visit:${fromVisit}`,
      toNodeId: 'workstream:ws_debug',
      observedAt,
      producedBy: { source: 'event-log', eventType: 'user.organized.item' },
      confidence: 'asserted',
      family: 'contain',
    },
    {
      id: `edge:visit_in_workstream:timeline-visit:${toVisit}:workstream:ws_debug`,
      kind: 'visit_in_workstream',
      fromNodeId: `timeline-visit:${toVisit}`,
      toNodeId: 'workstream:ws_debug',
      observedAt,
      producedBy: { source: 'event-log', eventType: 'user.organized.item' },
      confidence: 'asserted',
      family: 'contain',
    },
  ],
  updatedAt: observedAt,
  nodeCount: 3,
  edgeCount: 3,
};

const contributions = (overrides: Partial<Record<keyof CandidatePairFeatures, number>>) =>
  ({
    schemaVersion: 0.1,
    same_workstream: 0,
    opener_chain_depth: 0,
    in_navigation_chain: 0,
    same_canonical_url: 0,
    same_host: 0.12,
    same_repo: 0,
    same_search_query: 0,
    same_copied_snippet_count: 0,
    shared_title_tokens: 0.02,
    shared_path_tokens: 0.11,
    cosine_similarity: 0.22,
    recency_score_from: 0.04,
    recency_score_to: 0.03,
    engagement_class_match: 0.08,
    return_count_from: 0,
    return_count_to: 0,
    user_asserted_in_thread: 0,
    user_asserted_in_workstream: 0,
    same_active_topic: 0,
    topic_lineage_merge_split_related: 0,
    page_quality_tier_from: 0,
    page_quality_tier_to: 0,
    // v5 content-evidence features
    shared_content_terms: 0,
    shared_content_keyphrases: 0,
    content_weighted_jaccard: 0,
    content_vector_cosine: 0,
    content_entity_overlap: 0,
    content_evidence_tier_from: 0,
    content_evidence_tier_to: 0,
    content_both_available: 0,
    content_quality_pair_min: 0,
    chunk_support_count: 0,
    max_chunk_pair_score: 0,
    // v6 chunk-vector MaxSim + /v2 retrieval-derived features (schema v6)
    max_chunk_pair_vector_cosine: 0,
    top3_mean_chunk_pair_vector_cosine: 0,
    chunk_pair_vector_support_count: 0,
    bm25_score: 0,
    bm25_rank: 0,
    dense_doc_score: 0,
    dense_doc_rank: 0,
    rrf_score: 0,
    rrf_rank: 0,
    graph_similarity_rank: 0,
    candidate_source_flags: 0,
    served_position: 0,
    cross_encoder_score: 0,
    cross_encoder_rank_delta: 0,
    ...overrides,
  }) satisfies Readonly<Partial<Record<keyof CandidatePairFeatures, number>>>;

const deps = (): ExplainRankingDeps => ({
  readMergedEvents: () => Promise.resolve(emptyEvents),
  readConnectionsSnapshot: () => Promise.resolve(snapshot),
  loadActiveRanker: () =>
    Promise.resolve({
      ranker: {
        revisionId: 'ranker-rev-fixture',
        modelVersion: 'lightgbm-lambdamart-v1',
        predict: (): ExplainRankingPrediction => ({
          score: 0.81234567,
          contributions: contributions({}),
        }),
      },
    }),
});

describe('sidetrack.debug.explainRanking', () => {
  it('returns exact stable debug JSON for a fixture visit pair', async () => {
    await expect(explainRanking({ from: fromVisit, to: toVisit }, deps())).resolves.toEqual({
      features: {
        // schemaVersion bumped 4→5 (PageEvidence content features),
        // then 5→6 (chunk-vector MaxSim + /v2 retrieval features; commit 7b401adf).
        schemaVersion: 6,
        same_workstream: 1,
        opener_chain_depth: 0,
        in_navigation_chain: 0,
        same_canonical_url: 0,
        same_host: 1,
        same_repo: 0,
        same_search_query: 0,
        same_copied_snippet_count: 0,
        shared_title_tokens: 2,
        shared_path_tokens: 2,
        cosine_similarity: 0.82,
        recency_score_from: 1,
        recency_score_to: 1,
        engagement_class_match: 1,
        return_count_from: 0,
        return_count_to: 0,
        user_asserted_in_thread: 0,
        user_asserted_in_workstream: 1,
        same_active_topic: 0,
        topic_lineage_merge_split_related: 0,
        page_quality_tier_from: 0,
        page_quality_tier_to: 0,
        // v5 content-evidence features
        shared_content_terms: 0,
        shared_content_keyphrases: 0,
        content_weighted_jaccard: 0,
        content_vector_cosine: 0,
        content_entity_overlap: 0,
        content_evidence_tier_from: 0,
        content_evidence_tier_to: 0,
        content_both_available: 0,
        content_quality_pair_min: 0,
        chunk_support_count: 0,
        max_chunk_pair_score: 0,
        // v6 chunk-vector MaxSim + /v2 retrieval-derived features
        max_chunk_pair_vector_cosine: 0,
        top3_mean_chunk_pair_vector_cosine: 0,
        chunk_pair_vector_support_count: 0,
        bm25_score: 0,
        bm25_rank: 0,
        dense_doc_score: 0,
        dense_doc_rank: 0,
        rrf_score: 0,
        rrf_rank: 0,
        graph_similarity_rank: 0,
        candidate_source_flags: 0,
        served_position: 0,
        cross_encoder_score: 0,
        cross_encoder_rank_delta: 0,
      },
      modelVersion: 'lightgbm-lambdamart-v1',
      revisionId: 'ranker-rev-fixture',
      score: 0.812346,
      contributions: [
        { feature: 'same_workstream', weight: 0 },
        { feature: 'opener_chain_depth', weight: 0 },
        { feature: 'in_navigation_chain', weight: 0 },
        { feature: 'same_canonical_url', weight: 0 },
        { feature: 'same_host', weight: 0.12 },
        { feature: 'same_repo', weight: 0 },
        { feature: 'same_search_query', weight: 0 },
        { feature: 'same_copied_snippet_count', weight: 0 },
        { feature: 'shared_title_tokens', weight: 0.02 },
        { feature: 'shared_path_tokens', weight: 0.11 },
        { feature: 'cosine_similarity', weight: 0.22 },
        { feature: 'recency_score_from', weight: 0.04 },
        { feature: 'recency_score_to', weight: 0.03 },
        { feature: 'engagement_class_match', weight: 0.08 },
        { feature: 'return_count_from', weight: 0 },
        { feature: 'return_count_to', weight: 0 },
        { feature: 'user_asserted_in_thread', weight: 0 },
        { feature: 'user_asserted_in_workstream', weight: 0 },
        { feature: 'same_active_topic', weight: 0 },
        { feature: 'topic_lineage_merge_split_related', weight: 0 },
        { feature: 'page_quality_tier_from', weight: 0 },
        { feature: 'page_quality_tier_to', weight: 0 },
        { feature: 'shared_content_terms', weight: 0 },
        { feature: 'shared_content_keyphrases', weight: 0 },
        { feature: 'content_weighted_jaccard', weight: 0 },
        { feature: 'content_vector_cosine', weight: 0 },
        { feature: 'content_entity_overlap', weight: 0 },
        { feature: 'content_evidence_tier_from', weight: 0 },
        { feature: 'content_evidence_tier_to', weight: 0 },
        { feature: 'content_both_available', weight: 0 },
        { feature: 'content_quality_pair_min', weight: 0 },
        { feature: 'chunk_support_count', weight: 0 },
        { feature: 'max_chunk_pair_score', weight: 0 },
        // v6 chunk-vector MaxSim + /v2 retrieval-derived features
        { feature: 'max_chunk_pair_vector_cosine', weight: 0 },
        { feature: 'top3_mean_chunk_pair_vector_cosine', weight: 0 },
        { feature: 'chunk_pair_vector_support_count', weight: 0 },
        { feature: 'bm25_score', weight: 0 },
        { feature: 'bm25_rank', weight: 0 },
        { feature: 'dense_doc_score', weight: 0 },
        { feature: 'dense_doc_rank', weight: 0 },
        { feature: 'rrf_score', weight: 0 },
        { feature: 'rrf_rank', weight: 0 },
        { feature: 'graph_similarity_rank', weight: 0 },
        { feature: 'candidate_source_flags', weight: 0 },
        { feature: 'served_position', weight: 0 },
        { feature: 'cross_encoder_score', weight: 0 },
        { feature: 'cross_encoder_rank_delta', weight: 0 },
      ],
      sortedReasonCodes: [
        {
          code: 'RANKER_SCORE',
          payload: {
            score: 0.812346,
            topContributions: [
              { feature: 'cosine_similarity', weight: 0.22 },
              { feature: 'same_host', weight: 0.12 },
              { feature: 'shared_path_tokens', weight: 0.11 },
            ],
          },
        },
        { code: 'COSINE_SIMILARITY', payload: { value: 0.82 } },
        { code: 'SAME_HOST', payload: { feature: 'same_host', value: 1 } },
        { code: 'SHARED_PATH_TOKENS', payload: { count: 2 } },
        {
          code: 'ENGAGEMENT_CLASS_MATCH',
          payload: { feature: 'engagement_class_match', value: 1 },
        },
        { code: 'RECENCY', payload: { from: 1, to: 1 } },
        { code: 'SHARED_TITLE_TOKENS', payload: { count: 2 } },
      ],
    });
  });

  it('registers the read-only companion MCP tool', async () => {
    const registrations: {
      readonly definition: CompanionMcpToolDefinition;
      readonly handler: CompanionMcpToolHandler;
    }[] = [];
    const registry: CompanionMcpToolRegistry = {
      registerTool: (name, toolDefinition, toolHandler) => {
        expect(name).toBe(EXPLAIN_RANKING_TOOL_NAME);
        registrations.push({ definition: toolDefinition, handler: toolHandler });
      },
    };

    registerCompanionMcpTools(registry, deps());

    const registration = registrations[0];
    expect(registration).toBeDefined();
    if (registration === undefined) throw new Error('expected explainRanking registration');
    expect(registration.definition.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    await expect(registration.handler({ from: fromVisit, to: toVisit })).resolves.toMatchObject({
      structuredContent: {
        modelVersion: 'lightgbm-lambdamart-v1',
        revisionId: 'ranker-rev-fixture',
        score: 0.812346,
      },
    });
  });
});
