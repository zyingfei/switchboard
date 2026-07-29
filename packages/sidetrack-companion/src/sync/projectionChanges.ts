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
// ROTATION (2026-07-29). The JSONL used to grow forever: MEASURED at 98.6 MB
// on the dogfood vault, the third-largest object in a 2.9 GB vault and the
// largest with NO retention policy at all. The module previously only
// CURSOR-SKIPPED read lines. It now rotates, mirroring
// tabsession/lanePrequential.ts: at a byte cap, `rename(live, live + '.1')`,
// keeping exactly ONE prior generation which the reader still reads. Cap from
// SIDETRACK_SYNC_CHANGELOG_MAX_BYTES (default 32 MB), so steady-state disk is
// bounded at ~2x the cap instead of unbounded.
//
// THREE THINGS ROTATION MUST NOT BREAK, all handled below:
//   1. THE SEQ HIGH-WATER. `projection-changes-seq` is written atomically on
//      every append and is authoritative; ensureSeqLoaded takes the MAX of it
//      and the logged max, so losing log lines can never rewind the counter
//      (a rewind would re-issue a seq and silently strand every client cursor).
//      Rotation deliberately never touches that file.
//   2. THE BYTE CHECKPOINT. readSince keeps an in-memory {scannedBytes,
//      maxScannedSeq} offset into the LIVE file. Its only invalidation was
//      `size < scannedBytes` — a shrink. That is NOT sufficient across a
//      rename: if the fresh live file grew back past the old offset before the
//      next poll, the resume path would seek to a stale mid-line offset in a
//      DIFFERENT file and silently mangle/drop lines. So rotation resets the
//      checkpoint explicitly, inside the same `enqueue` chain that serialises
//      appends and reads — there is no window in which a reader can observe
//      the rename without the reset.
//   3. GAP HONESTY. A client resuming from a cursor whose lines were rotated
//      away gets a silent hole: readSince can only return what is retained.
//      One rotated generation is kept and READ, so a gap needs two rotations
//      past the client's cursor — but "unlikely" is not "impossible", so the
//      generation that gets clobbered has its high-water recorded in
//      `projection-changes-floor` and surfaced as `retainedFromSeq`. A caller
//      with sinceSeq < retainedFromSeq now KNOWS it must full-resync instead
//      of believing an incomplete answer.
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
/** One rotated generation, `.1` — same convention as lanePrequential. A plain
 *  rename onto this name CLOBBERS the previous one, which is how "exactly one
 *  prior generation" is enforced without any bookkeeping. */
const ROTATED_LOG_FILE = `${LOG_FILE}.1`;
/** Lowest seq still retained after a clobbering rotation (see note 3 above). */
const FLOOR_FILE = 'projection-changes-floor';

const syncDir = (vaultPath: string): string => join(vaultPath, ...SYNC_DIR_SEGMENTS);
const seqPath = (vaultPath: string): string => join(syncDir(vaultPath), SEQ_FILE);
const logPath = (vaultPath: string): string => join(syncDir(vaultPath), LOG_FILE);
export const rotatedLogPath = (vaultPath: string): string =>
  join(syncDir(vaultPath), ROTATED_LOG_FILE);
const floorPath = (vaultPath: string): string => join(syncDir(vaultPath), FLOOR_FILE);

/**
 * Byte cap on the LIVE changelog. 32 MB default: the measured 98.6 MB file was
 * ~460k lines, so 32 MB still retains ~150k changes per generation (~300k
 * across both) — orders of magnitude more than any client cursor lag, while
 * bounding cold-start `readMaxLoggedSeq` (which parses the whole file once per
 * process) to a 2x-cap read instead of an unbounded one.
 *
 * Only a positive finite override is honoured; a garbage value falls back to
 * the default rather than disabling rotation by accident. Set it very large to
 * effectively disable rotation — this is a retention knob, not a kill switch,
 * because the rotation itself deletes only the SECOND-oldest generation and
 * readers are taught to read both.
 */
export const SYNC_CHANGELOG_MAX_BYTES_DEFAULT = 32 * 1024 * 1024;

export const syncChangelogMaxBytes = (): number => {
  const raw = process.env['SIDETRACK_SYNC_CHANGELOG_MAX_BYTES'];
  if (raw === undefined) return SYNC_CHANGELOG_MAX_BYTES_DEFAULT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SYNC_CHANGELOG_MAX_BYTES_DEFAULT;
};

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

export interface ReadSinceResult {
  readonly cursor: number;
  readonly changed: readonly ProjectionChange[];
  /**
   * Lowest seq the feed can still serve. 0 means nothing has ever been rotated
   * away (the whole history is retained). A caller whose `sinceSeq` is BELOW
   * this lost lines to rotation and must full-resync from the projection dir
   * rather than trust `changed` to be complete.
   */
  readonly retainedFromSeq: number;
}

export interface ProjectionChangeFeed {
  readonly appendChange: (input: AppendChangeInput) => Promise<ProjectionChange>;
  readonly readSince: (sinceSeq: number) => Promise<ReadSinceResult>;
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
  // Retained floor (see header note 3). null = not yet read from disk; 0 = read
  // and nothing has ever been rotated away. Typed emptiness, not a sentinel.
  let cachedFloor: number | null = null;
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
    // Read BOTH generations' logged max, not just the live one: after a
    // rotation the live file can be a few lines long while the rotated
    // generation holds the real high-water. The persisted seq file is
    // authoritative in practice; this is the belt for a vault where it is
    // missing or corrupt, and it must not rewind across a rotation.
    const [storedSeq, loggedSeq, rotatedSeq] = await Promise.all([
      readSeq(seqPath(vaultPath)),
      readMaxLoggedSeq(logPath(vaultPath)),
      readMaxLoggedSeq(rotatedLogPath(vaultPath)),
    ]);
    cachedSeq = Math.max(storedSeq, loggedSeq, rotatedSeq);
    return cachedSeq;
  };

  const ensureFloorLoaded = async (): Promise<number> => {
    if (cachedFloor !== null) return cachedFloor;
    cachedFloor = await readSeq(floorPath(vaultPath));
    return cachedFloor;
  };

  /**
   * Rotate the live log if it is at/over the cap. Runs INSIDE the enqueue chain
   * (called only from appendChange) so no reader can observe the rename without
   * the checkpoint reset that follows it.
   *
   * Rotate BEFORE appending, like lanePrequential, so the cap is a real ceiling
   * on the live file rather than "the cap plus whatever the last batch was".
   * Best-effort: a failed rename degrades to an over-cap append, never a lost
   * change — the changelog's job is to not lose lines, and a rotation that
   * cannot happen is strictly less bad than an append that does not.
   */
  const rotateIfNeeded = async (): Promise<void> => {
    const live = logPath(vaultPath);
    const info = await stat(live).catch(() => null);
    if (info === null || info.size < syncChangelogMaxBytes()) return;
    // The generation currently at `.1` is about to be CLOBBERED by this
    // rename, so its high-water becomes the retained floor. Read it before the
    // rename (bounded by the cap; happens once per cap's worth of appends).
    const doomed = await readMaxLoggedSeq(rotatedLogPath(vaultPath));
    try {
      await rename(live, rotatedLogPath(vaultPath));
    } catch {
      return; // over-cap append is fine; try again next time
    }
    if (doomed > 0) {
      cachedFloor = doomed;
      // Best-effort persist: an unwritten floor understates what was lost,
      // which is why the in-memory value is set first (this process stays
      // honest even if the write fails).
      await writeAtomic(floorPath(vaultPath), `${String(doomed)}\n`).catch(() => undefined);
    }
    // See note 2 in the header: a shrink check alone cannot detect a rename,
    // so invalidate the byte checkpoint explicitly.
    scannedBytes = 0;
    maxScannedSeq = 0;
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
      await rotateIfNeeded();
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
  const readSince = (sinceSeq: number): Promise<ReadSinceResult> =>
    enqueue(async () => {
      const retainedFromSeq = await ensureFloorLoaded();
      const path = logPath(vaultPath);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          scannedBytes = 0;
          maxScannedSeq = 0;
          return { cursor: await ensureSeqLoaded(), changed: [], retainedFromSeq };
        }
        throw error;
      }

      // File shrank or was replaced (truncation/fresh vault): the checkpoint is
      // no longer valid — re-scan from the start. Rotation ALSO invalidates it,
      // but rotateIfNeeded resets it directly rather than relying on this check
      // (a rename need not shrink the file the next poll observes).
      if (size < scannedBytes) {
        scannedBytes = 0;
        maxScannedSeq = 0;
      }

      // Fast path: the caller resumes from at-or-after everything we have
      // already parsed, so every matching line lives strictly in the
      // appended tail. Read only [scannedBytes, size) — never the prefix.
      const canResume = sinceSeq >= maxScannedSeq && scannedBytes > 0;
      const startOffset = canResume ? scannedBytes : 0;

      // THE ROTATED GENERATION. Read it only on the FULL-SCAN path, and this is
      // sound for exactly the reason the byte checkpoint is sound: on the resume
      // path every rotated line has seq <= maxScannedSeq <= sinceSeq, so it
      // would be filtered out anyway. A cold start or an old cursor takes the
      // full-scan path, and that is precisely when the prefix matters — so "the
      // reader reads both generations" holds whenever it can change an answer,
      // without paying for the prefix on the hot steady-state poll.
      const rotatedChanges = canResume
        ? []
        : await readRotatedChanges(rotatedLogPath(vaultPath), sinceSeq);

      if (startOffset >= size) {
        // Nothing new in the live file since the checkpoint — but a rotated
        // prefix read above can still carry matches on the full-scan path.
        return finishRead(rotatedChanges, sinceSeq, retainedFromSeq);
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

      return finishRead([...rotatedChanges, ...changes], sinceSeq, retainedFromSeq);
    });

  /** Parse the rotated generation in full (only ever on the full-scan path).
   *  Bounded by the byte cap, so this is a ≤32 MB read, not an unbounded one. */
  const readRotatedChanges = async (
    path: string,
    sinceSeq: number,
  ): Promise<readonly ProjectionChange[]> => {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return []; // no rotated generation yet — the common case
    }
    return parseChunk(raw, sinceSeq).changes;
  };

  const finishRead = (
    changes: readonly ProjectionChange[],
    sinceSeq: number,
    retainedFromSeq: number,
  ): ReadSinceResult => {
    const sorted = [...changes].sort((a, b) => a.seq - b.seq);
    const lastChange = sorted.at(-1);
    return {
      cursor: lastChange === undefined ? sinceSeq : lastChange.seq,
      changed: sorted,
      retainedFromSeq,
    };
  };

  return { appendChange, readSince, __parsedLineCount: () => parsedLineCount };
};
