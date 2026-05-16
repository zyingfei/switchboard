// Stage 5 polish — ranker retrain worker entry. The HTTP route at
// /v1/closestVisits/retrain spawns this worker via the helper in
// retrain.ts so the LightGBM training math (≥1s of pure CPU on the
// dogfood vault, more on larger ones) AND the cold-path
// `readMerged()` + `readCurrent()` calls run off the main event loop.
// /v1/status and every other warm-path request stay responsive while
// retrain is in flight.
//
// The worker accepts a minimal serializable job — vaultRoot + knobs
// — and constructs its own EventLog + connectionsStore inside the
// worker context so the heavy `readMerged()` and `readCurrent()`
// I/O don't run on the request handler's thread. Mirrors the
// pattern used by `connectionsReconcileWorker.entry.ts`.

import { parentPort, workerData } from 'node:worker_threads';

import { createConnectionsStore } from '../connections/snapshot.js';
import { createEventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import { maybeRetrainClosestVisitRanker, type RankerRetrainResult } from './retrain.js';
import type { TrainRankerOptions } from './train.js';

export interface RetrainWorkerJob {
  readonly vaultRoot: string;
  readonly threshold?: number;
  readonly force?: boolean;
  readonly randomNegativeCandidatesPerPositive?: number;
  readonly trainOptions?: TrainRankerOptions;
}

interface WorkerSuccess {
  readonly ok: true;
  readonly result: RankerRetrainResult;
}

interface WorkerFailure {
  readonly ok: false;
  readonly error: string;
}

export type RetrainWorkerMessage = WorkerSuccess | WorkerFailure;

const post = (message: RetrainWorkerMessage): void => {
  parentPort?.postMessage(message);
};

const run = async (): Promise<void> => {
  if (parentPort === null) {
    return;
  }
  try {
    const job = workerData as RetrainWorkerJob;
    if (typeof job.vaultRoot !== 'string' || job.vaultRoot.length === 0) {
      post({ ok: false, error: 'Worker job missing vaultRoot' });
      return;
    }
    // Construct event log + connectionsStore fresh inside the worker so
    // the cold-path file reads happen here, not on the request handler.
    const replica = await loadOrCreateReplica(job.vaultRoot);
    const eventLog = createEventLog(job.vaultRoot, replica);
    const connectionsStore = createConnectionsStore(job.vaultRoot);
    const merged = await eventLog.readMerged();
    const snapshot = await connectionsStore.readCurrent();
    if (snapshot === null) {
      post({ ok: false, error: 'Connections snapshot is not ready' });
      return;
    }
    const result = await maybeRetrainClosestVisitRanker({
      vaultRoot: job.vaultRoot,
      merged,
      snapshot,
      ...(job.threshold === undefined ? {} : { threshold: job.threshold }),
      ...(job.force === undefined ? {} : { force: job.force }),
      ...(job.randomNegativeCandidatesPerPositive === undefined
        ? {}
        : { randomNegativeCandidatesPerPositive: job.randomNegativeCandidatesPerPositive }),
      ...(job.trainOptions === undefined ? {} : { trainOptions: job.trainOptions }),
    });
    post({ ok: true, result });
  } catch (error) {
    post({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

void run();
