// Wave 0 — freeze-safe eval spine (report-only).
//
// CLI orchestration for the eval spine: read a vault's event log + live
// connections snapshot + trained ranker revision FROM DISK (no running
// companion), run the replay harness / connections-precision harness /
// paired-bootstrap significance, print the side-by-side report, and persist
// the JSON verdict artifact under the vault diagnostics dir.
//
// The companion CLI's `eval` subcommand (cli.ts) is a thin wrapper over
// these functions. REPORT-ONLY: none of this influences serving.

import { computeConnectionsPrecision } from '../../connections/eval/connectionsPrecision.js';
import { buildAcceptedUserSignal } from '../../connections/eval/connectionsPrecision.js';
import { formatConnectionsPrecisionReport } from '../../connections/eval/connectionsPrecision.js';
import type { ConnectionsPrecisionReport } from '../../connections/eval/connectionsPrecision.js';
import { createConnectionsStore } from '../../connections/snapshot.js';
import type { ConnectionsSnapshot } from '../../connections/types.js';
import type { AcceptedEvent } from '../../sync/causal.js';
import { readActiveClosestVisitRankerRevisionManifest } from '../../producers/closest-visit-revision.js';
import { readClosestVisitRankerRevision } from '../../producers/closest-visit-revision.js';
import type { RankerRevision } from '../train.js';
import { formatReplayReport, runReplayHarness, type ReplayReport } from './replayHarness.js';
import {
  buildReplayEvalVerdict,
  formatVerdict,
  writeReplayEvalVerdict,
  type ReplayEvalVerdict,
} from './verdictArtifact.js';

/** A snapshot placeholder used only for the trainer's reconstruction
 *  fallback when the vault has no committed connections snapshot. Impression
 *  rows that carry a point-in-time feature vector (PR #242) never touch it. */
const EMPTY_SNAPSHOT: ConnectionsSnapshot = {
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: '',
  nodeCount: 0,
  edgeCount: 0,
};

/** Read the merged event log from a vault WITHOUT the companion. Lazily
 *  imports the event-log + replica-id modules so the help/other subcommands
 *  don't pull the full graph. */
export const readVaultEvents = async (vaultRoot: string): Promise<readonly AcceptedEvent[]> => {
  const { createEventLog } = await import('../../sync/eventLog.js');
  const { loadOrCreateReplica } = await import('../../sync/replicaId.js');
  const replica = await loadOrCreateReplica(vaultRoot);
  const eventLog = createEventLog(vaultRoot, replica);
  return await eventLog.readMerged();
};

/** Read the live committed connections snapshot from disk, or the empty
 *  placeholder when none exists yet. */
export const readVaultSnapshot = async (vaultRoot: string): Promise<ConnectionsSnapshot> => {
  const store = createConnectionsStore(vaultRoot);
  const snapshot = await store.readCurrent();
  return snapshot ?? EMPTY_SNAPSHOT;
};

/** Read the active trained ranker revision from disk, or null when the
 *  vault has no promoted model (the replay then reports floors only). */
export const readVaultTrainedRevision = async (
  vaultRoot: string,
): Promise<RankerRevision | null> => {
  const manifest = await readActiveClosestVisitRankerRevisionManifest(vaultRoot);
  if (manifest === null) return null;
  return await readClosestVisitRankerRevision(vaultRoot, manifest.revisionId);
};

export interface ReplayEvalRunResult {
  readonly report: ReplayReport;
  readonly verdict: ReplayEvalVerdict;
  readonly verdictPath: string | null;
}

export interface ReplayEvalRunOptions {
  /** When false, the verdict artifact is computed + returned but NOT
   *  persisted to disk (used by --dry-run / tests). */
  readonly persist?: boolean;
  readonly bootstrapIterations?: number;
  readonly bootstrapSeed?: number;
  readonly confidence?: number;
  readonly generatedAt?: number;
}

/**
 * End-to-end replay eval against a vault: read events + snapshot + model,
 * run the harness, build the verdict, optionally persist it.
 */
export const runReplayEval = async (
  vaultRoot: string,
  options: ReplayEvalRunOptions = {},
): Promise<ReplayEvalRunResult> => {
  const [merged, snapshot, trainedRevision] = await Promise.all([
    readVaultEvents(vaultRoot),
    readVaultSnapshot(vaultRoot),
    readVaultTrainedRevision(vaultRoot),
  ]);
  const report = await runReplayHarness({ vaultRoot, merged, snapshot, trainedRevision });
  const verdict = buildReplayEvalVerdict(report, {
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    ...(options.bootstrapIterations === undefined
      ? {}
      : { bootstrapIterations: options.bootstrapIterations }),
    ...(options.bootstrapSeed === undefined ? {} : { bootstrapSeed: options.bootstrapSeed }),
    ...(options.confidence === undefined ? {} : { confidence: options.confidence }),
  });
  let verdictPath: string | null = null;
  if (options.persist !== false) {
    await writeReplayEvalVerdict(vaultRoot, verdict);
    const { replayEvalVerdictPath } = await import('./verdictArtifact.js');
    verdictPath = replayEvalVerdictPath(vaultRoot);
  }
  return { report, verdict, verdictPath };
};

/** Human-readable replay + significance report for the CLI. */
export const formatReplayEvalRunResult = (result: ReplayEvalRunResult): string => {
  const parts = [
    'Replay eval — report-only (does not gate promotion)',
    formatReplayReport(result.report),
    '',
    'Paired-bootstrap significance (trained model vs reference arms):',
    formatVerdict(result.verdict),
  ];
  if (result.verdictPath !== null) {
    parts.push('', `verdict artifact → ${result.verdictPath}`);
  }
  return parts.join('\n');
};

export interface ConnectionsPrecisionRunResult {
  readonly report: ConnectionsPrecisionReport;
}

/**
 * Connections-precision eval against a vault: read the live snapshot + the
 * accepted user signal, score served similarity edges by evidence tier.
 * Read-only.
 */
export const runConnectionsPrecisionEval = async (
  vaultRoot: string,
): Promise<ConnectionsPrecisionRunResult> => {
  const [merged, snapshot] = await Promise.all([
    readVaultEvents(vaultRoot),
    readVaultSnapshot(vaultRoot),
  ]);
  const signal = buildAcceptedUserSignal(merged);
  const report = computeConnectionsPrecision(snapshot, signal);
  return { report };
};

export const formatConnectionsPrecisionRunResult = (
  result: ConnectionsPrecisionRunResult,
): string =>
  [
    'Connections precision by evidence tier — report-only (read-only over the live snapshot)',
    formatConnectionsPrecisionReport(result.report),
  ].join('\n');
