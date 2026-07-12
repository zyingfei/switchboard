// Parent-side client for the connections reconcile child process.
//
// Mirrors connectionsReconcileWorker.ts but uses `child_process.fork`
// instead of `worker_threads.Worker`. Why fork over worker_thread:
// the reconcile path transitively loads native addons (onnxruntime-
// node, usearch, sharp). Instantiating those addons in two V8
// isolates inside the same process triggers fatal "HeapObject::
// SafeSizeFromMap" crashes in the concurrent major sweeper. Each
// child gets its own V8, so the conflict is structurally impossible.
//
// One child per drain (no resident process) keeps heap bounded: the
// materializer's buildConnectionsSnapshot allocates a lot for a big
// vault, and forking fresh per drain means the OS reclaims it cleanly
// on exit instead of letting it accumulate across thousands of drains.

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { withBunSmolExecArgv } from '../../process/bunMemory.js';
import type { ReconcileWorkerJob, ReconcileWorkerResult } from './connectionsReconcileWorker.js';

let childScriptPath: string | undefined;

const markPostDrain = (label: string, startedAtMs: number): void => {
  const elapsedMs = Date.now() - startedAtMs;
  console.warn(`[connections-phase] post-drain.${label} dt=${String(elapsedMs)}ms`);
};

const defaultEntryPath = (): string => {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), 'connectionsReconcileChild.entry.js');
};

/** Test seam — point the harness at a different entry script. */
export const setReconcileChildScriptOverride = (path: string | undefined): void => {
  childScriptPath = path;
};

interface ReconcileChildMessage {
  readonly kind: 'reconcile';
  readonly vaultRoot: string;
  readonly seq: number;
}

export const buildReconcileChildEnv = (
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => ({ ...source });

/**
 * Fork a child process and run one reconcile pass. The promise resolves
 * with the child's result; the seq token round-trips so the caller can
 * ignore stale responses if a newer drain finished first.
 */
export const runReconcileInChild = (job: ReconcileWorkerJob): Promise<ReconcileWorkerResult> =>
  new Promise<ReconcileWorkerResult>((resolve) => {
    const entry = childScriptPath ?? defaultEntryPath();
    if (!existsSync(entry)) {
      resolve({
        seq: job.seq,
        ok: false,
        error: `reconcile child entry not found at ${entry}`,
      });
      return;
    }
    const child: ChildProcess = fork(entry, [], {
      env: buildReconcileChildEnv(),
      execArgv: withBunSmolExecArgv(process.execArgv),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let settled = false;
    const settle = (result: ReconcileWorkerResult): void => {
      if (settled) return;
      settled = true;
      // Best-effort terminate; ignore errors from already-exited child.
      try {
        child.kill('SIGTERM');
      } catch {
        /* child already exited */
      }
      resolve(result);
    };
    child.stdout?.on('data', (buf: Buffer) => {
      process.stdout.write(`[reconcile.child] ${buf.toString('utf8')}`);
    });
    child.stderr?.on('data', (buf: Buffer) => {
      process.stderr.write(`[reconcile.child] ${buf.toString('utf8')}`);
    });
    child.on('message', (raw: unknown) => {
      const receivedAtMs = Date.now();
      const result = raw as ReconcileWorkerResult;
      if (result.ok && result.snapshotRevision !== undefined) {
        markPostDrain('ipc-message', receivedAtMs);
      }
      settle(result);
    });
    child.on('error', (err) => {
      settle({ seq: job.seq, ok: false, error: err.message });
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settle({
        seq: job.seq,
        ok: false,
        error: `reconcile child exited code=${String(code)} signal=${String(signal ?? '')} without posting result`,
      });
    });
    const message: ReconcileChildMessage = {
      kind: 'reconcile',
      vaultRoot: job.vaultRoot,
      seq: job.seq,
    };
    child.send(message);
  });
