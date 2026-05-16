import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetGcInventoryCache,
  applyGcPlan,
  buildGcPlan,
  gcInventory,
  gcInventoryCached,
} from './plan.js';

describe('derived-data GC plan', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidetrack-gc-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writeFixture = async (relative: string, body = '{}\n', mtimeMs = Date.now()) => {
    const path = join(root, relative);
    await mkdir(path.split('/').slice(0, -1).join('/'), { recursive: true });
    await writeFile(path, body, 'utf8');
    const date = new Date(mtimeMs);
    await utimes(path, date, date);
    return path;
  };

  it('plans derived files and preserves canonical state', async () => {
    const now = new Date('2026-05-15T12:00:00.000Z');
    await writeFixture('_BAC/log/local/2026-05-15.jsonl', '{}\n', now.getTime() - 10_000_000);
    await writeFixture('_BAC/threads/thread1.json', '{}\n', now.getTime() - 10_000_000);
    await writeFixture('_BAC/connections/current.json.old.tmp', 'tmp', now.getTime() - 900_000);
    await writeFixture('_BAC/connections/topics/current.json', '{}\n', now.getTime() - 900_000);
    await writeFixture(
      '_BAC/connections/topics/current.shadow.json',
      '{}\n',
      now.getTime() - 900_000,
    );
    await writeFixture('_BAC/connections/topics/rev-old.json', '{}\n', now.getTime() - 800_000);
    await writeFixture('_BAC/connections/topics/rev-new.json', '{}\n', now.getTime() - 100_000);
    await writeFixture(
      '_BAC/.config/idempotency/expired.json',
      JSON.stringify({ expiresAt: '2026-05-14T00:00:00.000Z' }),
      now.getTime() - 100_000,
    );

    const plan = await buildGcPlan(root, { now, keepRecentRevisions: 1 });

    expect(plan.entries.map((entry) => entry.group).sort()).toEqual([
      'connections-temp',
      'expired-idempotency',
      'topic-revisions',
    ]);
    expect(plan.entries.some((entry) => entry.path.includes('_BAC/log/'))).toBe(false);
    expect(plan.entries.some((entry) => entry.path.includes('_BAC/threads/'))).toBe(false);
  });

  it('applies the planned deletes only when requested', async () => {
    const now = new Date('2026-05-15T12:00:00.000Z');
    const stale = await writeFixture(
      '_BAC/connections/current.json.old.tmp',
      'tmp',
      now.getTime() - 900_000,
    );
    const plan = await buildGcPlan(root, { now });

    expect(plan.entries.map((entry) => entry.path)).toContain(stale);
    const result = await applyGcPlan(plan);

    expect(result.errors).toEqual([]);
    await expect(readFile(stale, 'utf8')).rejects.toBeInstanceOf(Error);
  });

  it('summarises reclaimable groups without deleting anything', async () => {
    const now = new Date('2026-05-15T12:00:00.000Z');
    const tmp = await writeFixture(
      '_BAC/connections/current.json.old.tmp',
      'tmptmp',
      now.getTime() - 900_000,
    );
    await writeFixture('_BAC/connections/topics/current.json', '{}\n', now.getTime() - 900_000);
    const oldRev = await writeFixture(
      '_BAC/connections/topics/rev-old.json',
      '{"old":true}\n',
      now.getTime() - 800_000,
    );
    await writeFixture('_BAC/connections/topics/rev-new.json', '{}\n', now.getTime() - 100_000);

    const inventory = await gcInventory(root, { now, keepRecentRevisions: 1 });

    expect(inventory.producedAt).toBe(now.toISOString());
    expect(inventory.groups['connections-temp']).toEqual({ count: 1, bytes: 6 });
    expect(inventory.groups['topic-revisions']).toEqual({ count: 1, bytes: 13 });
    expect(inventory.groups['debug-dumps']).toEqual({ count: 0, bytes: 0 });
    expect(inventory.totalCount).toBe(2);
    expect(inventory.totalBytes).toBe(19);

    // Nothing was deleted: every fixture still readable.
    await expect(readFile(tmp, 'utf8')).resolves.toBe('tmptmp');
    await expect(readFile(oldRev, 'utf8')).resolves.toBe('{"old":true}\n');
  });

  it('serves gc inventory from a background-refreshed cache, honestly tri-stated', async () => {
    __resetGcInventoryCache();
    await writeFixture('_BAC/connections/current.json.old.tmp', 'tmp', Date.now() - 900_000);

    // Cold non-blocking call: nothing cached yet → honest unavailable,
    // and it kicks off the background compute.
    const cold = await gcInventoryCached(root);
    expect(cold.availability).toBe('unavailable');
    expect(cold.value).toBeNull();

    // awaitFresh forces the compute to land → ok with a real value.
    const warmed = await gcInventoryCached(root, {}, { awaitFresh: true });
    expect(warmed.availability).toBe('ok');
    expect(warmed.value?.totalCount).toBe(1);
    expect(warmed.asOf).not.toBeNull();

    // Within TTL the next call is a fresh O(1) cache hit (same asOf,
    // not recomputed).
    const hit = await gcInventoryCached(root);
    expect(hit.availability).toBe('ok');
    expect(hit.asOf).toBe(warmed.asOf);

    // Expired entry → stale (serves the old value) while it refreshes,
    // never a fabricated zero.
    const stale = await gcInventoryCached(root, {}, { ttlMs: 0 });
    expect(stale.availability).toBe('stale');
    expect(stale.value?.totalCount).toBe(1);
    __resetGcInventoryCache();
  });
});
