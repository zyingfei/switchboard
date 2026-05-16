import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_AGE_DAYS = 90;
const MAX_ROTATIONS = 12;

interface QuarantineFile {
  readonly path: string;
  readonly dir: string;
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly gzipped: boolean;
}

const gzipFile = async (path: string, target: string): Promise<void> => {
  await pipeline(createReadStream(path), createGzip(), createWriteStream(target));
};

const isNotFoundError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { readonly code?: unknown }).code === 'ENOENT';

const logRetentionError = (message: string, error: unknown): void => {
  console.warn(`[quarantine-retention] ${message}`, error);
};

const listQuarantineFiles = async (quarantineRoot: string): Promise<readonly QuarantineFile[]> => {
  const dateDirs = await readdir(quarantineRoot, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (!isNotFoundError(error)) {
        logRetentionError('failed to list quarantine root', error);
      }
      return [];
    },
  );
  const files: QuarantineFile[] = [];
  for (const dateDir of dateDirs.filter((entry) => entry.isDirectory())) {
    const dir = join(quarantineRoot, dateDir.name);
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      logRetentionError(`failed to list quarantine date directory ${dateDir.name}`, error);
      return [];
    });
    for (const entry of entries.filter((candidate) => candidate.isFile())) {
      const gzipped = entry.name.endsWith('.jsonl.gz');
      if (!gzipped && !entry.name.endsWith('.jsonl')) {
        continue;
      }
      const path = join(dir, entry.name);
      const info = await stat(path).catch((error: unknown) => {
        logRetentionError(`failed to stat quarantine file ${path}`, error);
        return undefined;
      });
      if (info === undefined) {
        continue;
      }
      files.push({ path, dir, name: entry.name, size: info.size, mtimeMs: info.mtimeMs, gzipped });
    }
  }
  return files;
};

const cleanupEmptyDateDirs = async (quarantineRoot: string): Promise<void> => {
  const dateDirs = await readdir(quarantineRoot, { withFileTypes: true }).catch(() => []);
  for (const dateDir of dateDirs.filter((entry) => entry.isDirectory())) {
    const dir = join(quarantineRoot, dateDir.name);
    const entries = await readdir(dir).catch((error: unknown) => {
      logRetentionError(`failed to inspect quarantine date directory ${dateDir.name}`, error);
      return undefined;
    });
    if (entries === undefined || entries.length > 0) {
      continue;
    }
    await rmdir(dir).catch((error: unknown) => {
      if (!isNotFoundError(error)) {
        logRetentionError(
          `failed to remove empty quarantine date directory ${dateDir.name}`,
          error,
        );
      }
    });
  }
};

const byOldestFirst = (left: QuarantineFile, right: QuarantineFile): number =>
  left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path);

export const enforceQuarantineRetention = async (vaultRoot: string): Promise<void> => {
  const quarantineRoot = join(vaultRoot, '_BAC', 'audit', 'quarantine');
  const maxAgeMs = DEFAULT_MAX_AGE_DAYS * 86_400_000;
  const now = new Date();
  const cutoffMs = now.getTime() - maxAgeMs;

  try {
    for (const file of await listQuarantineFiles(quarantineRoot)) {
      if (file.mtimeMs > cutoffMs) {
        continue;
      }
      if (file.gzipped) {
        try {
          await unlink(file.path);
        } catch (error: unknown) {
          logRetentionError(`failed to remove expired quarantine rotation ${file.path}`, error);
        }
        continue;
      }
      const rotated = join(
        file.dir,
        `${basename(file.name, '.jsonl')}.${now.toISOString().replace(/[:.]/gu, '-')}.jsonl.gz`,
      );
      try {
        await gzipFile(file.path, rotated);
        await unlink(file.path);
      } catch (error: unknown) {
        logRetentionError(`failed to rotate expired quarantine file ${file.path}`, error);
      }
    }

    const filesAfterAge = await listQuarantineFiles(quarantineRoot);
    const gzippedFiles = filesAfterAge.filter((file) => file.gzipped).sort(byOldestFirst);
    for (const stale of gzippedFiles.slice(0, Math.max(0, gzippedFiles.length - MAX_ROTATIONS))) {
      try {
        await unlink(stale.path);
      } catch (error: unknown) {
        logRetentionError(`failed to remove stale quarantine rotation ${stale.path}`, error);
      }
    }

    const filesAfterRotationLimit = await listQuarantineFiles(quarantineRoot);
    let totalBytes = filesAfterRotationLimit.reduce((sum, file) => sum + file.size, 0);
    for (const stale of filesAfterRotationLimit
      .filter((file) => file.gzipped)
      .sort(byOldestFirst)) {
      if (totalBytes <= DEFAULT_MAX_BYTES) {
        break;
      }
      try {
        await unlink(stale.path);
        totalBytes -= stale.size;
      } catch (error: unknown) {
        logRetentionError(`failed to remove oversized quarantine rotation ${stale.path}`, error);
      }
    }

    await cleanupEmptyDateDirs(quarantineRoot);
  } catch (error: unknown) {
    logRetentionError('retention scan failed', error);
  }
};
