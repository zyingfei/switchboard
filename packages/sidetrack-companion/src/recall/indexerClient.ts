// Parent-side client for the recall indexer child process.
//
// One fork per rebuild — the child exits when done so we don't
// accrue ONNX/native memory across runs. The parent's
// RecallLifecycle calls `rebuild()` and awaits the promise; the
// parent main thread stays free during the rebuild.
//
// Progress messages are forwarded to the supplied onProgress
// callback so the existing lifecycle's `rebuildEmbedded/Total`
// surface keeps working.

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

export interface IndexerRebuildInput {
  readonly vaultRoot: string;
  readonly reason: string;
  readonly onProgress?: (embedded: number, total: number) => void;
}

export interface IndexerRebuildResult {
  readonly state: 'ready' | 'failed';
  readonly indexed?: number;
  readonly error?: string;
  readonly durationMs: number;
}

export interface RecallIndexerClient {
  readonly rebuild: (input: IndexerRebuildInput) => Promise<IndexerRebuildResult>;
  readonly stop: () => Promise<void>;
}

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

export interface RecallIndexerClientOptions {
  readonly entryPath?: string;
  readonly forker?: typeof fork;
}

const defaultEntryPath = (): string => {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), 'indexerChild.entry.js');
};

export const createRecallIndexerClient = (
  options: RecallIndexerClientOptions = {},
): RecallIndexerClient => {
  const entryPath = options.entryPath ?? defaultEntryPath();
  const fork_ = options.forker ?? fork;
  let current: ChildProcess | null = null;
  let stopped = false;

  return {
    async rebuild(input: IndexerRebuildInput): Promise<IndexerRebuildResult> {
      if (stopped) {
        return { state: 'failed', error: 'indexer client stopped', durationMs: 0 };
      }
      if (!existsSync(entryPath)) {
        return {
          state: 'failed',
          error: `recall indexer entry not found at ${entryPath}`,
          durationMs: 0,
        };
      }
      return new Promise<IndexerRebuildResult>((resolve) => {
        const child = fork_(entryPath, [], {
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        current = child;
        const settle = (result: IndexerRebuildResult): void => {
          if (current === child) current = null;
          resolve(result);
        };
        child.stdout?.on('data', (buf: Buffer) => {
          process.stdout.write(`[recall.indexer] ${buf.toString('utf8')}`);
        });
        child.stderr?.on('data', (buf: Buffer) => {
          process.stderr.write(`[recall.indexer] ${buf.toString('utf8')}`);
        });
        child.on('message', (raw: unknown) => {
          const msg = raw as ChildMessage;
          if (msg.kind === 'progress') {
            input.onProgress?.(msg.embedded, msg.total);
            return;
          }
          if (msg.kind === 'done') {
            settle({
              state: msg.state,
              ...(msg.indexed === undefined ? {} : { indexed: msg.indexed }),
              ...(msg.error === undefined ? {} : { error: msg.error }),
              durationMs: msg.durationMs,
            });
          }
        });
        child.on('error', (err) => {
          settle({ state: 'failed', error: err.message, durationMs: 0 });
        });
        child.on('exit', (code, signal) => {
          // If the child exits without posting `done`, surface a
          // failure with the exit info.
          if (current !== null) {
            settle({
              state: 'failed',
              error: `recall indexer exited code=${String(code)} signal=${String(signal ?? '')}`,
              durationMs: 0,
            });
          }
        });
        child.send({ kind: 'rebuild', vaultRoot: input.vaultRoot, reason: input.reason });
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      const c = current;
      current = null;
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
