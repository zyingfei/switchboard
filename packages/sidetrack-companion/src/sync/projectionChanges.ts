import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { VersionVector } from './causal.js';

// Local monotonic change feed for projections.
//
// Browsers poll the companion for "what's new since I last synced"
// and need a cursor that survives clock skew. Earlier the cursor was
// `updatedAtMs` (max projection acceptedAtMs), but `acceptedAtMs`
// reflects the SOURCE host's clock — a peer with a fast clock would
// land a future-stamped event, the browser would store
// `since=<future-ms>`, and subsequent normal-time edits would be
// filtered out as "older than cursor."
//
// The fix is a per-companion monotonic counter incremented every
// time a projection changes locally (regardless of whose event
// caused the change). The counter is dense, deterministic on this
// host, and never moves backward — so a browser that resumes from
// `sinceSeq=N` always sees the next changes.
//
// Storage:
//   _BAC/.sync/projection-changes-seq     single integer (max seq)
//   _BAC/.sync/projection-changes.jsonl   one JSON line per change
//
// The JSONL grows over time; pruning is left as a future
// optimisation (we'll snapshot once per day and drop older lines).

const SYNC_DIR_SEGMENTS = ['_BAC', '.sync'] as const;
const SEQ_FILE = 'projection-changes-seq';
const LOG_FILE = 'projection-changes.jsonl';

const syncDir = (vaultPath: string): string => join(vaultPath, ...SYNC_DIR_SEGMENTS);
const seqPath = (vaultPath: string): string => join(syncDir(vaultPath), SEQ_FILE);
const logPath = (vaultPath: string): string => join(syncDir(vaultPath), LOG_FILE);

export type ProjectionChangeKind = 'upsert' | 'delete';

export interface ProjectionChange {
  readonly seq: number;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly relPath: string;
  readonly vector: VersionVector;
  readonly kind: ProjectionChangeKind;
  readonly localWrittenAtMs: number;
}

export interface AppendChangeInput {
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly relPath: string;
  readonly vector: VersionVector;
  readonly kind: ProjectionChangeKind;
}

export interface ProjectionChangeFeed {
  readonly appendChange: (input: AppendChangeInput) => Promise<ProjectionChange>;
  readonly readSince: (
    sinceSeq: number,
  ) => Promise<{ readonly cursor: number; readonly changed: readonly ProjectionChange[] }>;
}

const writeAtomic = async (path: string, body: string): Promise<void> => {
  const tmp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
};

const readSeq = async (path: string): Promise<number> => {
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
    throw error;
  }
};

const isProjectionChange = (value: unknown): value is ProjectionChange => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['seq'] === 'number' &&
    typeof v['aggregate'] === 'string' &&
    typeof v['aggregateId'] === 'string' &&
    typeof v['relPath'] === 'string' &&
    typeof v['vector'] === 'object' &&
    v['vector'] !== null &&
    (v['kind'] === 'upsert' || v['kind'] === 'delete') &&
    typeof v['localWrittenAtMs'] === 'number'
  );
};

const readMaxLoggedSeq = async (path: string): Promise<number> => {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
    throw error;
  }

  let maxSeq = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isProjectionChange(parsed)) {
        maxSeq = Math.max(maxSeq, parsed.seq);
      }
    } catch {
      // Tolerate malformed lines; readSince does the same.
    }
  }
  return maxSeq;
};

export const createProjectionChangeFeed = (
  vaultPath: string,
  options: { readonly now?: () => number } = {},
): ProjectionChangeFeed => {
  const now = options.now ?? Date.now;
  let cachedSeq: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const ensureSeqLoaded = async (): Promise<number> => {
    if (cachedSeq !== null) return cachedSeq;
    const [storedSeq, loggedSeq] = await Promise.all([
      readSeq(seqPath(vaultPath)),
      readMaxLoggedSeq(logPath(vaultPath)),
    ]);
    cachedSeq = Math.max(storedSeq, loggedSeq);
    return cachedSeq;
  };

  const appendChange = (input: AppendChangeInput): Promise<ProjectionChange> =>
    enqueue(async () => {
      const seq = (await ensureSeqLoaded()) + 1;
      const change: ProjectionChange = {
        seq,
        aggregate: input.aggregate,
        aggregateId: input.aggregateId,
        relPath: input.relPath,
        vector: input.vector,
        kind: input.kind,
        localWrittenAtMs: now(),
      };
      await mkdir(syncDir(vaultPath), { recursive: true });
      await writeFile(logPath(vaultPath), `${JSON.stringify(change)}\n`, {
        encoding: 'utf8',
        flag: 'a',
      });
      // Persist the new high-water mark BEFORE returning, so a crash
      // mid-append can never hand out the same seq twice.
      await writeAtomic(seqPath(vaultPath), `${String(seq)}\n`);
      cachedSeq = seq;
      return change;
    });

  const readSince = async (
    sinceSeq: number,
  ): Promise<{ readonly cursor: number; readonly changed: readonly ProjectionChange[] }> => {
    let raw: string;
    try {
      raw = await readFile(logPath(vaultPath), 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { cursor: await ensureSeqLoaded(), changed: [] };
      }
      throw error;
    }
    const changes: ProjectionChange[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isProjectionChange(parsed) && parsed.seq > sinceSeq) {
          changes.push(parsed);
        }
      } catch {
        // Tolerate malformed lines.
      }
    }
    changes.sort((a, b) => a.seq - b.seq);
    const lastChange = changes.at(-1);
    const cursor = lastChange === undefined ? sinceSeq : lastChange.seq;
    return { cursor, changed: changes };
  };

  return { appendChange, readSince };
};
