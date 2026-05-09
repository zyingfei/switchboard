import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { createRevision } from '../domain/ids.js';

export const writeFileAtomic = async (path: string, body: string | Buffer): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(path)}.${createRevision()}.tmp`);
  try {
    await writeFile(tempPath, body);
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
};

export const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
};
