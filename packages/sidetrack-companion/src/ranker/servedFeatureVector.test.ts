// Move 1 — served-feature-vector encode/decode contract.

import { describe, expect, it } from 'vitest';

import {
  CANDIDATE_PAIR_FEATURE_KEYS,
  FEATURE_SCHEMA_VERSION,
  type CandidatePairFeatures,
} from './feature-schema.js';
import { decodeServedFeatureVector, encodeServedFeatureVector } from './servedFeatureVector.js';

const sampleFeatures = (): CandidatePairFeatures => ({
  schemaVersion: FEATURE_SCHEMA_VERSION,
  same_workstream: 1,
  opener_chain_depth: 2,
  in_navigation_chain: 0,
  same_canonical_url: 0,
  same_host: 1,
  same_repo: 0,
  same_search_query: 0,
  same_copied_snippet_count: 0,
  shared_title_tokens: 3,
  shared_path_tokens: 1,
  cosine_similarity: 0.42,
  recency_score_from: 0.9,
  recency_score_to: 0.8,
  engagement_class_match: 1,
  return_count_from: 2,
  return_count_to: 1,
  user_asserted_in_thread: 0,
  user_asserted_in_workstream: 0,
  same_active_topic: 1,
  topic_lineage_merge_split_related: 0,
  page_quality_tier_from: 3,
  page_quality_tier_to: 2,
  max_chunk_pair_vector_cosine: 0,
  top3_mean_chunk_pair_vector_cosine: 0,
  chunk_pair_vector_support_count: 0,
  bm25_score: 1.5,
  bm25_rank: 1,
  dense_doc_score: 0.7,
  dense_doc_rank: 2,
  rrf_score: 0.03,
  rrf_rank: 1,
  graph_similarity_rank: 0,
  candidate_source_flags: 9,
  served_position: 1,
});

describe('served feature vector encode/decode', () => {
  it('encodes to a dense array aligned to CANDIDATE_PAIR_FEATURE_KEYS', () => {
    const vector = encodeServedFeatureVector(sampleFeatures());
    expect(vector).toHaveLength(CANDIDATE_PAIR_FEATURE_KEYS.length);
    // schemaVersion is column 0 by the canonical key order.
    expect(vector[0]).toBe(FEATURE_SCHEMA_VERSION);
  });

  it('round-trips every canonical key value', () => {
    const features = sampleFeatures();
    const decoded = decodeServedFeatureVector(encodeServedFeatureVector(features));
    expect(decoded).not.toBeNull();
    if (decoded === null) return;
    for (const key of CANDIDATE_PAIR_FEATURE_KEYS) {
      expect(decoded[key] ?? 0).toBe(features[key] ?? 0);
    }
  });

  it('encodes missing/undefined optional features as 0', () => {
    const features = sampleFeatures();
    // shared_content_terms is optional and omitted above.
    const vector = encodeServedFeatureVector(features);
    const idx = CANDIDATE_PAIR_FEATURE_KEYS.indexOf('shared_content_terms');
    expect(vector[idx]).toBe(0);
  });

  it('returns null on a length mismatch so callers fall back instead of misaligning', () => {
    expect(decodeServedFeatureVector([1, 2, 3])).toBeNull();
    expect(decodeServedFeatureVector([])).toBeNull();
  });
});
