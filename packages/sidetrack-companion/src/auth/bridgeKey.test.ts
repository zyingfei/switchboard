import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBridgeKey, isBridgeKeyAccepted, rotateBridgeKey } from './bridgeKey.js';

describe('bridge key rotation', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-bridge-key-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('accepts the previous key during the fixed grace window only', async () => {
    const previous = (await ensureBridgeKey(vaultRoot)).key;
    const rotated = await rotateBridgeKey(vaultRoot, previous, new Date('2026-05-03T00:00:00.000Z'));

    expect(rotated.current).not.toBe(previous);
    await expect(
      isBridgeKeyAccepted(vaultRoot, rotated.current, previous, new Date('2026-05-03T00:00:30.000Z')),
    ).resolves.toBe(true);
    await expect(
      isBridgeKeyAccepted(vaultRoot, rotated.current, previous, new Date('2026-05-03T00:01:01.000Z')),
    ).resolves.toBe(false);
    await expect(
      isBridgeKeyAccepted(vaultRoot, rotated.current, rotated.current, new Date('2026-05-03T00:01:01.000Z')),
    ).resolves.toBe(true);
  });
});
