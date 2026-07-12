import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { createRevision } from '../domain/ids.js';

// Some filesystems (network mounts, certain overlay/union FSes, iCloud
// dataless placeholders) reject an fsync on a file descriptor or a
// directory fd. Durability is best-effort: an unsupported sync must NOT
// fail the write. A genuine I/O error on the *data* path still
// propagates — only these specific "this FS can't fsync" codes are
// swallowed.
const UNSUPPORTED_SYNC_CODES = new Set(['EINVAL', 'EISDIR', 'EPERM', 'ENOTSUP', 'ENOSYS']);

const isUnsupportedSyncError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof (error as { readonly code?: unknown }).code === 'string' &&
  UNSUPPORTED_SYNC_CODES.has((error as { readonly code: string }).code);

// fsync the parent directory so the rename entry itself is durable (a
// rename that is buffered in the dir's dirent cache can be lost on a
// power cut even after the file data is flushed). Best-effort: a FS that
// refuses dir open/sync must not fail the write.
const syncDirectory = async (directory: string): Promise<void> => {
  let dirHandle;
  try {
    dirHandle = await open(directory, 'r');
  } catch (error) {
    if (isUnsupportedSyncError(error)) {
      return;
    }
    throw error;
  }
  try {
    await dirHandle.sync();
  } catch (error) {
    if (!isUnsupportedSyncError(error)) {
      throw error;
    }
  } finally {
    await dirHandle.close();
  }
};

export const writeFileAtomic = async (path: string, body: string | Buffer): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(path)}.${createRevision()}.tmp`);
  try {
    // Write the temp file through a handle so we can fsync its data
    // BEFORE the rename — a plain writeFile leaves the bytes in the page
    // cache, so a rename could publish a file whose contents were never
    // flushed (a torn/empty tail on power loss).
    const handle = await open(tempPath, 'w');
    try {
      await handle.writeFile(body);
      try {
        await handle.sync();
      } catch (error) {
        if (!isUnsupportedSyncError(error)) {
          throw error;
        }
      }
    } finally {
      await handle.close();
    }
    await rename(tempPath, path);
    // Flush the directory entry so the rename survives a crash.
    await syncDirectory(directory);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
};

export const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
};
