// child_process.fork entry script.
//
// Mirrors connectionsReconcileWorker.entry.ts but reads its job from
// an IPC `message` (not workerData). Each fork is single-use: receive
// one reconcile job, run materializer.catchUp, post the result, exit.
//
// The child does not share memory with the parent — it re-instantiates
// a fresh ConnectionsMaterializer + EventLog + stores against the
// vault path it was given. The snapshot store on disk is the
// hand-off: the child writes the new snapshot, the parent reads it
// from disk on the next HTTP request.

import { createConnectionsStore } from '../../connections/snapshot.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createTimelineStore } from '../../timeline/projection.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';
import type { ReconcileWorkerResult } from './connectionsReconcileWorker.js';

// Guard: this script is only meaningful when launched via `fork` —
// IPC channel must be present. If somebody runs the .js directly this
// fails fast instead of silently looping waiting for a message that
// will never arrive.
if (typeof process.send !== 'function') {
  process.stderr.write('[reconcile.child] missing IPC channel; refusing to start\n');
  process.exit(1);
}

// CRITICAL: break the fork-bomb. The CHILD env flag is inherited via
// process.env when the parent forks us; if we leave it set, the
// materializer we create below will see it and spawn ANOTHER child,
// which will spawn another, and so on. The isMainThread guard only
// blocks worker_threads recursion — child_process forks are their
// own main thread. Force the in-process path inside the child so the
// materializer we run here runs locally, not in a grandchild.
delete process.env['SIDETRACK_CONNECTIONS_CHILD'];
delete process.env['SIDETRACK_CONNECTIONS_WORKER'];
process.env['SIDETRACK_CONNECTIONS_INPROCESS'] = '1';

interface ReconcileMessage {
  readonly kind: 'reconcile';
  readonly vaultRoot: string;
  readonly seq: number;
}

const post = (result: ReconcileWorkerResult): void => {
  try {
    process.send?.(result);
  } catch {
    // Parent disappeared.
  }
};

const run = async (msg: ReconcileMessage): Promise<void> => {
  if (typeof msg.vaultRoot !== 'string' || typeof msg.seq !== 'number') {
    post({ seq: -1, ok: false, error: 'invalid reconcile job payload' });
    process.exit(1);
    return;
  }
  try {
    const replica = await loadOrCreateReplica(msg.vaultRoot);
    const eventLog = createEventLog(msg.vaultRoot, replica);
    const timelineStore = createTimelineStore(msg.vaultRoot);
    const store = createConnectionsStore(msg.vaultRoot);
    const materializer = createConnectionsMaterializer({
      vaultRoot: msg.vaultRoot,
      eventLog,
      timelineStore,
      store,
    });
    await materializer.catchUp(eventLog);
    const snapshot = await store.readCurrent();
    post({
      seq: msg.seq,
      ok: true,
      ...(snapshot?.snapshotRevision === undefined
        ? {}
        : { snapshotRevision: snapshot.snapshotRevision }),
    });
    process.exit(0);
  } catch (err) {
    post({
      seq: msg.seq,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
};

process.on('message', (raw: unknown) => {
  const msg = raw as ReconcileMessage;
  if (msg?.kind === 'reconcile') {
    void run(msg);
  }
});
