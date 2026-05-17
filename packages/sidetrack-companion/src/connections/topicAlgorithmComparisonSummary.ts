// U3 — surface the topic.algorithm-comparison sweep.
//
// runTopicAlgorithmComparison scores 5 clustering algorithms against
// the SYNTHETIC FocusEvalPack benchmark (buildFocusEvalPack — a fixed
// 60-visit labelled fixture, NOT the user's vault). It is therefore a
// deterministic, input-invariant methodology benchmark: the same
// inputs every run ⇒ the same result. So the CPU-safe "throttle" is
// compute-ONCE, version-gated — run the sweep a single time per
// version, persist the summary, and thereafter every drain just
// reuses the persisted JSON (a tiny read; the 5-algorithm cost never
// repeats). Bump TOPIC_ALGORITHM_COMPARISON_VERSION when the
// algorithms or the eval pack change to force a one-time recompute.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TopicAlgorithmComparisonResult } from './topicAlgorithmComparison.js';

export const TOPIC_ALGORITHM_COMPARISON_VERSION = 'v1';

export interface TopicAlgorithmComparisonCandidateSummary {
  readonly candidate: string;
  readonly bCubedF1: number;
  readonly omegaIndex: number;
  readonly labeledPairAccuracy: number;
  readonly perVisitChurn: number;
  readonly topicCount: number;
  readonly maxTopicSize: number;
  readonly assignedVisitCount: number;
  readonly noiseCount: number;
}

export interface TopicAlgorithmComparisonSummary {
  readonly version: string;
  readonly producedAtMs: number;
  readonly winner: string;
  readonly byCandidate: readonly TopicAlgorithmComparisonCandidateSummary[];
}

// Winner = best clustering quality on the benchmark: max bCubedF1,
// tie-broken by omegaIndex then labeledPairAccuracy. Deterministic.
export const summarizeTopicAlgorithmComparison = (
  results: readonly TopicAlgorithmComparisonResult[],
): TopicAlgorithmComparisonSummary => {
  const byCandidate: TopicAlgorithmComparisonCandidateSummary[] = results.map((result) => ({
    candidate: result.candidate,
    bCubedF1: result.metrics.bCubedF1,
    omegaIndex: result.metrics.omegaIndex,
    labeledPairAccuracy: result.metrics.labeledPairAccuracy,
    perVisitChurn: result.metrics.perVisitChurn,
    topicCount: result.metrics.topicCount,
    maxTopicSize: result.metrics.maxTopicSize,
    assignedVisitCount: result.metrics.assignedVisitCount,
    noiseCount: result.metrics.noiseCount,
  }));
  const ranked = [...byCandidate].sort(
    (a, b) =>
      b.bCubedF1 - a.bCubedF1 ||
      b.omegaIndex - a.omegaIndex ||
      b.labeledPairAccuracy - a.labeledPairAccuracy,
  );
  return {
    version: TOPIC_ALGORITHM_COMPARISON_VERSION,
    producedAtMs: Date.now(),
    winner: ranked[0]?.candidate ?? 'none',
    byCandidate,
  };
};

const summaryPath = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'connections', 'topics', 'algorithm-comparison.json');

export const readTopicAlgorithmComparisonSummary = async (
  vaultRoot: string,
): Promise<TopicAlgorithmComparisonSummary | null> => {
  try {
    return JSON.parse(
      await readFile(summaryPath(vaultRoot), 'utf8'),
    ) as TopicAlgorithmComparisonSummary;
  } catch {
    return null;
  }
};

export const writeTopicAlgorithmComparisonSummary = async (
  vaultRoot: string,
  summary: TopicAlgorithmComparisonSummary,
): Promise<void> => {
  const path = summaryPath(vaultRoot);
  await mkdir(join(path, '..'), { recursive: true });
  const tmp = `${path}.${String(Date.now())}.tmp`;
  await writeFile(tmp, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
};

// Default ON. Disable with SIDETRACK_TOPIC_ALGORITHM_COMPARISON in
// {off,false,0,none} (case-insensitive), mirroring the other
// candidate gates.
const DISABLED_VALUES = new Set(['off', 'false', '0', 'none']);

export const shouldRunTopicAlgorithmComparison = (): boolean => {
  const raw = process.env['SIDETRACK_TOPIC_ALGORITHM_COMPARISON'];
  if (raw === undefined) return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
};
