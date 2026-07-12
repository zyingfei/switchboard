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

  it('keeps five recent derived revisions by default and ten closest-visit revisions', async () => {
    const now = new Date('2026-05-15T12:00:00.000Z');
    for (let index = 0; index < 6; index += 1) {
      await writeFixture(
        `_BAC/connections/visit-similarity/rev-${String(index)}.json`,
        '{}\n',
        now.getTime() - index * 1_000,
      );
      await writeFixture(
        `_BAC/connections/topics/rev-${String(index)}.json`,
        '{}\n',
        now.getTime() - index * 1_000,
      );
    }
    for (let index = 0; index < 11; index += 1) {
      await writeFixture(
        `_BAC/connections/closest-visit/rev-${String(index)}.json`,
        '{}\n',
        now.getTime() - index * 1_000,
      );
    }

    const plan = await buildGcPlan(root, { now });

    expect(plan.entries.filter((entry) => entry.group === 'visit-similarity-revisions')).toHaveLength(
      1,
    );
    expect(plan.entries.filter((entry) => entry.group === 'topic-revisions')).toHaveLength(1);
    expect(plan.entries.filter((entry) => entry.group === 'closest-visit-revisions')).toHaveLength(
      1,
    );
    expect(plan.entries.find((entry) => entry.group === 'visit-similarity-revisions')?.reason).toBe(
      'derived visit-similarity revision outside newest 5',
    );
    expect(plan.entries.find((entry) => entry.group === 'closest-visit-revisions')?.reason).toBe(
      'derived closest-visit ranker file outside newest 10',
    );
  });

  it('keeps the newest N daily connections snapshots and prunes the rest in plan+apply', async () => {
    const now = new Date('2026-05-15T12:00:00.000Z');
    // Five date-named snapshots. mtimes are deliberately INVERTED vs the
    // date order (oldest date written most recently) to prove retention
    // keys on the filename date, not mtime.
    const dates = ['2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15'];
    for (let index = 0; index < dates.length; index += 1) {
      await writeFixture(
        `_BAC/connections/snapshots/${dates[index] as string}.json`,
        `{"day":"${dates[index] as string}"}\n`,
        now.getTime() - (dates.length - index) * 1_000,
      );
    }
    // A stray non-date file must be ignored by the retention selector.
    await writeFixture('_BAC/connections/snapshots/current.json', '{}\n', now.getTime());

    const plan = await buildGcPlan(root, { now, keepConnectionsSnapshots: 3 });
    const snapshotEntries = plan.entries.filter(
      (entry) => entry.group === 'connections-snapshots',
    );
    // Newest 3 DATES kept (05-15/14/13); oldest 2 pruned (05-12/11).
    expect(snapshotEntries.map((entry) => entry.path.split('/').at(-1)).sort()).toEqual([
      '2026-05-11.json',
      '2026-05-12.json',
    ]);
    expect(snapshotEntries[0]?.reason).toBe('daily connections snapshot outside newest 3');
    // current.json (non-date) never selected.
    expect(snapshotEntries.some((entry) => entry.path.endsWith('current.json'))).toBe(false);

    const result = await applyGcPlan(plan);
    expect(result.errors).toEqual([]);
    // Pruned files gone; kept dates + current.json still present.
    await expect(
      readFile(join(root, '_BAC/connections/snapshots/2026-05-11.json'), 'utf8'),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      readFile(join(root, '_BAC/connections/snapshots/2026-05-13.json'), 'utf8'),
    ).resolves.toContain('2026-05-13');
    await expect(
      readFile(join(root, '_BAC/connections/snapshots/current.json'), 'utf8'),
    ).resolves.toBe('{}\n');
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

  it('plans idempotency receipts over count or byte retention without parsing old bodies', async () => {
    const now = new Date('2026-05-15T12:00:00.000Z');
    await writeFixture(
      '_BAC/.config/idempotency/old-large.json',
      `${'x'.repeat(200)}\n`,
      now.getTime() - 3_000,
    );
    await writeFixture(
      '_BAC/.config/idempotency/middle.json',
      JSON.stringify({ expiresAt: '2099-05-15T12:00:00.000Z' }),
      now.getTime() - 2_000,
    );
    await writeFixture(
      '_BAC/.config/idempotency/new.json',
      JSON.stringify({ expiresAt: '2099-05-15T12:00:00.000Z' }),
      now.getTime() - 1_000,
    );

    const plan = await buildGcPlan(root, {
      now,
      keepIdempotencyReceipts: 2,
      keepIdempotencyBytes: 50,
    });

    const idempotency = plan.entries.filter((entry) => entry.group === 'expired-idempotency');
    expect(idempotency.map((entry) => entry.path.split('/').at(-1)).sort()).toEqual([
      'middle.json',
      'old-large.json',
    ]);
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
