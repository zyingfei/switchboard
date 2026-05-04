import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isAllowed, readTrust, writeTrust } from './workstreamTrust.js';

describe('workstreamTrust', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-trust-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('defaults to deny when no trust record exists', async () => {
    const trust = await readTrust(vaultRoot);

    expect(isAllowed('bac_ws_1', 'bac.move_item', trust)).toBe(false);
  });

  it('persists allowed write tools and checks membership', async () => {
    await writeTrust(vaultRoot, [
      { workstreamId: 'bac_ws_1', allowedTools: new Set(['bac.move_item']) },
    ]);

    const trust = await readTrust(vaultRoot);

    expect(isAllowed('bac_ws_1', 'bac.move_item', trust)).toBe(true);
    expect(isAllowed('bac_ws_1', 'bac.archive_thread', trust)).toBe(false);
  });
});
