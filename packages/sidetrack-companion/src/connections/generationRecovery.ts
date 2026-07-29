// Generation-swap recovery counters — make a handle that outlived its file
// RECOVERABLE instead of fatal, and make the recovery loud.
//
// WHY THIS EXISTS (live incident, 2026-07-29). Health showed
// `sync.materializers.connections {status:'failed', lastError:'disk I/O error',
// pending:true}` recurring AFTER successful drains, with both current.db and
// resolver-cache.db passing `PRAGMA quick_check` and 20GB free — so neither
// corruption nor space. bun:sqlite throws exactly the string "disk I/O error"
// when a handle's underlying file has been unlinked or rename-swapped out from
// under it (SQLITE_IOERR_VNODE on APFS; the vnode is detached, not the POSIX
// "unlinked inode stays alive" behaviour). That is precisely what the M4
// double-buffer publish does to a generation it GCs.
//
// The structural cause is fixed in generationBuffer.ts (cross-process in-flight
// shadow markers). This module covers the RESIDUAL: a reader whose generation
// was legitimately collected after it moved past it, or any future publish path
// that reintroduces the window. A read against a vanished generation is
// recoverable by construction — the pointer names a NEWER, complete generation,
// so dropping the dead handle, reopening on the pointer and re-running the read
// returns fresher-but-valid data. Retrying is therefore safe in a way that
// retrying a corrupted db never would be, which is why the predicate below is
// deliberately narrow.
//
// Deliberately tiny and dependency-free, mirroring drainDegradation.ts:
// process-lifetime counters plus the last error, surfaced through health so the
// degradation reports itself. It records; it never decides. Absent == zero.

/** Message bun:sqlite raises when a handle's file was unlinked/swapped. */
const VANISHED_MESSAGE = 'disk I/O error';

export interface GenerationRecoverySnapshot {
  /**
   * Reads that hit "disk I/O error" on a swapped-out generation and SUCCEEDED
   * after a reopen-and-retry. Non-zero means the publish/GC protocol collected
   * a generation a reader still held — recovered, but the window is real.
   */
  readonly recoveredReads: number;
  /**
   * Reads that hit it and still failed on the retry (the error was propagated).
   * Non-zero is a genuine defect: the pointer did not name a readable
   * generation even after a reopen.
   */
  readonly unrecoveredReads: number;
  /** Message of the most recent vanished-generation error, truncated. */
  readonly lastError: string | undefined;
  /** Epoch ms of the most recent vanished-generation error, or undefined. */
  readonly lastErrorAtMs: number | undefined;
}

const MAX_ERROR_CHARS = 240;

const state = {
  recoveredReads: 0,
  unrecoveredReads: 0,
  lastError: undefined as string | undefined,
  lastErrorAtMs: undefined as number | undefined,
};

/**
 * Is this the "my generation file is gone" error?
 *
 * NARROW ON PURPOSE. It matches only the vanished-vnode signature, never a
 * generic I/O failure class: the caller's response is to RETRY, and retrying a
 * read against genuinely failing storage would turn a hard failure into a spin.
 * SQLITE_IOERR sub-codes are not exposed by bun:sqlite, so the message is the
 * only discriminator available — the same constraint the lock-error predicates
 * in snapshot.ts / connectionsMaterializer.ts already live with.
 */
export const isGenerationVanishedError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return String(error).includes(VANISHED_MESSAGE);
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(VANISHED_MESSAGE);
};

const record = (error: unknown, nowMs: number): void => {
  const message = error instanceof Error ? error.message : String(error);
  state.lastError = message.slice(0, MAX_ERROR_CHARS);
  state.lastErrorAtMs = nowMs;
};

/** A read hit a vanished generation and the reopen-and-retry succeeded. */
export const recordGenerationRecovered = (error: unknown, nowMs: number = Date.now()): void => {
  state.recoveredReads += 1;
  record(error, nowMs);
};

/** A read hit a vanished generation and STILL failed after the retry. */
export const recordGenerationUnrecovered = (error: unknown, nowMs: number = Date.now()): void => {
  state.unrecoveredReads += 1;
  record(error, nowMs);
};

export const getGenerationRecovery = (): GenerationRecoverySnapshot => ({
  recoveredReads: state.recoveredReads,
  unrecoveredReads: state.unrecoveredReads,
  lastError: state.lastError,
  lastErrorAtMs: state.lastErrorAtMs,
});

/** Test seam — reset counters between cases. */
export const resetGenerationRecovery = (): void => {
  state.recoveredReads = 0;
  state.unrecoveredReads = 0;
  state.lastError = undefined;
  state.lastErrorAtMs = undefined;
};
