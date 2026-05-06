import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { generateReplicaKeyPair, type ReplicaKeyPair } from './relayCrypto.js';

// Per-replica Ed25519 signing keypair. Stored at
// `_BAC/.config/replica-keypair.json` as base64 strings of the raw
// 32-byte public + private seeds. The public key is shareable; the
// private seed never leaves the host.

const keyPairPath = (vaultPath: string): string =>
  join(vaultPath, '_BAC', '.config', 'replica-keypair.json');

const writeAtomic = async (path: string, body: string): Promise<void> => {
  const tmp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
};

interface OnDiskKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

export const loadOrCreateReplicaKeyPair = async (
  vaultPath: string,
): Promise<ReplicaKeyPair> => {
  const path = keyPairPath(vaultPath);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as OnDiskKeyPair;
    if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
      return {
        publicKey: Buffer.from(parsed.publicKey, 'base64'),
        privateKey: Buffer.from(parsed.privateKey, 'base64'),
      };
    }
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
  const keys = generateReplicaKeyPair();
  await mkdir(join(vaultPath, '_BAC', '.config'), { recursive: true });
  await writeAtomic(
    path,
    JSON.stringify(
      {
        publicKey: keys.publicKey.toString('base64'),
        privateKey: keys.privateKey.toString('base64'),
      } satisfies OnDiskKeyPair,
      null,
      2,
    ),
  );
  return keys;
};
