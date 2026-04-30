import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const bridgeKeyPath = (vaultPath: string): string =>
  join(vaultPath, '_BAC', '.config', 'bridge.key');

export const createBridgeKey = (): string => randomBytes(32).toString('base64url');

export interface EnsuredBridgeKey {
  readonly key: string;
  readonly path: string;
  // True if this call generated the key (first run); false if an
  // existing key file was reused. CLI uses this to decide whether
  // to print the key value (only on first generation — subsequent
  // runs just point the user at the file path).
  readonly created: boolean;
}

export const ensureBridgeKey = async (vaultPath: string): Promise<EnsuredBridgeKey> => {
  const path = bridgeKeyPath(vaultPath);

  try {
    const existing = await readFile(path, 'utf8');
    const trimmed = existing.trim();
    if (trimmed.length > 0) {
      return { key: trimmed, path, created: false };
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }

  const key = createBridgeKey();
  await mkdir(join(vaultPath, '_BAC', '.config'), { recursive: true });
  await writeFile(path, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  return { key, path, created: true };
};

export const bridgeKeysMatch = (expected: string, actual: string): boolean => {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
};
