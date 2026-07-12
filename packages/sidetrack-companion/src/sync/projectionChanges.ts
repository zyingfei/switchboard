import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
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
// The JSONL grows over time. Rotation/pruning of sealed lines is left
// as a future optimisation (see the followups) — no rotation discipline
// exists on this feed yet, so this module only CURSOR-SKIPS already-read
// lines rather than deleting them.
//
// Read fast path: readSince previously read + JSON.parsed the ENTIRE
// file on every /changes poll — an O(total-history) cost on a hot polled
// endpoint that grows one line per projection change forever. It now
// keeps an in-memory byte-offset checkpoint {scannedBytes, maxScannedSeq}
// advanced past every line it has parsed. A steady-state poll (the
// browser resuming from the cursor it was just handed, i.e.
// sinceSeq >= maxScannedSeq) seeks to the checkpoint and parses ONLY the
// appended tail — every earlier line has seq <= maxScannedSeq <=
// sinceSeq and would be filtered out anyway. The public readSince(token)
// contract is unchanged: an older cursor, or a truncated/replaced file,
// transparently falls back to a full scan and re-seeds the checkpoint.

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
  /**
   * Test-only observability: total number of JSONL lines this feed has
   * PARSED across all readSince calls. The cursor fast path exists to
   * keep this from growing with total history on steady-state polls —
   * a test asserts a second poll parses only the newly appended lines.
   */
  readonly __parsedLineCount: () => number;
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

  // Byte-offset read checkpoint. `scannedBytes` is the offset of the end
  // of the last fully-parsed line; `maxScannedSeq` is the highest seq
  // seen at or before that offset. A poll with sinceSeq >= maxScannedSeq
  // only needs the tail past scannedBytes. Reset (to 0/0) whenever the
  // file shrinks or is replaced, forcing a safe full re-scan.
  let scannedBytes = 0;
  let maxScannedSeq = 0;
  // Test-only: total JSONL lines parsed across all readSince calls.
  let parsedLineCount = 0;

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

  // Parse a UTF-8 chunk that starts on a line boundary. Returns the
  // matching changes (seq > sinceSeq), how many bytes were consumed up
  // to the last COMPLETE line (a trailing partial line, if any, is left
  // for a future read), and the max seq observed in the chunk.
  const parseChunk = (
    chunk: string,
    sinceSeq: number,
  ): { changes: ProjectionChange[]; consumedBytes: number; maxSeq: number } => {
    const changes: ProjectionChange[] = [];
    let maxSeq = 0;
    // Only whole lines (terminated by \n) are complete; anything after
    // the last \n is a partial tail we must not consume.
    const lastNl = chunk.lastIndexOf('\n');
    const complete = lastNl < 0 ? '' : chunk.slice(0, lastNl + 1);
    const consumedBytes = Buffer.byteLength(complete, 'utf8');
    for (const line of complete.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      parsedLineCount += 1;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isProjectionChange(parsed)) {
          if (parsed.seq > maxSeq) maxSeq = parsed.seq;
          if (parsed.seq > sinceSeq) changes.push(parsed);
        }
      } catch {
        // Tolerate malformed lines.
      }
    }
    return { changes, consumedBytes, maxSeq };
  };

  // Serialised through the same chain as appendChange so the checkpoint
  // is never advanced against a mid-append file and never races a
  // concurrent poll.
  const readSince = (
    sinceSeq: number,
  ): Promise<{ readonly cursor: number; readonly changed: readonly ProjectionChange[] }> =>
    enqueue(async () => {
      const path = logPath(vaultPath);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          scannedBytes = 0;
          maxScannedSeq = 0;
          return { cursor: await ensureSeqLoaded(), changed: [] };
        }
        throw error;
      }

      // File shrank or was replaced (rotation/truncation/fresh vault):
      // the checkpoint is no longer valid — re-scan from the start.
      if (size < scannedBytes) {
        scannedBytes = 0;
        maxScannedSeq = 0;
      }

      // Fast path: the caller resumes from at-or-after everything we have
      // already parsed, so every matching line lives strictly in the
      // appended tail. Read only [scannedBytes, size) — never the prefix.
      const canResume = sinceSeq >= maxScannedSeq && scannedBytes > 0;
      const startOffset = canResume ? scannedBytes : 0;

      if (startOffset >= size) {
        // Nothing new since the checkpoint.
        return { cursor: sinceSeq, changed: [] };
      }

      const length = size - startOffset;
      const buffer = Buffer.alloc(length);
      const handle = await open(path, 'r');
      try {
        await handle.read(buffer, 0, length, startOffset);
      } finally {
        await handle.close();
      }
      const chunk = buffer.toString('utf8');
      const { changes, consumedBytes, maxSeq } = parseChunk(chunk, sinceSeq);

      // Advance the checkpoint past the completely-parsed bytes. On the
      // full-scan path startOffset is 0; on the resume path we extend the
      // prior checkpoint. maxScannedSeq only ever moves forward.
      const newScanned = startOffset + consumedBytes;
      if (newScanned > scannedBytes) scannedBytes = newScanned;
      if (maxSeq > maxScannedSeq) maxScannedSeq = maxSeq;

      changes.sort((a, b) => a.seq - b.seq);
      const lastChange = changes.at(-1);
      const cursor = lastChange === undefined ? sinceSeq : lastChange.seq;
      return { cursor, changed: changes };
    });

  return { appendChange, readSince, __parsedLineCount: () => parsedLineCount };
};
