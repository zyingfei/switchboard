import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readDomainTombstones, upsertDomainTombstone } from './domainTombstoneStore.js';
import type { DomainTombstonePayload } from './domainTombstone.js';

// Scope-keyed dedup: two host-scoped tombstones for SIBLING hosts under
// one eTLD+1 must both persist (collapsing them silently drops a purge),
// while a repeat of the SAME scope refreshes in place. Reads back the
// materialized artifact (doctrine rule 10).

const t = (over: Partial<DomainTombstonePayload>): DomainTombstonePayload => ({
  payloadVersion: 1,
  kind: 'domain',
  domain: 'google.com',
  tombstonedAt: '2026-07-24T00:00:00.000Z',
  ...over,
});

describe('upsertDomainTombstone — scope-keyed dedup', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-tombstone-store-'));
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('keeps sibling-host tombstones distinct (does not collapse on eTLD+1)', async () => {
    await upsertDomainTombstone(vaultRoot, t({ host: 'meet.google.com' }));
    await upsertDomainTombstone(vaultRoot, t({ host: 'mail.google.com' }));
    const all = await readDomainTombstones(vaultRoot);
    const hosts = all.map((x) => x.host).sort();
    expect(hosts).toEqual(['mail.google.com', 'meet.google.com']);
    expect(all.length).toBe(2);
  });

  it('a repeat of the same host refreshes in place (no duplicate)', async () => {
    await upsertDomainTombstone(vaultRoot, t({ host: 'meet.google.com' }));
    await upsertDomainTombstone(
      vaultRoot,
      t({ host: 'meet.google.com', tombstonedAt: '2026-07-25T00:00:00.000Z' }),
    );
    const all = await readDomainTombstones(vaultRoot);
    expect(all.length).toBe(1);
    expect(all[0]?.tombstonedAt).toBe('2026-07-25T00:00:00.000Z');
  });

  it('a family (host-less) tombstone coexists with a host-scoped one', async () => {
    await upsertDomainTombstone(vaultRoot, t({ host: 'meet.google.com' }));
    await upsertDomainTombstone(vaultRoot, t({}));
    const all = await readDomainTombstones(vaultRoot);
    expect(all.length).toBe(2);
    // One host-scoped, one family-wide (no host).
    expect(all.filter((x) => x.host === undefined).length).toBe(1);
    expect(all.filter((x) => x.host === 'meet.google.com').length).toBe(1);
  });
});
