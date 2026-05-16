// Stage 4 — inbox tail loop with hash-recovered bookmark.
//
// Per-collector. Watches _BAC/inbox/<id>/ via fs.watch (200ms debounce)
// + a 60s rescan interval as drop-recovery. Reads the active per-day
// JSONL file from a known byte offset; for each new line, calls the
// injected `onLine` callback (S15 wires materializeCollectorLine in).
//
// Bookmark format (atomic-written to <inboxDir>/.bookmark.json):
//   {
//     "filename":             "2026-05-08.jsonl",
//     "byte_offset":          12345,
//     "line_hash_of_last_promoted": "<sha256-hex|null>",
//     "updated_at":           "<ISO>"
//   }
//
// Recovery semantics:
//   - If the bookmark file is missing → start at offset 0 of today's
//     inbox file.
//   - If bookmark.filename ≠ today's filename → today's file is fresh;
//     start at offset 0. The previous-day file is retired (tail does
//     NOT scan it; replay-on-startup at the framework level handles
//     any tail of yesterday's file via the dedup ledger).
//   - If bookmark.filename matches AND bookmark.byte_offset > size →
//     file rotated/truncated; rescan from offset 0.
//   - Otherwise: resume from byte_offset.
//
// `onLine` is called with the raw JSONL line (no trailing newline).
// Its return value (PromotionResult) drives the bookmark advance:
// promoted/deduped → advance to end-of-line; quarantined → advance
// to end-of-line (the framework writes to quarantine before tail
// hears back, but tail still moves the bookmark).

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, watch, writeFile } from 'node:fs';
import { promises as fsp, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from '../../vault/atomic.js';
import { bookmarkPathFor, inboxDirFor, inboxFileFor } from '../../vault/inbox.js';
import { MAX_RAW_LINE_BYTES, type PromotionResult } from './types.js';

interface Bookmark {
  readonly filename: string;
  readonly byte_offset: number;
  readonly line_hash_of_last_promoted: string | null;
  readonly updated_at: string;
}

export interface TailHandle {
  readonly waitIdle: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface TailOpts {
  readonly vaultRoot: string;
  readonly collectorId: string;
  readonly onLine: (raw: string) => Promise<PromotionResult>;
  readonly auditRoute: (route: string, subject: string) => Promise<void>;
  readonly debounceMs?: number;
  readonly rescanIntervalMs?: number;
  readonly clock?: () => Date;
}

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const todayDateStamp = (clock: () => Date): string => clock().toISOString().slice(0, 10);

const readBookmarkOrDefault = async (path: string): Promise<Bookmark> => {
  try {
    const raw = await fsp.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Bookmark;
    return parsed;
  } catch {
    return {
      filename: '',
      byte_offset: 0,
      line_hash_of_last_promoted: null,
      updated_at: new Date(0).toISOString(),
    };
  }
};

const fileSize = async (path: string): Promise<number> => {
  try {
    const s = await fsp.stat(path);
    return s.size;
  } catch {
    return -1;
  }
};

const splitLinesPreservingTrailing = (
  chunk: string,
): { readonly complete: readonly string[]; readonly trailing: string } => {
  const parts = chunk.split('\n');
  const trailing = parts.pop() ?? '';
  return { complete: parts, trailing };
};

export const startTail = async (opts: TailOpts): Promise<TailHandle> => {
  const { vaultRoot, collectorId, onLine, auditRoute } = opts;
  const debounceMs = opts.debounceMs ?? 200;
  const rescanIntervalMs = opts.rescanIntervalMs ?? 60_000;
  const clock = opts.clock ?? (() => new Date());

  const inboxDir = inboxDirFor(vaultRoot, collectorId);
  const bookmarkPath = bookmarkPathFor(vaultRoot, collectorId);
  await fsp.mkdir(inboxDir, { recursive: true });

  let bookmark: Bookmark = await readBookmarkOrDefault(bookmarkPath);

  // ── per-tick state ────────────────────────────────────────────────
  let processing = Promise.resolve();
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let watcher: FSWatcher | null = null;
  let rescanTimer: ReturnType<typeof setInterval> | null = null;

  const idleResolvers: (() => void)[] = [];
  const flushIdle = (): void => {
    while (idleResolvers.length > 0) {
      const resolve = idleResolvers.shift();
      if (resolve !== undefined) resolve();
    }
  };

  const persistBookmark = async (next: Bookmark): Promise<void> => {
    bookmark = next;
    await writeJsonAtomic(bookmarkPath, bookmark);
    await auditRoute('collector:bookmark-advanced', `${collectorId}:${String(next.byte_offset)}`);
  };

  const processNewBytes = async (): Promise<void> => {
    const today = todayDateStamp(clock);
    const todayPath = inboxFileFor(vaultRoot, collectorId, today);
    const size = await fileSize(todayPath);
    if (size < 0) return;

    let resumeOffset: number;
    if (bookmark.filename !== today) {
      resumeOffset = 0;
    } else if (bookmark.byte_offset > size) {
      resumeOffset = 0;
    } else {
      resumeOffset = bookmark.byte_offset;
    }

    if (resumeOffset >= size) return;

    const fileBuffer = await fsp.readFile(todayPath);
    const tailBuffer = fileBuffer.subarray(resumeOffset);
    const tailString = tailBuffer.toString('utf8');
    const { complete, trailing } = splitLinesPreservingTrailing(tailString);

    let cursor = resumeOffset;
    let lastLineHash: string | null = bookmark.line_hash_of_last_promoted;
    for (const line of complete) {
      // \n consumed.
      const consumed = Buffer.byteLength(line, 'utf8') + 1;
      if (line.length === 0) {
        cursor += consumed;
        continue;
      }
      // Safety cap: route oversized lines to a dedicated audit
      // subtype so observers can spot pathological producers without
      // grepping the full quarantine reason set. The choke point
      // still applies its own MAX_RAW_LINE_BYTES guard, but emitting
      // line-too-large here makes the audit trail explicit at the
      // tail boundary.
      if (Buffer.byteLength(line, 'utf8') > MAX_RAW_LINE_BYTES) {
        await auditRoute('collector:line-too-large', `${collectorId}:${String(cursor)}`);
      }
      await auditRoute('collector:line-read', `${collectorId}:${String(cursor)}`);
      try {
        const result = await onLine(line);
        switch (result.kind) {
          case 'promoted':
          case 'deduped':
          case 'quarantined':
          case 'dropped': {
            cursor += consumed;
            lastLineHash = sha256Hex(line);
            break;
          }
          default: {
            // Should never reach.
            cursor += consumed;
            break;
          }
        }
      } catch {
        // onLine errors should not stall the tail; treat the line as
        // malformed for bookmark purposes (advance) and audit.
        await auditRoute('collector:line-malformed', `${collectorId}:${String(cursor)}`);
        cursor += consumed;
      }
    }

    // `trailing` is a partial line — leave the bookmark BEFORE it so
    // the next read sees the whole line.
    void trailing;

    await persistBookmark({
      filename: today,
      byte_offset: cursor,
      line_hash_of_last_promoted: lastLineHash,
      updated_at: clock().toISOString(),
    });
  };

  const enqueueProcess = (): void => {
    if (closed) return;
    processing = processing
      .then(processNewBytes)
      .then(flushIdle)
      .catch(() => {
        flushIdle();
      });
  };

  const scheduleProcess = (): void => {
    if (closed) return;
    if (scheduledTimer !== null) clearTimeout(scheduledTimer);
    scheduledTimer = setTimeout(() => {
      scheduledTimer = null;
      enqueueProcess();
    }, debounceMs);
  };

  // Initial scan.
  enqueueProcess();

  // fs.watch on inbox dir.
  try {
    watcher = watch(inboxDir, { recursive: false }, (_event, filename) => {
      if (filename === null) return;
      // Only react to today's file.
      const today = todayDateStamp(clock);
      if (String(filename) !== `${today}.jsonl`) return;
      scheduleProcess();
    });
  } catch {
    // fs.watch may fail on some filesystems; the rescan interval is
    // the safety net.
    watcher = null;
  }

  rescanTimer = setInterval(() => {
    if (!closed) enqueueProcess();
  }, rescanIntervalMs);

  return {
    async waitIdle() {
      // Drain any pending debounce timer first.
      if (scheduledTimer !== null) {
        clearTimeout(scheduledTimer);
        scheduledTimer = null;
      }
      // Always force an unconditional rescan so any bytes that
      // landed via writeTickBatch (or any producer) BEFORE fs.watch
      // delivered its notification still get processed. Without
      // this, waitIdle returns "no work pending" while the OS has
      // bytes queued for the watcher's dispatch.
      enqueueProcess();
      await processing;
      // One more pass in case enqueueProcess fired processing while
      // we awaited (chained file growth on macOS APFS).
      enqueueProcess();
      await processing;
    },
    async close() {
      closed = true;
      if (scheduledTimer !== null) {
        clearTimeout(scheduledTimer);
        scheduledTimer = null;
      }
      if (rescanTimer !== null) {
        clearInterval(rescanTimer);
        rescanTimer = null;
      }
      if (watcher !== null) {
        watcher.close();
        watcher = null;
      }
      await processing;
    },
  };
};

// Helpers exported for tests.
export const _internalForTesting = {
  sha256Hex,
  todayDateStamp,
};

// keep these to suppress unused-import warnings
export const _readFileShim = readFile;
export const _writeFileShim = writeFile;
export const _statShim = stat;
export const _mkdirShim = mkdir;
