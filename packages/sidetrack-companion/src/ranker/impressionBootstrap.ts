// P1b — main-process impression-bootstrap orchestrator.
//
// Reconstructs LightGBM training groups from historical explicit feedback by
// re-running /v2 recall (the `reconstructFeedback` closure, injected by the
// caller — the HTTP server — which owns the warm recall pipeline + embedder),
// trains them OFF-THREAD via trainGroups.worker, ship-gates, and promotes the
// active closest-visit ranker revision on PASS. The reconstruction (runRecall)
// runs in the MAIN process where its work is I/O-bound and interleaves with
// /v1/status; only the CPU-heavy LightGBM train is offloaded, so the bootstrap
// never causes the ~15s freeze the I/O guardrail forbids.

import type { ConnectionsSnapshot } from '../connections/types.js';
import { writeActiveClosestVisitRankerRevision } from '../producers/closest-visit-revision.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  maybeRetrainRecallImpressionRanker,
  writeRecallImpressionRetrainState,
  RECALL_IMPRESSION_RETRAIN_STATE_SCHEMA_VERSION,
  type RecallHistoricalFeedbackReconstructor,
  type RecallImpressionRetrainResult,
} from './retrain-impressions.js';
import type {
  RankerRevision,
  RankerTrainingGroup,
  RankerTrainingLabelingSummary,
  TrainRankerOptions,
} from './train.js';
import type { TrainGroupsWorkerJob } from './trainGroups.worker.js';

/** Spawn the off-thread train-from-groups worker and resolve with the trained
 *  revision. Mirrors runMaybeRetrainInWorker; lazy-imports worker_threads. */
const trainGroupsInWorker = async (job: TrainGroupsWorkerJob): Promise<RankerRevision> => {
  const { Worker } = await import('node:worker_threads');
  const workerUrl = new URL('./trainGroups.worker.js', import.meta.url);
  return await new Promise<RankerRevision>((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: job });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    worker.once(
      'message',
      (
        msg:
          | { readonly ok: true; readonly revision: RankerRevision }
          | { readonly ok: false; readonly error: string },
      ) => {
        settle(() => {
          if (msg.ok) {
            resolve(msg.revision);
          } else {
            reject(new Error(msg.error));
          }
        });
        void worker.terminate();
      },
    );
    worker.once('error', (err) => settle(() => reject(err)));
    worker.once('exit', (code) =>
      settle(() => reject(new Error(`Train-groups worker exited with code ${String(code)}`))),
    );
  });
};

export interface RunImpressionBootstrapInput {
  readonly vaultRoot: string;
  /** Full training-event history (recall.served + recall.action + feedback),
   *  read I/O-safely by the caller (event-store type index). */
  readonly history: readonly AcceptedEvent[];
  readonly snapshot: ConnectionsSnapshot;
  /** Re-runs /v2 recall for a historical feedback event; owns the warm
   *  pipeline. Must omit appendImpression (reconstruction is ephemeral —
   *  no synthetic recall.served is written to the durable log). */
  readonly reconstructFeedback: RecallHistoricalFeedbackReconstructor;
  readonly trainOptions?: TrainRankerOptions;
}

/**
 * Build (with reconstruction) → train OFF-THREAD → ship-gate → promote on PASS.
 * Returns the trainer result (skipped / trained, with the ship-gate decision).
 */
export const runRecallImpressionBootstrap = async (
  input: RunImpressionBootstrapInput,
): Promise<RecallImpressionRetrainResult> => {
  const result = await maybeRetrainRecallImpressionRanker({
    merged: input.history,
    snapshot: input.snapshot,
    reconstructFeedback: input.reconstructFeedback,
    ...(input.trainOptions === undefined ? {} : { trainOptions: input.trainOptions }),
    train: (
      groups: readonly RankerTrainingGroup[],
      options: TrainRankerOptions,
      labelingSummary: RankerTrainingLabelingSummary,
    ) => trainGroupsInWorker({ groups, trainOptions: options, labelingSummary }),
  });
  if (result.status === 'trained') {
    const promoted = result.shipGateDecision.status === 'pass';
    if (promoted) {
      await writeActiveClosestVisitRankerRevision(input.vaultRoot, result.revision);
    }
    await writeRecallImpressionRetrainState(input.vaultRoot, {
      schemaVersion: RECALL_IMPRESSION_RETRAIN_STATE_SCHEMA_VERSION,
      status: promoted ? 'promoted' : 'ship_gate_failed',
      revisionId: result.revision.revisionId,
      updatedAt: result.revision.trainedAt,
      stats: result.stats,
      shipGateDecision: result.shipGateDecision,
    });
  }
  return result;
};
