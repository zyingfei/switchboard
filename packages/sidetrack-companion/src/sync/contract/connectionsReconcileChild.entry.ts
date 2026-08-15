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

import { setPriority } from 'node:os';

import { createConnectionsStore, SqliteConnectionsStore } from '../../connections/snapshot.js';
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

// Deprioritize ourselves, not the serving parent. A catch-up over a real
// vault burns a core for many minutes; at default priority it competes with
// the parent's HTTP serving and the user's browser (observed 2026-08-15:
// machine-wide paging + the panel's 15s banner while a child crunched a
// 105k-event backlog). Nice 15 keeps full throughput on an idle machine and
// yields under contention. Renicing the PARENT instead is wrong — children
// inherit it, and the parent is the serving process.
try {
  setPriority(15);
} catch {
  // Best-effort; scheduling priority is not load-bearing.
}

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

// M7 — liveness heartbeat. catchUp is a single long await with no
// per-phase IPC, so the parent cannot distinguish "slowly making
// progress on a big vault" from "wedged in a native-addon deadlock".
// A periodic heartbeat gives the parent's no-progress watchdog a signal
// to reset while the child is genuinely alive; a wedged child stops
// heartbeating (the event loop is blocked) and the watchdog fires.
const HEARTBEAT_INTERVAL_MS = 30_000;

const postHeartbeat = (): void => {
  try {
    process.send?.({ kind: 'heartbeat' });
  } catch {
    // Parent disappeared; nothing to keep alive for.
  }
};

const run = async (msg: ReconcileMessage): Promise<void> => {
  if (typeof msg.vaultRoot !== 'string' || typeof msg.seq !== 'number') {
    post({ seq: -1, ok: false, error: 'invalid reconcile job payload' });
    process.exit(1);
    return;
  }
  const heartbeat = setInterval(postHeartbeat, HEARTBEAT_INTERVAL_MS);
  // Don't let the heartbeat timer itself keep the child alive past its work.
  heartbeat.unref?.();
  try {
    const replica = await loadOrCreateReplica(msg.vaultRoot);
    const eventLog = createEventLog(msg.vaultRoot, replica);
    const timelineStore = createTimelineStore(msg.vaultRoot);
    // M4 — the reconcile child is the WRITER: it builds into a shadow
    // generation and publishes via checkpoint + pointer-flip on exit. The
    // parent reads the published generation readonly.
    const store = createConnectionsStore(msg.vaultRoot, { role: 'child-writer' });
    const materializer = createConnectionsMaterializer({
      vaultRoot: msg.vaultRoot,
      eventLog,
      timelineStore,
      store,
    });
    await materializer.catchUp(eventLog);
    clearInterval(heartbeat);
    const metadata =
      store instanceof SqliteConnectionsStore
        ? await store.readSnapshotMetadata()
        : await store.readCurrent();
    post({
      seq: msg.seq,
      ok: true,
      ...(metadata?.snapshotRevision === undefined
        ? {}
        : { snapshotRevision: metadata.snapshotRevision }),
    });
    // Close the store explicitly BEFORE process.exit — exit runs no cleanup, so
    // relying on abrupt OS teardown of the writer handle is fragile. The
    // child's writer handle is already closed at publish (pre-flip), so this is
    // belt-and-suspenders: it also releases any residual metadata-read handle.
    try {
      store.close?.();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  } catch (err) {
    clearInterval(heartbeat);
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
