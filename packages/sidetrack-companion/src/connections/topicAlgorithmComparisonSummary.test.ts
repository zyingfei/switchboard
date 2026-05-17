import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildFocusEvalPack } from './focusEvalPack.js';
import { runTopicAlgorithmComparison } from './topicAlgorithmComparison.js';
import {
  readTopicAlgorithmComparisonSummary,
  shouldRunTopicAlgorithmComparison,
  summarizeTopicAlgorithmComparison,
  TOPIC_ALGORITHM_COMPARISON_VERSION,
  writeTopicAlgorithmComparisonSummary,
} from './topicAlgorithmComparisonSummary.js';

describe('summarizeTopicAlgorithmComparison', () => {
  it('summarizes the real benchmark sweep and picks a deterministic winner', async () => {
    const results = await runTopicAlgorithmComparison({ pack: buildFocusEvalPack() });
    const summary = summarizeTopicAlgorithmComparison(results);

    expect(summary.version).toBe(TOPIC_ALGORITHM_COMPARISON_VERSION);
    expect(summary.byCandidate.length).toBe(results.length);
    const candidates = summary.byCandidate.map((c) => c.candidate);
    expect(candidates).toContain(summary.winner);
    // Winner must have the maximal bCubedF1 (tie-break omega/accuracy).
    const maxF1 = Math.max(...summary.byCandidate.map((c) => c.bCubedF1));
    const winnerEntry = summary.byCandidate.find((c) => c.candidate === summary.winner);
    expect(winnerEntry?.bCubedF1).toBe(maxF1);
    // Deterministic: same inputs ⇒ same winner.
    const again = summarizeTopicAlgorithmComparison(
      await runTopicAlgorithmComparison({ pack: buildFocusEvalPack() }),
    );
    expect(again.winner).toBe(summary.winner);
  });
});

describe('topic-algorithm-comparison summary persistence', () => {
  let dir: string;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it('round-trips through the vault file and returns null when absent', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tac-'));
    expect(await readTopicAlgorithmComparisonSummary(dir)).toBeNull();
    const summary = summarizeTopicAlgorithmComparison(
      await runTopicAlgorithmComparison({ pack: buildFocusEvalPack() }),
    );
    await writeTopicAlgorithmComparisonSummary(dir, summary);
    const read = await readTopicAlgorithmComparisonSummary(dir);
    expect(read).toEqual(summary);
  });
});

describe('shouldRunTopicAlgorithmComparison', () => {
  const ENV = 'SIDETRACK_TOPIC_ALGORITHM_COMPARISON';
  afterEach(() => {
    delete process.env[ENV];
  });

  it('defaults ON and is disabled only by off/false/0/none', () => {
    delete process.env[ENV];
    expect(shouldRunTopicAlgorithmComparison()).toBe(true);
    for (const value of ['off', 'FALSE', '0', 'None']) {
      process.env[ENV] = value;
      expect(shouldRunTopicAlgorithmComparison()).toBe(false);
    }
    process.env[ENV] = 'on';
    expect(shouldRunTopicAlgorithmComparison()).toBe(true);
  });
});
