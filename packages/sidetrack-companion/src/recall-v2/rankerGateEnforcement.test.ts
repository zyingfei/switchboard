// Acceptance tests for the v6 ranker serving-gate ENFORCEMENT seam.
//
// Doctrine rule 10 — read back the served artifact: these drive a REAL
// ship-gate-passed impression-trained LightGBM revision through the actual
// `applyLearnedRerank` serving path (background model build + booster load +
// featurize + predict) and assert the SERVED order (what the pipeline slices
// into the response) responds to the enforcement flag:
//   - flag OFF (default): v6 is EVALUATED (v6Order populated) but NOT served.
//   - flag ON  + gate PASS: served order becomes the v6 order.
//   - gate FAIL (flag ON): automatic fallback to the served order.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeActiveClosestVisitRankerRevision } from '../producers/closest-visit-revision.js';
import { FEATURE_SCHEMA_VERSION, type CandidatePairFeatures } from '../ranker/feature-schema.js';
import {
  RANKER_MODEL_VERSION,
  trainRankerRevision,
  type RankerArtifactQuality,
  type RankerRevision,
  type RankerTrainingCandidate,
} from '../ranker/train.js';
import type { FeedbackProjection, FeedbackTrainingLabel } from '../feedback/projection.js';
import {
  __resetLearnedRerankCacheForTests,
  applyLearnedRerank,
  type LearnedRerankContext,
  type LearnedRerankResult,
} from './learnedRerank.js';
import type { RecallCandidate } from './types.js';

const generatedAt = Date.parse('2026-07-24T12:00:00.000Z');
const V2_GATE_REASON = 'ship_gate_v2:active-beats-baseline';

// The ONLY feature that both (a) varies with the label in training AND (b)
// is present per-candidate at serve time (threaded from fusedScore through
// retrievalContext) is `rrf_score`. All graph/embedding features are
// zero-filled at serve because the FeatureModel is built over an empty
// snapshot — so hold them CONSTANT in training too, forcing LightGBM to
// split on rrf_score. That makes the learned order track fusedScore, which
// is what lets the enforcement test observe a real reorder at serve.
const featuresFor = (rrfScore: number): CandidatePairFeatures => ({
  schemaVersion: FEATURE_SCHEMA_VERSION,
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
  max_chunk_pair_vector_cosine: 0,
  top3_mean_chunk_pair_vector_cosine: 0,
  chunk_pair_vector_support_count: 0,
  bm25_score: 0,
  bm25_rank: 0,
  dense_doc_score: 0,
  dense_doc_rank: 0,
  rrf_score: rrfScore,
  rrf_rank: 0,
  graph_similarity_rank: 0,
  candidate_source_flags: 0,
  served_position: 0,
});

const syntheticTrainingSet = (): {
  readonly feedback: FeedbackProjection;
  readonly candidates: readonly RankerTrainingCandidate[];
} => {
  const positiveLabels: FeedbackTrainingLabel[] = [];
  const negativeLabels: FeedbackTrainingLabel[] = [];
  const candidates: RankerTrainingCandidate[] = [];
  for (let query = 0; query < 10; query += 1) {
    const fromVisitId = `visit-${String(query)}`;
    for (let item = 0; item < 10; item += 1) {
      const toVisitId = `visit-${String(query)}-${String(item)}`;
      const positive = item >= 7;
      if (positive) positiveLabels.push({ fromId: fromVisitId, toId: toVisitId, weight: 2 });
      else negativeLabels.push({ fromId: fromVisitId, toId: toVisitId, weight: 1 });
      candidates.push({
        candidate: {
          fromVisitId,
          toVisitId,
          generatedAt: generatedAt + query,
          sources: positive ? ['user_confirmed'] : ['random_unrelated'],
        },
        // Positives get a high rrf_score, negatives a low one — the model
        // must learn "higher rrf_score → more relevant".
        features: featuresFor(positive ? 0.7 + item / 100 : item / 100),
      });
    }
  }
  return {
    feedback: {
      schemaVersion: 1,
      perItem: {},
      containerByItem: {},
      organizedItemsByContainer: {},
      positiveLabels,
      negativeLabels,
    },
    candidates,
  };
};

const lightgbmArtifact = (status: 'pass' | 'fail'): RankerArtifactQuality => ({
  kind: 'lightgbm_lambdamart',
  candidate: RANKER_MODEL_VERSION,
  reservedTestMetric: { kind: 'ndcg@5', value: 0.42 },
  shipGate: {
    status,
    // The reason MUST start with `ship_gate_v2:` — that prefix is how the
    // selector recognises the impression-trained v6 gate (select.ts).
    reason: status === 'pass' ? V2_GATE_REASON : 'ship_gate_v2:active-does-not-beat-baseline',
  },
});

/** Train a real v6 revision and stamp it active with an impression-trained,
 *  `ship_gate_v2:` lightgbm artifact at the requested pass/fail status. */
const seedRevision = async (
  root: string,
  gate: 'pass' | 'fail',
): Promise<RankerRevision> => {
  const input = syntheticTrainingSet();
  const trained = await trainRankerRevision({
    ...input,
    options: { seed: 17, numRound: 40, trainedAt: generatedAt },
  });
  const revision: RankerRevision = {
    ...trained,
    trainedFromImpressions: true,
    artifactQuality: [lightgbmArtifact(gate)],
  };
  await writeActiveClosestVisitRankerRevision(root, revision);
  return revision;
};

const hit = (entityId: string, fusedScore: number): RecallCandidate => ({
  candidateId: `cand-${entityId}`,
  entityId,
  canonicalUrl: `https://example.test/${entityId}`,
  sourceKind: 'page_content',
  fusedScore,
  evidence: [],
});

// Empty context: the FeatureModel is built over no snapshot/merged, so the
// differentiating signal is the per-candidate retrieval context (rrf_score =
// fusedScore). Deterministic + fast — no full-log read.
const emptyContext = async (): Promise<LearnedRerankContext> => ({
  snapshot: {
    scope: {},
    nodes: [],
    edges: [],
    updatedAt: '2026-07-24T12:00:00.000Z',
    nodeCount: 0,
    edgeCount: 0,
  },
  merged: [],
});

// Drive applyLearnedRerank until the background refresh warms the model (it
// fires void refresh() and returns 'cold'/'building' on the first calls).
const applyUntilWarm = async (
  root: string,
  results: readonly RecallCandidate[],
): Promise<LearnedRerankResult> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const out = await applyLearnedRerank(
      { vaultRoot: root, loadContext: emptyContext },
      'anchor',
      results,
      new Map(),
    );
    if (out.reason !== 'cold' && out.reason !== 'building') return out;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('learned-rerank model never warmed');
};

describe('v6 serving-gate enforcement', () => {
  let root = '';
  const priorServeV6 = process.env['SIDETRACK_RANKER_SERVE_V6'];
  const priorLegacy = process.env['SIDETRACK_RECALL_LEARNED_RERANK'];

  beforeEach(async () => {
    __resetLearnedRerankCacheForTests();
    root = await mkdtemp(join(tmpdir(), 'sidetrack-gate-enforce-'));
    delete process.env['SIDETRACK_RANKER_SERVE_V6'];
    delete process.env['SIDETRACK_RECALL_LEARNED_RERANK'];
  });
  afterEach(async () => {
    __resetLearnedRerankCacheForTests();
    await rm(root, { recursive: true, force: true });
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('SIDETRACK_RANKER_SERVE_V6', priorServeV6);
    restore('SIDETRACK_RECALL_LEARNED_RERANK', priorLegacy);
  });

  // Input order is fusedScore ASCENDING (the "wrong" order the cross-encoder
  // produced); the trained model rewards rrf_score, so its v6 order is
  // fusedScore DESCENDING.
  const misorderedInput = (): readonly RecallCandidate[] => [
    hit('low', 0.1),
    hit('mid', 0.5),
    hit('high', 0.9),
  ];

  it('flag OFF (default): evaluates the v6 order but does NOT serve it', async () => {
    await seedRevision(root, 'pass');
    const input = misorderedInput();
    const out = await applyUntilWarm(root, input);

    expect(out.applied).toBe(false);
    expect(out.reason).toBe('disabled');
    // Served order is unchanged (the cross-encoder order the caller passed).
    expect(out.results.map((c) => c.entityId)).toEqual(['low', 'mid', 'high']);
    // …but the v6 order was still computed for read-only shadow-diff, and it
    // reorders the candidates (differs from the served/input order — the
    // load-bearing claim is that v6 is EVALUATED here, not the exact
    // permutation, which is a LightGBM leaf-boundary detail).
    expect(out.v6Order).not.toBeNull();
    expect(out.v6Order).toHaveLength(3);
    expect(out.v6Order).not.toEqual(out.results.map((c) => c.entityId));
  });

  it('flag ON + gate PASS: the served order becomes the v6 order', async () => {
    process.env['SIDETRACK_RANKER_SERVE_V6'] = '1';
    await seedRevision(root, 'pass');
    const input = misorderedInput();
    const out = await applyUntilWarm(root, input);

    expect(out.applied).toBe(true);
    expect(out.reason).toBe('applied');
    // The load-bearing claim: the SERVED order is now exactly the v6 order,
    // and it differs from the input/cross-encoder order (a real reorder).
    const servedOrder = out.results.map((c) => c.entityId);
    expect(servedOrder).toEqual(out.v6Order);
    expect(servedOrder).not.toEqual(['low', 'mid', 'high']);
  });

  it('legacy alias SIDETRACK_RECALL_LEARNED_RERANK=1 also enforces', async () => {
    process.env['SIDETRACK_RECALL_LEARNED_RERANK'] = '1';
    await seedRevision(root, 'pass');
    const out = await applyUntilWarm(root, misorderedInput());
    expect(out.applied).toBe(true);
    const servedOrder = out.results.map((c) => c.entityId);
    expect(servedOrder).toEqual(out.v6Order);
    expect(servedOrder).not.toEqual(['low', 'mid', 'high']);
  });

  it('gate FAIL (flag ON): automatic fallback — served order unchanged, v6 not evaluated', async () => {
    process.env['SIDETRACK_RANKER_SERVE_V6'] = '1';
    await seedRevision(root, 'fail');
    const input = misorderedInput();
    const out = await applyUntilWarm(root, input);

    expect(out.applied).toBe(false);
    expect(out.reason).toBe('not-serveable');
    expect(out.v6Order).toBeNull();
    // Fallback: the served (cross-encoder) order is preserved.
    expect(out.results.map((c) => c.entityId)).toEqual(['low', 'mid', 'high']);
  });
});
