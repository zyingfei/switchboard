// Stage 5.2 W1 — worker_thread reconcile runner.
//
// Goal: take buildAndWrite off the main event loop so HTTP P99 stays
// bounded during reconciliation. Implementation strategy:
//
//   - The main thread calls `runReconcileInWorker({ vaultRoot, seq })`.
//   - That spawns (or reuses) a Worker that imports a fresh
//     ConnectionsMaterializer instance and runs `catchUp` against the
//     vault's event log on disk.
//   - The worker posts back `{ seq, ok, snapshotRevision?, error? }`.
//     Main thread awaits the matching seq; out-of-order responses
//     (worker A finished after worker B with a higher seq) are
//     discarded by the caller — the in-memory snapshot store always
//     has the latest revision and the worker's putCurrent atomic
//     swap is the durability oracle.
//
// This module is the harness only — wiring into the materializer's
// drain loop is gated behind `SIDETRACK_CONNECTIONS_WORKER=1` in a
// follow-up. Today's drain path stays in-process; the harness ships
// so the integration can be a small, mechanical change.
//
// Why one worker_thread per vault instead of a worker pool: a single
// vault has a single materializer; concurrent rebuilds would race on
// the snapshot file. Serialise to one worker; the materializer's
// debounce coalesces bursts.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface ReconcileWorkerJob {
  readonly vaultRoot: string;
  readonly seq: number;
}

export interface ReconcileWorkerResult {
  readonly seq: number;
  readonly ok: boolean;
  readonly snapshotRevision?: string;
  readonly error?: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to the worker entry script. In production build this resolves
 * to the same JS file as this module; tests can override via
 * `setWorkerScriptOverride`.
 */
let workerScriptPath = join(__dirname, 'connectionsReconcileWorker.entry.js');

/** Test seam — point the harness at a different worker script. */
export const setWorkerScriptOverride = (path: string | undefined): void => {
  if (path === undefined) {
    workerScriptPath = join(__dirname, 'connectionsReconcileWorker.entry.js');
    return;
  }
  workerScriptPath = path;
};

/**
 * Spawn a worker_thread and run one reconcile pass. The promise
 * resolves with the worker's result regardless of `ok` — caller is
 * responsible for checking the field and falling back to in-process
 * drain on failure.
 *
 * The seq token round-trips so the caller can ignore stale responses
 * if a newer drain finished first.
 */
export const runReconcileInWorker = (
  job: ReconcileWorkerJob,
): Promise<ReconcileWorkerResult> =>
  new Promise<ReconcileWorkerResult>((resolve) => {
    const worker = new Worker(workerScriptPath, {
      workerData: job,
    });
    let settled = false;
    const settle = (result: ReconcileWorkerResult): void => {
      if (settled) return;
      settled = true;
      // Best-effort terminate; ignore errors from already-exited worker.
      void worker.terminate().catch(() => {
        /* worker already exited */
      });
      resolve(result);
    };
    worker.on('message', (message: ReconcileWorkerResult) => {
      settle(message);
    });
    worker.on('error', (error: Error) => {
      settle({ seq: job.seq, ok: false, error: error.message });
    });
    worker.on('exit', (code: number) => {
      if (settled) return;
      settle({
        seq: job.seq,
        ok: false,
        error: `worker exited with code ${String(code)} without posting result`,
      });
    });
  });
