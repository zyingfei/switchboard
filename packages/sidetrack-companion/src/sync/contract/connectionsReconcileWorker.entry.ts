// Stage 5.2 W1 — worker_thread entry script.
//
// Imports the materializer module fresh inside the worker context so
// no live state is shared with the main thread. Workflow:
//
//   1. Read { vaultRoot, seq } from workerData.
//   2. Instantiate a fresh ConnectionsMaterializer + dependencies
//      against `vaultRoot`.
//   3. Run catchUp(eventLog). This drives one buildAndWrite pass.
//   4. Post the resulting snapshotRevision back to the main thread.
//
// The worker exits after posting. The main thread's runReconcileInWorker
// spawns a new worker for each job — pool reuse isn't worth the
// complexity at the per-vault-drain rate (debounced to 250ms).

import { parentPort, workerData } from 'node:worker_threads';

import { createConnectionsStore } from '../../connections/snapshot.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createTimelineStore } from '../../timeline/projection.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';
import type {
  ReconcileWorkerJob,
  ReconcileWorkerResult,
} from './connectionsReconcileWorker.js';

const post = (result: ReconcileWorkerResult): void => {
  parentPort?.postMessage(result);
};

const run = async (): Promise<void> => {
  const job = workerData as ReconcileWorkerJob;
  if (typeof job?.vaultRoot !== 'string' || typeof job?.seq !== 'number') {
    post({ seq: -1, ok: false, error: 'invalid worker job payload' });
    return;
  }
  try {
    const replica = await loadOrCreateReplica(job.vaultRoot);
    const eventLog = createEventLog(job.vaultRoot, replica);
    const timelineStore = createTimelineStore(job.vaultRoot);
    const store = createConnectionsStore(job.vaultRoot);
    const materializer = createConnectionsMaterializer({
      vaultRoot: job.vaultRoot,
      eventLog,
      timelineStore,
      store,
    });
    await materializer.catchUp(eventLog);
    const snapshot = await store.readCurrent();
    post({
      seq: job.seq,
      ok: true,
      ...(snapshot?.snapshotRevision === undefined
        ? {}
        : { snapshotRevision: snapshot.snapshotRevision }),
    });
  } catch (error) {
    post({
      seq: job.seq,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

void run();
