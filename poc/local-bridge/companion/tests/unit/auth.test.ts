import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureBridgeKey, isAuthorized, keyfilePath } from '../../src/auth/keyfile';

describe('bridge keyfile auth', () => {
  it('creates and reuses a random bridge key', async () => {
    const vaultPath = await mkdtemp(path.join(os.tmpdir(), 'bac-local-bridge-key-'));
    try {
      const first = await ensureBridgeKey(vaultPath);
      const second = await ensureBridgeKey(vaultPath);
      expect(first).toHaveLength(64);
      expect(second).toBe(first);
      await expect(readFile(keyfilePath(vaultPath), 'utf8')).resolves.toBe(`${first}\n`);
      expect(isAuthorized(first, first)).toBe(true);
      expect(isAuthorized(first, 'x'.repeat(first.length))).toBe(false);
      expect(isAuthorized(first, undefined)).toBe(false);
    } finally {
      await rm(vaultPath, { recursive: true, force: true });
    }
  });
});
