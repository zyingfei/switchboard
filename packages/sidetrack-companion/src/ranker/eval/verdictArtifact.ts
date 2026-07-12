// Wave 0 — freeze-safe eval spine (report-only).
//
// Persist the replay-eval verdict (arm metrics + paired-bootstrap
// significance) as a JSON artifact under the vault diagnostics dir. This
// is the EVIDENCE the P1 freeze lifts on: a durable, timestamped record of
// how the trained model compares to the graph baseline and the honest
// external floors, WITH an uncertainty estimate.
//
// REPORT-ONLY: nothing reads this to gate promotion. shipGateV2 keeps its
// own point-estimate decision; wiring this verdict into promotion is a
// later wave (see significance.ts SIGNIFICANCE_GATE_SEAM).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ImpressionMetrics } from '../shipGateV2.js';
import type { ReplayArmId, ReplayReport } from './replayHarness.js';
import { pairedBootstrap, type PairedBootstrapResult } from './significance.js';

export const REPLAY_EVAL_VERDICT_SCHEMA_VERSION = 1;

const REPLAY_EVAL_RELATIVE_DIR = '_BAC/eval';
const REPLAY_EVAL_LATEST_FILENAME = 'replay-verdict.latest.json';

export const replayEvalVerdictDir = (vaultRoot: string): string =>
  join(vaultRoot, REPLAY_EVAL_RELATIVE_DIR);

export const replayEvalVerdictPath = (vaultRoot: string): string =>
  join(replayEvalVerdictDir(vaultRoot), REPLAY_EVAL_LATEST_FILENAME);

export interface ReplayArmVerdict {
  readonly id: ReplayArmId;
  readonly label: string;
  readonly available: boolean;
  readonly metrics: ImpressionMetrics;
}

export interface SignificanceComparison {
  readonly armA: ReplayArmId;
  readonly armB: ReplayArmId;
  readonly bootstrap: PairedBootstrapResult;
}

export interface ReplayEvalVerdict {
  readonly schemaVersion: typeof REPLAY_EVAL_VERDICT_SCHEMA_VERSION;
  readonly generatedAt: number;
  readonly impressionCount: number;
  readonly impressionsWithPositiveCount: number;
  readonly arms: readonly ReplayArmVerdict[];
  /** Paired-bootstrap comparisons of the trained model against each
   *  reference arm (baseline + external floors). REPORT-ONLY. */
  readonly comparisons: readonly SignificanceComparison[];
  /** Documented: this verdict does not gate promotion yet. */
  readonly reportOnly: true;
}

/** Reference arms the trained model is compared against, in priority order.
 *  The trained model must beat these to earn the freeze lift. */
const COMPARISON_REFERENCE_ARMS: readonly ReplayArmId[] = [
  'graph_baseline',
  'grep_bm25',
  'recency',
  'served_order',
];

export interface BuildVerdictOptions {
  readonly generatedAt?: number;
  readonly bootstrapIterations?: number;
  readonly bootstrapSeed?: number;
  readonly confidence?: number;
}

/**
 * Build the verdict object from a replay report: echo each arm's metrics
 * and run the paired-bootstrap of `trained_model` vs every reference arm.
 * When no trained model is present, `comparisons` is empty (nothing to
 * compare) but the arm metrics still persist as the floor record.
 */
export const buildReplayEvalVerdict = (
  report: ReplayReport,
  options: BuildVerdictOptions = {},
): ReplayEvalVerdict => {
  const arms: ReplayArmVerdict[] = report.arms.map((arm) => ({
    id: arm.id,
    label: arm.label,
    available: arm.available,
    metrics: arm.metrics,
  }));

  const trained = report.arms.find((arm) => arm.id === 'trained_model');
  const comparisons: SignificanceComparison[] = [];
  if (trained !== undefined && trained.available) {
    for (const referenceId of COMPARISON_REFERENCE_ARMS) {
      const reference = report.arms.find((arm) => arm.id === referenceId);
      if (reference === undefined) continue;
      comparisons.push({
        armA: 'trained_model',
        armB: referenceId,
        bootstrap: pairedBootstrap({
          armA: trained.perGroupNdcgAt10,
          armB: reference.perGroupNdcgAt10,
          ...(options.bootstrapIterations === undefined
            ? {}
            : { iterations: options.bootstrapIterations }),
          ...(options.bootstrapSeed === undefined ? {} : { seed: options.bootstrapSeed }),
          ...(options.confidence === undefined ? {} : { confidence: options.confidence }),
        }),
      });
    }
  }

  return {
    schemaVersion: REPLAY_EVAL_VERDICT_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? Date.now(),
    impressionCount: report.impressionCount,
    impressionsWithPositiveCount: report.impressionsWithPositiveCount,
    arms,
    comparisons,
    reportOnly: true,
  };
};

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

export const writeReplayEvalVerdict = async (
  vaultRoot: string,
  verdict: ReplayEvalVerdict,
): Promise<void> => {
  await writeAtomic(replayEvalVerdictPath(vaultRoot), `${JSON.stringify(verdict, null, 2)}\n`);
};

export const readReplayEvalVerdict = async (
  vaultRoot: string,
): Promise<ReplayEvalVerdict | null> => {
  try {
    const parsed = JSON.parse(await readFile(replayEvalVerdictPath(vaultRoot), 'utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { schemaVersion?: unknown }).schemaVersion === REPLAY_EVAL_VERDICT_SCHEMA_VERSION
    ) {
      return parsed as ReplayEvalVerdict;
    }
    return null;
  } catch {
    return null;
  }
};

/** Format the significance comparisons for CLI output. */
export const formatVerdict = (verdict: ReplayEvalVerdict): string => {
  if (verdict.comparisons.length === 0) {
    return 'significance: no trained model present — floor metrics recorded, no comparison run.';
  }
  return verdict.comparisons
    .map((comparison) => {
      const b = comparison.bootstrap;
      return (
        `${comparison.armA} vs ${comparison.armB}: ` +
        `Δmean nDCG@10=${b.observedMeanDelta.toFixed(4)} ` +
        `CI[${b.ciLow.toFixed(4)}, ${b.ciHigh.toFixed(4)}] ` +
        `p=${b.pValue.toFixed(4)} → ${b.verdict} (n=${String(b.pairedCount)})`
      );
    })
    .join('\n');
};
