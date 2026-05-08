import type { ConnectionsSnapshot } from '../connections/types.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { Candidate } from './types.js';

export const FEATURE_SCHEMA_VERSION = 1;

export type CandidatePairFeatures = {
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
};

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
] as const satisfies readonly (keyof CandidatePairFeatures)[];

export type ExtractFeatures = (
  candidate: Candidate,
  context: { merged: AcceptedEvent[]; snapshot: ConnectionsSnapshot },
) => CandidatePairFeatures;
