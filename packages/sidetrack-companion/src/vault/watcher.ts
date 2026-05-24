import { watch, type FSWatcher, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export type VaultChangeKind =
  | 'thread'
  | 'workstream'
  | 'dispatch'
  | 'audit'
  | 'annotation'
  | 'recall'
  | 'connections'
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

type WatchFilename = string | Buffer | null;
type VaultWatchFactory = (
  path: string,
  options: { readonly recursive: true },
  listener: (event: string, filename: WatchFilename) => void,
) => FSWatcher;
type VaultStat = (path: string) => Promise<Pick<Stats, 'birthtimeMs' | 'mtimeMs'>>;

interface VaultWatcherOptions {
  readonly debounceMs?: number;
  readonly onChange: (event: VaultChangeEvent) => void;
  readonly watchImpl?: VaultWatchFactory;
  readonly statImpl?: VaultStat;
}

const defaultWatch: VaultWatchFactory = (path, options, listener) => watch(path, options, listener);
const defaultStat: VaultStat = (path) => stat(path);

const normalizeRelPath = (relPath: string): string => relPath.split(sep).join('/');

const coalesceObservableRelPath = (relPath: string): string => {
  const normalized = normalizeRelPath(relPath);
  if (normalized === '_BAC/connections' || normalized.startsWith('_BAC/connections/')) {
    return '_BAC/connections/';
  }
  return normalized;
};

const classifyKind = (relPath: string): VaultChangeKind => {
  const normalized = normalizeRelPath(relPath);
  if (normalized.startsWith('_BAC/threads/')) return 'thread';
  if (normalized.startsWith('_BAC/workstreams/')) return 'workstream';
  if (normalized.startsWith('_BAC/dispatches/')) return 'dispatch';
  if (normalized.startsWith('_BAC/audit/')) return 'audit';
  if (normalized.startsWith('_BAC/annotations/')) return 'annotation';
  if (normalized.startsWith('_BAC/recall/')) return 'recall';
  if (normalized === '_BAC/connections' || normalized.startsWith('_BAC/connections/')) {
    return 'connections';
  }
  return 'other';
};

const isHiddenOrRecallIndex = (relPath: string): boolean => {
  const normalized = normalizeRelPath(relPath);
  if (normalized === '_BAC/recall/index.bin') {
    return true;
  }
  return normalized
    .split('/')
    .some((part) => part.length > 1 && part.startsWith('.') && part !== '..');
};

export const createVaultWatcher = (
  vaultRoot: string,
  opts: VaultWatcherOptions,
): VaultWatcher => {
  const debounceMs = opts.debounceMs ?? 200;
  const watchImpl = opts.watchImpl ?? defaultWatch;
  const statImpl = opts.statImpl ?? defaultStat;
  const timers = new Map<string, NodeJS.Timeout>();
  const emitLater = (relPath: string): void => {
    const normalized = normalizeRelPath(relPath);
    if (!normalized.startsWith('_BAC') || isHiddenOrRecallIndex(normalized)) {
      return;
    }
    const observableRelPath = coalesceObservableRelPath(normalized);
    const previous = timers.get(observableRelPath);
    if (previous !== undefined) {
      clearTimeout(previous);
    }
    timers.set(
      observableRelPath,
      setTimeout(() => {
        timers.delete(observableRelPath);
        const absolute = join(vaultRoot, observableRelPath);
        void statImpl(absolute)
          .then((info) => {
            opts.onChange({
              type: info.birthtimeMs === info.mtimeMs ? 'created' : 'modified',
              relPath: observableRelPath,
              at: new Date().toISOString(),
              kind: classifyKind(observableRelPath),
            });
          })
          .catch(() => {
            opts.onChange({
              type: 'deleted',
              relPath: observableRelPath,
              at: new Date().toISOString(),
              kind: classifyKind(observableRelPath),
            });
          });
      }, debounceMs),
    );
  };

  const watcher: FSWatcher = watchImpl(
    join(vaultRoot, '_BAC'),
    { recursive: true },
    (_event, filename) => {
      if (filename === null) {
        return;
      }
      const filenameText = typeof filename === 'string' ? filename : filename.toString('utf8');
      emitLater(relative(vaultRoot, join(vaultRoot, '_BAC', filenameText)));
    },
  );

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
