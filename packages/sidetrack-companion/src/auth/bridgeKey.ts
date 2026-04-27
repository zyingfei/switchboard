import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const bridgeKeyPath = (vaultPath: string): string =>
  join(vaultPath, '_BAC', '.config', 'bridge.key');

export const createBridgeKey = (): string => randomBytes(32).toString('base64url');

export const ensureBridgeKey = async (vaultPath: string): Promise<string> => {
  const path = bridgeKeyPath(vaultPath);

  try {
    const existing = await readFile(path, 'utf8');
    const trimmed = existing.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const key = createBridgeKey();
  await mkdir(join(vaultPath, '_BAC', '.config'), { recursive: true });
  await writeFile(path, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  return key;
};

export const bridgeKeysMatch = (expected: string, actual: string): boolean => {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
};
