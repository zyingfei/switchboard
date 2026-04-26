import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const keyfilePath = (vaultPath: string): string =>
  path.join(vaultPath, '_BAC', '.config', 'bridge.key');

export const ensureBridgeKey = async (vaultPath: string): Promise<string> => {
  const filePath = keyfilePath(vaultPath);
  const existing = await readFile(filePath, 'utf8').catch(() => '');
  const key = existing.trim();
  if (key) {
    return key;
  }

  const next = randomBytes(32).toString('hex');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${next}\n`, { encoding: 'utf8', flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') {
      return;
    }
    throw error;
  });
  await chmod(filePath, 0o600).catch(() => undefined);
  return (await readFile(filePath, 'utf8')).trim();
};

export const isAuthorized = (expected: string, actual: string | undefined): boolean => {
  if (!actual || actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
};
