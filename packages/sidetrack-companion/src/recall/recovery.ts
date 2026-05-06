import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Startup-time recovery + safety helpers for the recall index.
//
// One companion writes a vault. Multi-replica sync goes through the
// per-replica event log under `_BAC/log/` — never two companions
// against one vault. The PID lock here enforces that invariant: if a
// running companion tries to start against a vault whose lock is
// held by another live PID, we refuse rather than racing index
// writes and corrupting the binary.

const recallDir = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'recall');
const lockPath = (vaultRoot: string): string => join(recallDir(vaultRoot), '.lock');

const isPidAlive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 is a permission probe — sends nothing, throws if the
    // process doesn't exist or is owned by another user.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export class RecallLockHeldError extends Error {
  constructor(
    readonly vaultRoot: string,
    readonly pid: number,
  ) {
    super(
      `Another companion (pid ${String(pid)}) already owns the recall index for ${vaultRoot}. ` +
        'Stop the other process or wait for it to exit before starting a second companion.',
    );
  }
}

export interface RecallProcessLock {
  readonly path: string;
  readonly release: () => Promise<void>;
}

export const acquireRecallProcessLock = async (
  vaultRoot: string,
): Promise<RecallProcessLock> => {
  await mkdir(recallDir(vaultRoot), { recursive: true });
  const path = lockPath(vaultRoot);
  let existingPid: number | null = null;
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      existingPid = parsed;
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
  if (existingPid !== null && existingPid !== process.pid && isPidAlive(existingPid)) {
    throw new RecallLockHeldError(vaultRoot, existingPid);
  }
  // Either no lock or a stale one (its PID is gone). Take it.
  await writeFile(path, `${String(process.pid)}\n`, { encoding: 'utf8', mode: 0o600 });

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      const current = (await readFile(path, 'utf8')).trim();
      if (Number.parseInt(current, 10) === process.pid) {
        await unlink(path);
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  };
  return { path, release };
};

// Removes stale temp files left by a prior process that died
// mid-write. Without this they accumulate in `_BAC/recall/` and a
// future ENOSPC starts looking suspicious. Idempotent; safe to call
// on every startup.
export const cleanupOrphanIndexTmpFiles = async (
  vaultRoot: string,
): Promise<{ readonly removed: number }> => {
  const dir = recallDir(vaultRoot);
  let entries: readonly string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { removed: 0 };
    }
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (/^\.index\.bin\.[A-Za-z0-9_-]+\.tmp$/.test(entry)) {
      try {
        await unlink(join(dir, entry));
        removed += 1;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
    }
  }
  return { removed };
};
