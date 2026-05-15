import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyGcPlan, buildGcPlan } from './plan.js';

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
});
