// child_process.fork entry — owns the recall rebuild pipeline.
//
// The parent's RecallLifecycle.scheduleRebuild used to run
// rebuildFromEventLog() in-process. That pipeline does substantial
// non-embed work — read merged event log, project recall events,
// scan legacy JSONL captures, JSON.parse each line, chunk each
// turn, encode/sort/write the binary index file. On a 13 k-event
// vault this pinned the API process's main thread for 60+ seconds
// even after the embedder itself was moved to its own child
// (042b2642): the embedder was idle while the parent burned CPU
// scanning + chunking + encoding.
//
// This entry isolates the whole rebuild in a separate OS process.
// The parent kicks off a rebuild via IPC, the child reads the
// vault, embeds (in-process within the child — no extra IPC hop),
// writes the new index file atomically via upsertEntries's
// existing rename-on-commit logic, then posts back the result.
// During the rebuild the parent's main thread is free; /v1/status
// and every other route stay hot.
//
// IPC frames:
//   parent → child: { kind: 'rebuild', vaultRoot, reason }
//   child → parent: { kind: 'started' }
//   child → parent: { kind: 'progress', embedded, total }
//   child → parent: { kind: 'done', state: 'ready' | 'failed',
//                     indexed?, error?, durationMs }
//
// The child exits after posting the `done` frame — the parent
// re-forks for the next rebuild. Process-isolation also means an
// onnxruntime crash inside the rebuild can't take down the API
// process; the parent just observes `failed` and moves on.

import { parentPort } from 'node:worker_threads';
// We're forked, not a worker_thread, but importing parentPort and
// finding it null is a good guard for someone running this entry
// in the wrong context.

import { rebuildFromEventLog } from './rebuild.js';
import { createEventLog } from '../sync/eventLog.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';

type ParentMessage = {
  readonly kind: 'rebuild';
  readonly vaultRoot: string;
  readonly reason: string;
};

type ChildMessage =
  | { readonly kind: 'started'; readonly reason: string }
  | { readonly kind: 'progress'; readonly embedded: number; readonly total: number }
  | {
      readonly kind: 'done';
      readonly state: 'ready' | 'failed';
      readonly indexed?: number;
      readonly error?: string;
      readonly durationMs: number;
    };

const post = (msg: ChildMessage): void => {
  process.send?.(msg);
};

if (parentPort !== null) {
  // This module was loaded inside a worker_thread. Bail — we expect
  // child_process.fork (which sets process.send and leaves
  // parentPort null).
  process.stderr.write(
    '[recall.indexer] error: loaded inside worker_thread; this entry expects child_process.fork\n',
  );
  process.exit(1);
}

process.on('message', (raw: unknown) => {
  const msg = raw as ParentMessage;
  if (msg.kind !== 'rebuild') return;
  void (async () => {
    const start = Date.now();
    post({ kind: 'started', reason: msg.reason });
    try {
      const replica = await loadOrCreateReplica(msg.vaultRoot);
      const eventLog = createEventLog(msg.vaultRoot, replica);
      const eventLogPath = `${msg.vaultRoot}/_BAC/log`;
      const result = await rebuildFromEventLog(msg.vaultRoot, eventLogPath, {
        eventLog,
        onProgress: (embedded, total) => {
          post({ kind: 'progress', embedded, total });
        },
      });
      post({
        kind: 'done',
        state: 'ready',
        indexed: result.indexed,
        durationMs: Date.now() - start,
      });
    } catch (err: unknown) {
      post({
        kind: 'done',
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    } finally {
      // Exit so the parent re-forks for the next rebuild. Keeping
      // the child resident between rebuilds would amortise model
      // load, but ONNX memory accretes across batches and a fresh
      // process every rebuild is the simpler invariant.
      process.exit(0);
    }
  })();
});
