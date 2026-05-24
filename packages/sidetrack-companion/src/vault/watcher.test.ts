import type { FSWatcher } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createVaultWatcher, type VaultChangeEvent } from './watcher.js';

const delay = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
};

interface WatcherHarness {
  readonly events: VaultChangeEvent[];
  readonly emit: (filename: string) => void;
  readonly removeExistingPath: (relPath: string) => void;
  readonly close: () => Promise<void>;
}

const fakeFsWatcher = (close: () => void): FSWatcher =>
  ({
    close,
  }) as unknown as FSWatcher;

const createWatcherHarness = (existingRelPaths: readonly string[]): WatcherHarness => {
  const vaultRoot = join('/', 'sidetrack-vault-test');
  const events: VaultChangeEvent[] = [];
  const existingAbsolutePaths = new Set(
    existingRelPaths.map((relPath) => join(vaultRoot, relPath)),
  );
  let listener: ((event: string, filename: string | Buffer | null) => void) | undefined;
  const watcher = createVaultWatcher(vaultRoot, {
    debounceMs: 5,
    onChange: (event) => {
      events.push(event);
    },
    statImpl: async (absolutePath) => {
      if (!existingAbsolutePaths.has(absolutePath)) {
        throw new Error(`missing fixture path ${absolutePath}`);
      }
      return { birthtimeMs: 0, mtimeMs: 1 };
    },
    watchImpl: (_path, _options, callback) => {
      listener = callback;
      return fakeFsWatcher(() => undefined);
    },
  });
  return {
    events,
    emit: (filename) => {
      listener?.('change', filename);
    },
    removeExistingPath: (relPath) => {
      existingAbsolutePaths.delete(join(vaultRoot, relPath));
    },
    close: watcher.close,
  };
};

describe('vault watcher', () => {
  it('emits debounced create/modify/delete events with path kind', async () => {
    const relPath = '_BAC/threads/bac_thread_1.json';
    const harness = createWatcherHarness([relPath]);
    try {
      harness.emit('threads/bac_thread_1.json');
      harness.emit('threads/bac_thread_1.json');
      await delay(20);
      harness.removeExistingPath(relPath);
      harness.emit('threads/bac_thread_1.json');
      await delay(20);
    } finally {
      await harness.close();
    }

    expect(harness.events.map((event) => event.kind)).toContain('thread');
    expect(harness.events.map((event) => event.relPath)).toContain(relPath);
    expect(harness.events.some((event) => event.type === 'deleted')).toBe(true);
  });

  it('coalesces noisy connections-store writes into one vault-change event', async () => {
    const harness = createWatcherHarness(['_BAC/connections/']);
    try {
      harness.emit('connections/current.db');
      harness.emit('connections/current.db-wal');
      harness.emit('connections/diagnostics/latest.json');
      await delay(20);
    } finally {
      await harness.close();
    }

    const connectionsEvents = harness.events.filter((event) => event.kind === 'connections');
    expect(connectionsEvents).toHaveLength(1);
    expect(connectionsEvents[0]?.relPath).toBe('_BAC/connections/');
  });
});
