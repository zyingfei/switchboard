import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createIdempotencyStore } from './idempotency.js';

describe('idempotency store TTL', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-idempotency-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('ignores expired records and gcExpired removes them', async () => {
    const store = createIdempotencyStore(vaultRoot);
    await store.write('route', 'expired', {
      status: 200,
      body: { ok: true },
      expiresAt: '2026-05-03T00:00:00.000Z',
    });
    await store.write('route', 'fresh', {
      status: 201,
      body: { ok: true },
      expiresAt: '2099-05-03T01:00:00.000Z',
    });

    await expect(store.read('route', 'expired')).resolves.toBeUndefined();
    await expect(store.read('route', 'fresh')).resolves.toMatchObject({ status: 201 });
    await expect(store.gcExpired?.(new Date('2026-05-03T00:30:00.000Z'))).resolves.toEqual({
      removed: 1,
    });
  });
});
