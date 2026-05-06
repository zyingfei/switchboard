import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { generateRendezvousSecret } from './relayCrypto.js';

const RENDEZVOUS_SECRET_PATH_SEGMENTS = ['_BAC', '.config', 'sync-rendezvous.secret'] as const;

export interface EnsuredRendezvousSecret {
  readonly secret: string;
  readonly path: string;
  readonly created: boolean;
}

const secretPath = (vaultRoot: string): string =>
  join(vaultRoot, ...RENDEZVOUS_SECRET_PATH_SEGMENTS);

const writeSecret = async (path: string, secret: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${secret}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
};

export const ensureRendezvousSecret = async (
  vaultRoot: string,
  preferred?: string,
): Promise<EnsuredRendezvousSecret> => {
  const path = secretPath(vaultRoot);
  const trimmedPreferred = preferred?.trim();
  if (trimmedPreferred !== undefined && trimmedPreferred.length > 0) {
    await writeSecret(path, trimmedPreferred);
    return { secret: trimmedPreferred, path, created: false };
  }

  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (existing.length > 0) {
      return { secret: existing, path, created: false };
    }
  } catch {
    // Missing or unreadable secret: generate a fresh sync group.
  }

  const secret = generateRendezvousSecret().toString('base64url');
  await writeSecret(path, secret);
  return { secret, path, created: true };
};
