import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTopicRevisionStore, parseTopicRevision } from '../producers/topic-revision.js';
import { buildFocusEvalPack } from './focusEvalPack.js';
import { louvainCommunityPartition } from './graphCommunityClusterer.js';
import {
  runTopicAlgorithmComparison,
  writeTopicAlgorithmComparisonShadows,
} from './topicAlgorithmComparison.js';
import type { VisitSimilarityEdge } from './topicClusterer.js';

const node = (suffix: string): string => `https://example.test/${suffix}`;

const edge = (fromVisitKey: string, toVisitKey: string, cosine: number): VisitSimilarityEdge => ({
  fromVisitKey,
  toVisitKey,
  cosine,
});

const cliqueEdges = (members: readonly string[], cosine: number): readonly VisitSimilarityEdge[] =>
  members.flatMap((from, index) => members.slice(index + 1).map((to) => edge(from, to, cosine)));

describe('louvainCommunityPartition', () => {
  it('splits two dense cliques bridged by one weak edge into two communities', () => {
    const clusterA = [node('a-1'), node('a-2'), node('a-3'), node('a-4')];
    const clusterB = [node('b-1'), node('b-2'), node('b-3'), node('b-4')];
    const nodeIds = [...clusterA, ...clusterB];
    const edges = [
      ...cliqueEdges(clusterA, 0.96),
      ...cliqueEdges(clusterB, 0.95),
      // Single weak bridge — Louvain modularity must not merge the
      // two cliques across it.
      edge(clusterA[0]!, clusterB[0]!, 0.2),
    ];

    const groups = louvainCommunityPartition(nodeIds, edges);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => [...group].sort())).toEqual([
      [...clusterA].sort(),
      [...clusterB].sort(),
    ]);
  });

  it('is deterministic: identical input yields byte-identical partitions and stable ids', () => {
    const clusterA = [node('x-1'), node('x-2'), node('x-3')];
    const clusterB = [node('y-1'), node('y-2'), node('y-3')];
    const clusterC = [node('z-1'), node('z-2'), node('z-3')];
    const nodeIds = [...clusterC, ...clusterA, ...clusterB];
    const edges = [
      ...cliqueEdges(clusterA, 0.94),
      ...cliqueEdges(clusterB, 0.93),
      ...cliqueEdges(clusterC, 0.92),
      edge(clusterA[0]!, clusterB[0]!, 0.15),
      edge(clusterB[1]!, clusterC[1]!, 0.18),
    ];

    const first = louvainCommunityPartition(nodeIds, edges);
    const second = louvainCommunityPartition([...nodeIds].reverse(), [...edges].reverse());

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // Community identity is its smallest member, so ids are stable
    // regardless of input ordering.
    expect(first.map((group) => group[0])).toEqual([
      [...clusterA].sort()[0],
      [...clusterB].sort()[0],
      [...clusterC].sort()[0],
    ]);
  });

  it('ignores self-loops, non-finite, and non-positive edges without throwing', () => {
    const members = [node('s-1'), node('s-2'), node('s-3')];
    const edges = [
      ...cliqueEdges(members, 0.9),
      edge(members[0]!, members[0]!, 0.99),
      edge(members[1]!, members[2]!, Number.NaN),
      edge(members[0]!, members[2]!, 0),
      edge(members[0]!, members[2]!, -0.4),
    ];

    const groups = louvainCommunityPartition(members, edges);

    expect(groups).toHaveLength(1);
    expect([...groups[0]!].sort()).toEqual([...members].sort());
  });

  it('returns an empty partition for an empty node set', () => {
    expect(louvainCommunityPartition([], [])).toEqual([]);
  });
});

describe('louvain-community comparison candidate', () => {
  it('is measured against the idf-rkn-split baseline and emits a conforming shadow revision', async () => {
    const pack = buildFocusEvalPack();
    const results = await runTopicAlgorithmComparison({ pack });
    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-louvain-community-'));
    const store = createTopicRevisionStore(vaultRoot);
    await writeTopicAlgorithmComparisonShadows(store, results);

    const louvain = results.find((result) => result.candidate === 'louvain-community');
    const baseline = results.find((result) => result.candidate === 'sparse-uf');
    expect(louvain).toBeDefined();
    expect(baseline).toBeDefined();
    if (louvain === undefined || baseline === undefined) return;

    // It is a *measured candidate* — never the active/served path —
    // and it produces real metrics next to the baseline.
    expect(louvain.metrics.topicCount).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(louvain.metrics.bCubedF1)).toBe(true);
    expect(Number.isFinite(louvain.metrics.labeledPairAccuracy)).toBe(true);
    expect(louvain.metrics.assignedVisitCount).toBeGreaterThanOrEqual(1);

    // Output conforms to the TopicRevision contract (round-trips
    // through the canonical parser) and persists as a candidate
    // shadow without disturbing the active revision.
    expect(parseTopicRevision(louvain.revision)).not.toBeNull();
    expect(louvain.revision.topics.every((topic) => topic.metadata.stableSuggestionId)).toBe(true);
    await expect(store.readCandidateShadowRevision('louvain-community')).resolves.toMatchObject({
      revisionId: louvain.revision.revisionId,
    });
    await expect(store.readActiveRevision()).resolves.toBeNull();
  });

  it('produces a byte-identical candidate revision across repeated harness runs', async () => {
    const pack = buildFocusEvalPack();
    const [first] = await runTopicAlgorithmComparison({
      pack,
      candidates: ['louvain-community'],
    });
    const [second] = await runTopicAlgorithmComparison({
      pack,
      candidates: ['louvain-community'],
    });

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(JSON.stringify(first?.revision)).toBe(JSON.stringify(second?.revision));
  });
});
