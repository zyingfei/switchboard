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

  it('deny-by-default when no trust record exists (PRD §6.1.14, opt-in)', async () => {
    // Fresh workstreams have no entry in trust.json. MCP write trust is
    // opt-in: an MCP-key caller must be explicitly granted a tool on a
    // workstream before it can drive that write. (The extension surface
    // is exempt from this gate at the HTTP layer, not here.)
    const trust = await readTrust(vaultRoot);

    expect(isAllowed('bac_ws_1', 'sidetrack.threads.move', trust)).toBe(false);
    expect(isAllowed('bac_ws_1', 'sidetrack.threads.archive', trust)).toBe(false);
  });

  it('honors an explicit grant once a record exists', async () => {
    await writeTrust(vaultRoot, [
      { workstreamId: 'bac_ws_1', allowedTools: new Set(['sidetrack.threads.move']) },
    ]);

    const trust = await readTrust(vaultRoot);

    expect(isAllowed('bac_ws_1', 'sidetrack.threads.move', trust)).toBe(true);
    expect(isAllowed('bac_ws_1', 'sidetrack.threads.archive', trust)).toBe(false);
  });

  it('persists explicit allow-list and checks membership; tools NOT in the list are denied', async () => {
    await writeTrust(vaultRoot, [
      { workstreamId: 'bac_ws_1', allowedTools: new Set(['sidetrack.threads.move']) },
    ]);

    const trust = await readTrust(vaultRoot);

    expect(isAllowed('bac_ws_1', 'sidetrack.threads.move', trust)).toBe(true);
    // explicit deny: written record didn't include archive, so it
    // remains denied — the user opted INTO trust for this workstream
    // and explicitly excluded archive.
    expect(isAllowed('bac_ws_1', 'sidetrack.threads.archive', trust)).toBe(false);
  });
});
