import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export type VaultChangeKind =
  | 'thread'
  | 'workstream'
  | 'dispatch'
  | 'audit'
  | 'annotation'
  | 'recall'
  | 'other';

export interface VaultChangeEvent {
  readonly type: 'created' | 'modified' | 'deleted';
  readonly relPath: string;
  readonly at: string;
  readonly kind: VaultChangeKind;
}

export interface VaultWatcher {
  readonly close: () => Promise<void>;
}

const classifyKind = (relPath: string): VaultChangeKind => {
  const normalized = relPath.split(sep).join('/');
  if (normalized.startsWith('_BAC/threads/')) return 'thread';
  if (normalized.startsWith('_BAC/workstreams/')) return 'workstream';
  if (normalized.startsWith('_BAC/dispatches/')) return 'dispatch';
  if (normalized.startsWith('_BAC/audit/')) return 'audit';
  if (normalized.startsWith('_BAC/annotations/')) return 'annotation';
  if (normalized.startsWith('_BAC/recall/')) return 'recall';
  return 'other';
};

const isHiddenOrRecallIndex = (relPath: string): boolean => {
  const normalized = relPath.split(sep).join('/');
  if (normalized === '_BAC/recall/index.bin') {
    return true;
  }
  return normalized
    .split('/')
    .some((part) => part.length > 1 && part.startsWith('.') && part !== '..');
};

export const createVaultWatcher = (
  vaultRoot: string,
  opts: { readonly debounceMs?: number; readonly onChange: (event: VaultChangeEvent) => void },
): VaultWatcher => {
  const debounceMs = opts.debounceMs ?? 200;
  const timers = new Map<string, NodeJS.Timeout>();
  const emitLater = (relPath: string): void => {
    if (!relPath.startsWith('_BAC') || isHiddenOrRecallIndex(relPath)) {
      return;
    }
    const previous = timers.get(relPath);
    if (previous !== undefined) {
      clearTimeout(previous);
    }
    timers.set(
      relPath,
      setTimeout(() => {
        timers.delete(relPath);
        const absolute = join(vaultRoot, relPath);
        void stat(absolute)
          .then((info) => {
            opts.onChange({
              type: info.birthtimeMs === info.mtimeMs ? 'created' : 'modified',
              relPath,
              at: new Date().toISOString(),
              kind: classifyKind(relPath),
            });
          })
          .catch(() => {
            opts.onChange({
              type: 'deleted',
              relPath,
              at: new Date().toISOString(),
              kind: classifyKind(relPath),
            });
          });
      }, debounceMs),
    );
  };

  const watcher: FSWatcher = watch(join(vaultRoot, '_BAC'), { recursive: true }, (_event, filename) => {
    if (filename === null) {
      return;
    }
    emitLater(relative(vaultRoot, join(vaultRoot, '_BAC', filename)));
  });

  return {
    close() {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      watcher.close();
      return Promise.resolve();
    },
  };
};
