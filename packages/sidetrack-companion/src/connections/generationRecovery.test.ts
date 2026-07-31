import { beforeEach, describe, expect, it } from 'bun:test';

import {
  getGenerationRecovery,
  isGenerationVanishedError,
  recordGenerationRecovered,
  recordGenerationUnrecovered,
  resetGenerationRecovery,
} from './generationRecovery.js';

// These counters exist because the failure they track was INDISTINGUISHABLE
// from corruption: `sync.materializers.connections {status:'failed',
// lastError:'disk I/O error'}` recurred after successful drains while both dbs
// passed `PRAGMA quick_check` with 20GB free. bun:sqlite raises exactly that
// string when a handle's generation file was unlinked/rename-swapped, and
// nothing in the stack classified it, so nothing retried it.

describe('generation-vanished predicate', () => {
  it('matches bun:sqlite\'s unlinked/swapped-generation message', () => {
    expect(isGenerationVanishedError(new Error('disk I/O error'))).toBe(true);
    // Real bun:sqlite errors carry a prefix/suffix around the message.
    expect(isGenerationVanishedError(new Error('SQLiteError: disk I/O error'))).toBe(true);
    // Non-Error throws still classify (the same tolerance the lock-error
    // predicates in snapshot.ts / connectionsMaterializer.ts already have).
    expect(isGenerationVanishedError('disk I/O error')).toBe(true);
  });

  it('does NOT match the neighbouring failure classes it must not retry', () => {
    // A lock is handled by busy_timeout + the existing lock predicates; a
    // retry here would double-count and mask that path.
    expect(isGenerationVanishedError(new Error('database is locked'))).toBe(false);
    // Corruption is NOT recoverable by reopening — retrying would spin.
    expect(isGenerationVanishedError(new Error('database disk image is malformed'))).toBe(false);
    // A missing file at open time is a different (non-retryable) shape.
    expect(isGenerationVanishedError(new Error('unable to open database file'))).toBe(false);
    // Schema errors come from reading a half-built shadow, not a vanished one.
    expect(isGenerationVanishedError(new Error('no such table: metadata'))).toBe(false);
    expect(isGenerationVanishedError(null)).toBe(false);
  });
});

describe('generation recovery counters', () => {
  beforeEach(() => {
    resetGenerationRecovery();
  });

  it('starts at zero with no error (absent == zero, never "unknown")', () => {
    const snap = getGenerationRecovery();
    expect(snap.recoveredReads).toBe(0);
    expect(snap.unrecoveredReads).toBe(0);
    expect(snap.lastError).toBeUndefined();
    expect(snap.lastErrorAtMs).toBeUndefined();
  });

  it('counts recovered and unrecovered reads separately', () => {
    // The split matters operationally: recovered==N/unrecovered==0 means the
    // window is real but absorbed; unrecovered>0 means the pointer did not
    // name a readable generation even after a reopen, which is a defect.
    recordGenerationRecovered(new Error('disk I/O error'), 1_000);
    recordGenerationRecovered(new Error('disk I/O error'), 2_000);
    recordGenerationUnrecovered(new Error('disk I/O error'), 3_000);
    const snap = getGenerationRecovery();
    expect(snap.recoveredReads).toBe(2);
    expect(snap.unrecoveredReads).toBe(1);
    expect(snap.lastErrorAtMs).toBe(3_000);
  });

  it('keeps the most recent error message, truncated', () => {
    recordGenerationRecovered(new Error(`disk I/O error ${'x'.repeat(500)}`), 5_000);
    const snap = getGenerationRecovery();
    expect(snap.lastError?.length).toBe(240);
    expect(snap.lastError?.startsWith('disk I/O error')).toBe(true);
  });
});
