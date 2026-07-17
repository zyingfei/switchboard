// Attribution v1 — prequential eval CLI runner (report-only, read-only).
//
// Mirrors ranker/eval/cli.ts: read the vault's merged event log FROM DISK (no
// running companion), run the prequential replay, build the verdict, optionally
// persist the diagnostics artifact, and format the CLI report. READ-ONLY over
// the vault; the only write is the report-only verdict under _BAC/eval/.

import type { AcceptedEvent } from '../../sync/causal.js';
import {
  buildPrequentialVerdict,
  runAttributionPrequential,
  runV1ThresholdCurve,
  type PrequentialReport,
  type PrequentialVerdict,
  type ThresholdCurvePoint,
} from './prequential.js';
import {
  attributionPrequentialVerdictPath,
  buildAttributionPrequentialArtifact,
  formatPrequentialReport,
  writeAttributionPrequentialArtifact,
  type AttributionPrequentialArtifact,
} from './verdictArtifact.js';

// Read the merged event log from a vault WITHOUT the companion. Lazily imports
// the event-log + replica-id modules (same pattern as ranker/eval/cli.ts's
// readVaultEvents) so the help/other subcommands don't pull the full graph.
export const readVaultEventsForPrequential = async (
  vaultRoot: string,
): Promise<readonly AcceptedEvent[]> => {
  const { createEventLog } = await import('../../sync/eventLog.js');
  const { loadOrCreateReplica } = await import('../../sync/replicaId.js');
  const replica = await loadOrCreateReplica(vaultRoot);
  const eventLog = createEventLog(vaultRoot, replica);
  return await eventLog.readMerged();
};

export interface PrequentialEvalRunResult {
  readonly report: PrequentialReport;
  readonly verdict: PrequentialVerdict;
  readonly artifact: AttributionPrequentialArtifact;
  readonly artifactPath: string | null;
}

export interface PrequentialEvalRunOptions {
  // When false, the artifact is computed + returned but NOT persisted to disk.
  readonly persist?: boolean;
  readonly generatedAt?: number;
  // Injectable event reader (tests pass a synthetic slice; the CLI reads the
  // vault). Defaults to readVaultEventsForPrequential.
  readonly readEvents?: (vaultRoot: string) => Promise<readonly AcceptedEvent[]>;
}

export const runAttributionPrequentialEval = async (
  vaultRoot: string,
  options: PrequentialEvalRunOptions = {},
): Promise<PrequentialEvalRunResult> => {
  const readEvents = options.readEvents ?? readVaultEventsForPrequential;
  const events = await readEvents(vaultRoot);
  const report = runAttributionPrequential(events);
  const verdict = buildPrequentialVerdict(report);
  // The evidence-gate tradeoff curve — the calibration evidence for
  // MIN_SUGGEST_SCORE (north-star §2 abstention-first). Report-only.
  const thresholdCurve: readonly ThresholdCurvePoint[] = runV1ThresholdCurve(events);
  const artifact = buildAttributionPrequentialArtifact(report, verdict, {
    thresholdCurve,
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
  });
  let artifactPath: string | null = null;
  if (options.persist !== false) {
    await writeAttributionPrequentialArtifact(vaultRoot, artifact);
    artifactPath = attributionPrequentialVerdictPath(vaultRoot);
  }
  return { report, verdict, artifact, artifactPath };
};

export const formatPrequentialEvalRunResult = (result: PrequentialEvalRunResult): string => {
  const parts = [formatPrequentialReport(result.artifact)];
  if (result.artifactPath !== null) {
    parts.push('', `verdict artifact → ${result.artifactPath}`);
  }
  return parts.join('\n');
};
