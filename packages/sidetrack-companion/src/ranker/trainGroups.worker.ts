// P1b impression-bootstrap — off-thread "train from pre-built groups" worker.
//
// The reconstruction step (re-running /v2 recall over historical feedback to
// synthesise training groups) MUST run in the MAIN process: that's where the
// recall pipeline + embedder are warm, and its work is I/O-bound so it
// interleaves with /v1/status like normal /v2 serving. Only the CPU-heavy
// LightGBM training is offloaded here, so the bootstrap never blocks the
// request loop (an inline train would be the ~15s /status freeze the I/O
// guardrail forbids). Mirrors retrain.worker.ts, but takes pre-built groups
// instead of reading the log + reconstructing inside the worker (the worker
// has no recall pipeline).

import { parentPort, workerData } from 'node:worker_threads';

import {
  trainRankerRevisionFromGroups,
  type RankerRevision,
  type RankerTrainingGroup,
  type RankerTrainingLabelingSummary,
  type TrainRankerOptions,
} from './train.js';

export interface TrainGroupsWorkerJob {
  readonly groups: readonly RankerTrainingGroup[];
  readonly trainOptions?: TrainRankerOptions;
  readonly labelingSummary?: RankerTrainingLabelingSummary;
}

type TrainGroupsWorkerMessage =
  | { readonly ok: true; readonly revision: RankerRevision }
  | { readonly ok: false; readonly error: string };

const post = (message: TrainGroupsWorkerMessage): void => {
  parentPort?.postMessage(message);
};

const run = async (): Promise<void> => {
  if (parentPort === null) {
    return;
  }
  try {
    const job = workerData as TrainGroupsWorkerJob;
    if (!Array.isArray(job.groups) || job.groups.length === 0) {
      post({ ok: false, error: 'Worker job missing training groups' });
      return;
    }
    const revision = await trainRankerRevisionFromGroups(
      job.groups,
      job.trainOptions ?? {},
      job.labelingSummary,
    );
    post({ ok: true, revision });
  } catch (error) {
    post({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

void run();
