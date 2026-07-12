import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot } from '../connections/types.js';
import { buildFeatureModel } from '../ranker/features.js';
import type { ActiveRankerHandle } from '../ranker/predict.js';
import { RANKER_FEATURE_KEYS } from '../ranker/train.js';
import type { RecallCandidate } from './types.js';
import {
  __resetLearnedRerankCacheForTests,
  applyLearnedRerank,
  recallLearnedRerankEnabled,
  reorderByLearnedScore,
} from './learnedRerank.js';

const EMPTY_SNAPSHOT: ConnectionsSnapshot = {
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: '2026-05-07T10:00:00.000Z',
  nodeCount: 0,
  edgeCount: 0,
};

const hit = (entityId: string, fusedScore: number): RecallCandidate => ({
  candidateId: `cand-${entityId}`,
  entityId,
  sourceKind: 'page_content',
  fusedScore,
  evidence: [],
});

// A logistic_batch handle that scores purely on rrf_score (= fusedScore).
// Higher fusedScore → higher score, so the learned order is fusedScore desc.
const rrfWeightedHandle = (): ActiveRankerHandle => {
  const weights = new Array(RANKER_FEATURE_KEYS.length + 1).fill(0) as number[];
  weights[RANKER_FEATURE_KEYS.indexOf('rrf_score') + 1] = 12;
  return {
    selection: {
      selectedKind: 'logistic_batch',
      selectedRevisionId: 'rev-test',
      reservedTestNdcgAt5: null,
      reason: 'best_passing',
      shipGateStatus: 'pass',
      shipGateReason: null,
    },
    revisionId: 'rev-test',
    logisticBatchWeights: weights,
    dispose: () => undefined,
  };
};

describe('recallLearnedRerankEnabled', () => {
  const prior = process.env['SIDETRACK_RECALL_LEARNED_RERANK'];
  afterEach(() => {
    if (prior === undefined) delete process.env['SIDETRACK_RECALL_LEARNED_RERANK'];
    else process.env['SIDETRACK_RECALL_LEARNED_RERANK'] = prior;
  });
  it('is off unless the flag is exactly "1"', () => {
    delete process.env['SIDETRACK_RECALL_LEARNED_RERANK'];
    expect(recallLearnedRerankEnabled()).toBe(false);
    process.env['SIDETRACK_RECALL_LEARNED_RERANK'] = '1';
    expect(recallLearnedRerankEnabled()).toBe(true);
  });
});

describe('reorderByLearnedScore', () => {
  it('re-orders by the learned score (rrf-weighted model flips a mis-ordered list)', () => {
    const model = buildFeatureModel([], EMPTY_SNAPSHOT);
    const handle = rrfWeightedHandle();
    // Input order is fusedScore ASCENDING (the "wrong" order); the learned
    // model should flip it to DESCENDING.
    const input = [hit('low', 0.1), hit('mid', 0.5), hit('high', 0.9)];
    const out = reorderByLearnedScore('anchor', input, new Map(), model, handle, 0);
    expect(out.map((c) => c.entityId)).toEqual(['high', 'mid', 'low']);
  });

  it('is a stable sort — equal scores keep the cross-encoder order', () => {
    const model = buildFeatureModel([], EMPTY_SNAPSHOT);
    const handle = rrfWeightedHandle();
    const input = [hit('a', 0.5), hit('b', 0.5), hit('c', 0.5)];
    const out = reorderByLearnedScore('anchor', input, new Map(), model, handle, 0);
    expect(out.map((c) => c.entityId)).toEqual(['a', 'b', 'c']);
  });
});

describe('applyLearnedRerank (no-op safety)', () => {
  let root = '';
  beforeEach(async () => {
    __resetLearnedRerankCacheForTests();
    root = await mkdtemp(join(tmpdir(), 'sidetrack-learned-rerank-'));
  });
  afterEach(async () => {
    __resetLearnedRerankCacheForTests();
    await rm(root, { recursive: true, force: true });
  });

  it('is a no-op for a single result', async () => {
    const input = [hit('only', 0.9)];
    const result = await applyLearnedRerank(
      { vaultRoot: root, loadContext: async () => null },
      'anchor',
      input,
      new Map(),
    );
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('too-few');
    expect(result.results).toBe(input);
  });

  it('serves the input order unchanged when no model is built (cold/absent gate)', async () => {
    const input = [hit('a', 0.1), hit('b', 0.9)];
    const result = await applyLearnedRerank(
      { vaultRoot: root, loadContext: async () => null },
      'anchor',
      input,
      new Map(),
    );
    // No active manifest in a fresh vault → never serveable → original order.
    expect(result.applied).toBe(false);
    expect(result.results.map((c) => c.entityId)).toEqual(['a', 'b']);
  });
});
