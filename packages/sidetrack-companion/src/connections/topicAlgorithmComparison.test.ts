import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTopicRevisionStore } from '../producers/topic-revision.js';
import { buildFocusEvalPack, buildLargeCoherentFocusFixture } from './focusEvalPack.js';
import {
  runTopicAlgorithmComparison,
  writeTopicAlgorithmComparisonShadows,
} from './topicAlgorithmComparison.js';

describe('topic algorithm comparison', () => {
  it('builds the 220-pair stratified Focus eval pack', () => {
    const pack = buildFocusEvalPack();
    expect(pack.labels).toHaveLength(220);
    expect(pack.labels.filter((label) => label.label === 'same-topic')).toHaveLength(80);
    expect(pack.labels.filter((label) => label.label === 'different-topic')).toHaveLength(100);
    expect(pack.labels.filter((label) => label.label === 'ambiguous')).toHaveLength(40);
    expect(pack.trueClusterByVisit.size).toBe(pack.visits.length);
  });

  it('compares sparse UF, Leiden variants, and BERTopic-shaped density output on the same graph', async () => {
    const pack = buildFocusEvalPack();
    const results = await runTopicAlgorithmComparison({ pack });
    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-topic-comparison-'));
    const store = createTopicRevisionStore(vaultRoot);
    await writeTopicAlgorithmComparisonShadows(store, results);

    expect(results.map((result) => result.candidate)).toEqual([
      'sparse-uf',
      'leiden-modularity',
      'leiden-cpm',
      'bertopic-shaped',
    ]);
    for (const result of results) {
      expect(result.metrics.topicCount).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(result.metrics.labeledPairAccuracy)).toBe(true);
      expect(Number.isFinite(result.metrics.bCubedF1)).toBe(true);
      expect(result.revision.topics.every((topic) => topic.metadata.stableSuggestionId)).toBe(true);
      await expect(store.readCandidateShadowRevision(result.candidate)).resolves.toMatchObject({
        revisionId: result.revision.revisionId,
      });
    }
    expect(
      Math.max(
        ...results
          .filter((result) => result.candidate !== 'sparse-uf')
          .map((result) => result.metrics.labeledPairAccuracy),
      ),
    ).toBeGreaterThan(0.7);
  });

  it('keeps a legitimate large coherent research topic intact in the guard fixture', async () => {
    const pack = buildLargeCoherentFocusFixture();
    const results = await runTopicAlgorithmComparison({ pack });

    expect(
      Math.max(...results.map((result) => result.metrics.maxTopicSize)),
    ).toBeGreaterThanOrEqual(60);
    expect(results.some((result) => result.metrics.maxTopicSize < 60)).toBe(true);
  });
});
