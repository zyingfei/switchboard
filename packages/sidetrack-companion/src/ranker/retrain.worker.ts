// Stage 5 polish — ranker retrain worker entry. The HTTP route at
// /v1/closestVisits/retrain spawns this worker via the helper in
// retrain.ts so the LightGBM training math (≥1s of pure CPU on the
// dogfood vault, more on larger ones) runs off the main event loop.
// /v1/status and every other warm-path request stay responsive while
// retrain is in flight.
//
// The worker imports `maybeRetrainClosestVisitRanker` and runs it
// against the workerData payload — the caller in server.ts only
// supplies serializable fields (vaultRoot, merged events, snapshot,
// threshold knobs), so structuredClone moves the input cleanly across
// the thread boundary. Function defaults (train / readState /
// writeState) come from the worker's own imports.

import { parentPort, workerData } from 'node:worker_threads';

import {
  maybeRetrainClosestVisitRanker,
  type MaybeRetrainClosestVisitRankerInput,
  type RankerRetrainResult,
} from './retrain.js';

interface WorkerSuccess {
  readonly ok: true;
  readonly result: RankerRetrainResult;
}

interface WorkerFailure {
  readonly ok: false;
  readonly error: string;
}

const run = async (): Promise<void> => {
  if (parentPort === null) {
    return;
  }
  try {
    const input = workerData as MaybeRetrainClosestVisitRankerInput;
    const result = await maybeRetrainClosestVisitRanker(input);
    const message: WorkerSuccess = { ok: true, result };
    parentPort.postMessage(message);
  } catch (error) {
    const message: WorkerFailure = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    parentPort.postMessage(message);
  }
};

void run();
