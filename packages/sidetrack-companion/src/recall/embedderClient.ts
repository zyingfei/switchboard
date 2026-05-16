// Parent-side client for the embedder sidecar child process.
//
// Spawns one child via `child_process.fork`. All embed() calls go
// through `request(texts)` — the child does the inference, the
// main thread stays free for /v1/status and every other route. If
// the child crashes (segfault from ONNX, OOM, V8 fatal in the
// child's heap), the parent observes 'failed' and the next call
// re-spawns. The /status endpoint exposes the current state.
//
// Why not worker_threads: a prior attempt to put the materializer's
// catchUp on a worker_thread triggered a V8 fatal in the concurrent
// major sweeper — the V8 heap is shared per process across isolates
// and native addons (onnxruntime-node, usearch, sharp) don't all
// survive being instantiated twice. fork()s a fresh OS process; the
// heap is fully isolated.

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

export type EmbedderState = 'disabled' | 'cold' | 'warming' | 'ready' | 'failed';

export interface EmbedderClient {
  /** Coarse lifecycle state — drives /v1/status.recall.vectorState. */
  readonly state: () => EmbedderState;
  /** Most recent failure message, if any. */
  readonly lastError: () => string | undefined;
  /** True when the child has reported `ready`. Used by /v1/recall/query degrade path. */
  readonly isReady: () => boolean;
  /** Submit a batch of texts. Resolves with Float32Array embeddings. */
  readonly embed: (texts: readonly string[]) => Promise<readonly Float32Array[]>;
  /** Tear down — kills the child on companion shutdown. */
  readonly stop: () => Promise<void>;
}

interface Pending {
  readonly resolve: (vectors: readonly Float32Array[]) => void;
  readonly reject: (err: Error) => void;
}

type ChildMessage =
  | { readonly kind: 'ready' }
  | { readonly kind: 'state'; readonly state: EmbedderState; readonly detail?: string }
  | { readonly kind: 'embed-ok'; readonly id: number; readonly vectors: readonly number[][] }
  | { readonly kind: 'embed-err'; readonly id: number; readonly error: string };

export interface EmbedderClientOptions {
  /** Override the entry script path (tests use this; production resolves automatically). */
  readonly entryPath?: string;
  /** Override fork() — tests stub this to verify wiring. */
  readonly forker?: typeof fork;
}

const defaultEntryPath = (): string => {
  const here = fileURLToPath(import.meta.url);
  // Production: alongside this file in dist/. Source dir (tests): same.
  return join(dirname(here), 'embedderChild.entry.js');
};

export const createEmbedderClient = (options: EmbedderClientOptions = {}): EmbedderClient => {
  const entryPath = options.entryPath ?? defaultEntryPath();
  const fork_ = options.forker ?? fork;

  let child: ChildProcess | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  let state: EmbedderState = 'cold';
  let lastErrorMsg: string | undefined;
  let stopped = false;

  const transitionTo = (next: EmbedderState, detail?: string): void => {
    state = next;
    if (next === 'failed') {
      lastErrorMsg = detail ?? 'embedder child failed';
    }
  };

  const failPending = (err: Error): void => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  const spawnChild = (): ChildProcess | null => {
    if (stopped) return null;
    if (!existsSync(entryPath)) {
      transitionTo('failed', `embedder entry not found at ${entryPath}`);
      return null;
    }
    const next = fork_(entryPath, [], {
      // The child inherits the parent's env so SIDETRACK_MODELS_DIR /
      // SIDETRACK_OFFLINE_MODELS / SIDETRACK_TEST_EMBEDDER all flow
      // through unchanged.
      env: process.env,
      // pipe stdout/stderr to the parent so [recall.child] logs land
      // in the same place as the rest of the companion's output.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    next.stdout?.on('data', (buf: Buffer) => {
      process.stdout.write(`[recall.child] ${buf.toString('utf8')}`);
    });
    next.stderr?.on('data', (buf: Buffer) => {
      process.stderr.write(`[recall.child] ${buf.toString('utf8')}`);
    });
    next.on('message', (raw: unknown) => {
      const msg = raw as ChildMessage;
      if (msg.kind === 'state') {
        transitionTo(msg.state, msg.detail);
        return;
      }
      if (msg.kind === 'ready') {
        transitionTo('ready');
        return;
      }
      if (msg.kind === 'embed-ok') {
        const p = pending.get(msg.id);
        if (p === undefined) return;
        pending.delete(msg.id);
        const vectors = msg.vectors.map((arr) => Float32Array.from(arr));
        p.resolve(vectors);
        return;
      }
      if (msg.kind === 'embed-err') {
        const p = pending.get(msg.id);
        if (p === undefined) return;
        pending.delete(msg.id);
        p.reject(new Error(msg.error));
      }
    });
    next.on('exit', (code, signal) => {
      transitionTo(
        'failed',
        `embedder child exited code=${String(code)} signal=${String(signal ?? '')}`,
      );
      failPending(new Error(lastErrorMsg ?? 'embedder child exited'));
      child = null;
      // Re-spawn lazily on the next embed() call rather than
      // immediately; if the child is dying repeatedly we don't want
      // a spawn loop.
    });
    next.on('error', (err) => {
      transitionTo('failed', err.message);
      failPending(err);
      child = null;
    });
    return next;
  };

  const ensureChild = (): ChildProcess | null => {
    if (child !== null && child.connected) return child;
    child = spawnChild();
    return child;
  };

  return {
    state: () => (stopped ? 'disabled' : state),
    lastError: () => lastErrorMsg,
    isReady: () => state === 'ready',
    async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
      if (texts.length === 0) return [];
      const c = ensureChild();
      if (c === null) {
        throw new Error(lastErrorMsg ?? 'embedder child unavailable');
      }
      const id = nextId;
      nextId += 1;
      return new Promise<readonly Float32Array[]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        c.send({ kind: 'embed', id, texts }, (err) => {
          if (err === null || err === undefined) return;
          pending.delete(id);
          reject(err);
        });
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      const c = child;
      child = null;
      failPending(new Error('embedder client stopped'));
      if (c === null) return;
      c.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          c.kill('SIGKILL');
          resolve();
        }, 2_000);
        c.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
};
