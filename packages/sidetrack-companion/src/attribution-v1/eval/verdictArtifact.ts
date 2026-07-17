// Attribution v1 — prequential verdict artifact (report-only, diagnostics).
//
// Persist the prequential replay's per-arm metrics + the frozen-baseline
// verdict as a durable JSON record under the vault's eval diagnostics dir,
// mirroring ranker/eval/verdictArtifact.ts. REPORT-ONLY: nothing reads this to
// gate serving or promotion — it is the evidence the north-star's §2
// "beat the 46% vote on asserted-edge replay" gate is judged on.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  ArmMetrics,
  PrequentialReport,
  PrequentialVerdict,
} from './prequential.js';

export const ATTRIBUTION_PREQUENTIAL_VERDICT_SCHEMA_VERSION = 1;

const ATTRIBUTION_EVAL_RELATIVE_DIR = '_BAC/eval';
const ATTRIBUTION_PREQUENTIAL_LATEST_FILENAME = 'attribution-prequential.latest.json';

export const attributionPrequentialVerdictDir = (vaultRoot: string): string =>
  join(vaultRoot, ATTRIBUTION_EVAL_RELATIVE_DIR);

export const attributionPrequentialVerdictPath = (vaultRoot: string): string =>
  join(attributionPrequentialVerdictDir(vaultRoot), ATTRIBUTION_PREQUENTIAL_LATEST_FILENAME);

export interface AttributionPrequentialArtifact {
  readonly schemaVersion: typeof ATTRIBUTION_PREQUENTIAL_VERDICT_SCHEMA_VERSION;
  readonly generatedAt: number;
  readonly labelCount: number;
  readonly distinctWorkstreamCount: number;
  readonly headWorkstreamCount: number;
  readonly tailWorkstreamCount: number;
  readonly headLabelCount: number;
  readonly tailLabelCount: number;
  readonly arms: readonly ArmMetrics[];
  readonly verdict: PrequentialVerdict;
  readonly reportOnly: true;
}

export interface BuildArtifactOptions {
  readonly generatedAt?: number;
}

export const buildAttributionPrequentialArtifact = (
  report: PrequentialReport,
  verdict: PrequentialVerdict,
  options: BuildArtifactOptions = {},
): AttributionPrequentialArtifact => ({
  schemaVersion: ATTRIBUTION_PREQUENTIAL_VERDICT_SCHEMA_VERSION,
  generatedAt: options.generatedAt ?? Date.now(),
  labelCount: report.labelCount,
  distinctWorkstreamCount: report.distinctWorkstreamCount,
  headWorkstreamCount: report.headWorkstreamCount,
  tailWorkstreamCount: report.tailWorkstreamCount,
  headLabelCount: report.headLabelCount,
  tailLabelCount: report.tailLabelCount,
  arms: report.arms,
  verdict,
  reportOnly: true,
});

const writeAtomic = async (path: string, body: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
};

export const writeAttributionPrequentialArtifact = async (
  vaultRoot: string,
  artifact: AttributionPrequentialArtifact,
): Promise<void> => {
  await writeAtomic(
    attributionPrequentialVerdictPath(vaultRoot),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
};

export const readAttributionPrequentialArtifact = async (
  vaultRoot: string,
): Promise<AttributionPrequentialArtifact | null> => {
  try {
    const parsed = JSON.parse(
      await readFile(attributionPrequentialVerdictPath(vaultRoot), 'utf8'),
    ) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { schemaVersion?: unknown }).schemaVersion ===
        ATTRIBUTION_PREQUENTIAL_VERDICT_SCHEMA_VERSION
    ) {
      return parsed as AttributionPrequentialArtifact;
    }
    return null;
  } catch {
    return null;
  }
};

// ---- CLI formatting ---------------------------------------------------

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

const ARM_LABELS: Record<string, string> = {
  v1: 'v1 (three-family)',
  'title-lexical': 'title-lexical alone',
  recency: 'recency alone',
  vote4: '4-signal vote (baseline)',
  majority: 'majority-class',
};

// Fixed-width table so the CLI output lines up. Columns match the study's
// reporting: arm, top-1, top-3, head, tail, abstain, precision-when-suggesting.
export const formatPrequentialReport = (
  artifact: AttributionPrequentialArtifact,
): string => {
  const header = [
    `Attribution v1 — prequential replay (asserted edges only, time-ordered, no peeking)`,
    `labels=${String(artifact.labelCount)} · workstreams=${String(artifact.distinctWorkstreamCount)} ` +
      `(head=${String(artifact.headWorkstreamCount)}/${String(artifact.headLabelCount)} labels, ` +
      `tail=${String(artifact.tailWorkstreamCount)}/${String(artifact.tailLabelCount)} labels)`,
    '',
  ];
  const col = (s: string, w: number): string => s.padEnd(w);
  const num = (s: string, w: number): string => s.padStart(w);
  const rows: string[] = [];
  rows.push(
    col('arm', 26) +
      num('top1', 8) +
      num('top3', 8) +
      num('head', 8) +
      num('tail', 8) +
      num('abstain', 10) +
      num('prec@sug', 10),
  );
  rows.push('-'.repeat(78));
  for (const arm of artifact.arms) {
    rows.push(
      col(ARM_LABELS[arm.arm] ?? arm.arm, 26) +
        num(pct(arm.top1), 8) +
        num(pct(arm.top3), 8) +
        num(pct(arm.head), 8) +
        num(pct(arm.tail), 8) +
        num(pct(arm.abstainRate), 10) +
        num(pct(arm.precisionWhenSuggesting), 10),
    );
  }
  const verdict = [
    '',
    `VERDICT: ${artifact.verdict.verdict}`,
    `  ${artifact.verdict.rationale}`,
    '',
    'Report-only: this does not gate serving or promotion (v1 runs in shadow only).',
  ];
  return [...header, ...rows, ...verdict].join('\n');
};
