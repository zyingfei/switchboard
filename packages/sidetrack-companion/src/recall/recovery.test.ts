import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireRecallProcessLock,
  cleanupOrphanIndexTmpFiles,
  RecallLockHeldError,
} from './recovery.js';

describe('recovery helpers', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-recovery-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('cleanupOrphanIndexTmpFiles unlinks .index.bin.<rev>.tmp files but leaves the real index alone', async () => {
    const recallDir = join(vaultRoot, '_BAC', 'recall');
    await mkdir(recallDir, { recursive: true });
    await writeFile(join(recallDir, 'index.bin'), 'real index', 'utf8');
    await writeFile(join(recallDir, '.index.bin.abcd1234.tmp'), 'stale 1', 'utf8');
    await writeFile(join(recallDir, '.index.bin.beef5678.tmp'), 'stale 2', 'utf8');
    await writeFile(join(recallDir, 'unrelated.txt'), 'keep me', 'utf8');

    const result = await cleanupOrphanIndexTmpFiles(vaultRoot);
    expect(result.removed).toBe(2);

    expect(await readFile(join(recallDir, 'index.bin'), 'utf8')).toBe('real index');
    expect(await readFile(join(recallDir, 'unrelated.txt'), 'utf8')).toBe('keep me');
    await expect(readFile(join(recallDir, '.index.bin.abcd1234.tmp'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('cleanupOrphanIndexTmpFiles is a no-op when the recall dir is missing', async () => {
    const result = await cleanupOrphanIndexTmpFiles(vaultRoot);
    expect(result.removed).toBe(0);
  });

  it('acquireRecallProcessLock writes our PID and releases on call', async () => {
    const lock = await acquireRecallProcessLock(vaultRoot);
    expect(await readFile(lock.path, 'utf8')).toBe(`${String(process.pid)}\n`);
    await lock.release();
    await expect(readFile(lock.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('acquireRecallProcessLock takes over a stale lock whose PID is dead', async () => {
    await mkdir(join(vaultRoot, '_BAC', 'recall'), { recursive: true });
    // Pid 1 always exists (init) so use a high made-up pid that's
    // implausible to be live on macOS / Linux.
    await writeFile(join(vaultRoot, '_BAC', 'recall', '.lock'), '987654321\n', 'utf8');

    const lock = await acquireRecallProcessLock(vaultRoot);
    expect(await readFile(lock.path, 'utf8')).toBe(`${String(process.pid)}\n`);
    await lock.release();
  });

  it('acquireRecallProcessLock refuses when the existing PID is alive (using our own pid as a proxy)', async () => {
    // The lock is recorded as belonging to OUR own pid by another
    // companion-like writer. Our second-acquire treats us as the
    // same process (pid match), so it succeeds. Use a different but
    // alive PID — the parent shell — to validate the rejection path.
    const parentPid = process.ppid;
    if (!Number.isFinite(parentPid) || parentPid <= 0) {
      // Safety net for environments without a parent (some CI).
      return;
    }
    await mkdir(join(vaultRoot, '_BAC', 'recall'), { recursive: true });
    await writeFile(
      join(vaultRoot, '_BAC', 'recall', '.lock'),
      `${String(parentPid)}\n`,
      'utf8',
    );
    await expect(acquireRecallProcessLock(vaultRoot)).rejects.toBeInstanceOf(RecallLockHeldError);
  });
});
