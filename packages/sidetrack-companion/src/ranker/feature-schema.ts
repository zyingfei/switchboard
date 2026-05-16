import type { ConnectionsSnapshot } from '../connections/types.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { Candidate } from './types.js';

// Bumped 3 → 4 when PageEvidence content terms/vectors became ranker
// features. Persisted v3 models are rejected so the scorer cannot
// silently ignore the new content-evidence columns during validation.
//
// Bumped 2 → 3 when the closest_visit scorer stopped consuming
// workstream-identity leakage features. Persisted v2 models are
// rejected so the scorer cannot keep emitting edges from a model whose
// input vector was trained on leaked workstream closure.
export const FEATURE_SCHEMA_VERSION = 4;

export interface CandidatePairFeatures {
  schemaVersion: typeof FEATURE_SCHEMA_VERSION;
  same_workstream: 0 | 1;
  opener_chain_depth: number;
  in_navigation_chain: 0 | 1;
  same_canonical_url: 0 | 1;
  same_host: 0 | 1;
  same_repo: 0 | 1;
  same_search_query: 0 | 1;
  same_copied_snippet_count: number;
  shared_title_tokens: number;
  shared_path_tokens: number;
  cosine_similarity: number;
  recency_score_from: number;
  recency_score_to: number;
  engagement_class_match: 0 | 1;
  return_count_from: number;
  return_count_to: number;
  user_asserted_in_thread: 0 | 1;
  user_asserted_in_workstream: 0 | 1;
  // R5 expansion — appended (never reordered); existing keys above
  // keep their column index so older training datasets stay
  // comparable feature-by-feature.
  // Lineage-aware: from/to share an active topic (primary
  // affiliation), and from/to topics are merge/split lineage kin.
  same_active_topic: 0 | 1;
  topic_lineage_merge_split_related: 0 | 1;
  // Page-content quality tier (0 = unknown, 1 = low, 2 = medium,
  // 3 = high) of the from / to pages.
  page_quality_tier_from: number;
  page_quality_tier_to: number;
  shared_content_terms?: number;
  shared_content_keyphrases?: number;
  content_weighted_jaccard?: number;
  content_vector_cosine?: number;
  content_entity_overlap?: number;
  content_evidence_tier_from?: number;
  content_evidence_tier_to?: number;
  content_both_available?: 0 | 1;
  content_quality_pair_min?: number;
  chunk_support_count?: number;
  max_chunk_pair_score?: number;
}

export const CANDIDATE_PAIR_FEATURE_KEYS = [
  'schemaVersion',
  'same_workstream',
  'opener_chain_depth',
  'in_navigation_chain',
  'same_canonical_url',
  'same_host',
  'same_repo',
  'same_search_query',
  'same_copied_snippet_count',
  'shared_title_tokens',
  'shared_path_tokens',
  'cosine_similarity',
  'recency_score_from',
  'recency_score_to',
  'engagement_class_match',
  'return_count_from',
  'return_count_to',
  'user_asserted_in_thread',
  'user_asserted_in_workstream',
  'same_active_topic',
  'topic_lineage_merge_split_related',
  'page_quality_tier_from',
  'page_quality_tier_to',
  'shared_content_terms',
  'shared_content_keyphrases',
  'content_weighted_jaccard',
  'content_vector_cosine',
  'content_entity_overlap',
  'content_evidence_tier_from',
  'content_evidence_tier_to',
  'content_both_available',
  'content_quality_pair_min',
  'chunk_support_count',
  'max_chunk_pair_score',
] as const satisfies readonly (keyof CandidatePairFeatures)[];

export type ExtractFeatures = (
  candidate: Candidate,
  context: { merged: AcceptedEvent[]; snapshot: ConnectionsSnapshot },
) => CandidatePairFeatures;
