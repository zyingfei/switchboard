import { mkdir, mkdtemp, readdir, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enforceQuarantineRetention } from './quarantineRetention.js';

const MAX_BYTES = 25 * 1024 * 1024;

describe('quarantine retention', () => {
  let vaultRoot: string;
  let quarantineRoot: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-quarantine-retention-'));
    quarantineRoot = join(vaultRoot, '_BAC', 'audit', 'quarantine');
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('leaves files under the size limit and max age unchanged', async () => {
    const dateRoot = join(quarantineRoot, '2026-05-03');
    await mkdir(dateRoot, { recursive: true });
    await writeFile(join(dateRoot, 'collector-a.jsonl'), 'fresh', 'utf8');

    await expect(enforceQuarantineRetention(vaultRoot)).resolves.toBeUndefined();

    expect(await readdir(dateRoot)).toEqual(['collector-a.jsonl']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('gzips old jsonl files and deletes old gzipped rotations', async () => {
    const dateRoot = join(quarantineRoot, '2026-01-01');
    await mkdir(dateRoot, { recursive: true });
    const oldJsonl = join(dateRoot, 'collector-a.jsonl');
    const oldGz = join(dateRoot, 'collector-b.2026-01-01T00-00-00-000Z.jsonl.gz');
    await writeFile(oldJsonl, 'old', 'utf8');
    await writeFile(oldGz, 'gz', 'utf8');
    const oldDate = new Date('2000-01-01T00:00:00.000Z');
    await utimes(oldJsonl, oldDate, oldDate);
    await utimes(oldGz, oldDate, oldDate);

    await enforceQuarantineRetention(vaultRoot);

    const names = await readdir(dateRoot);
    expect(names).not.toContain('collector-a.jsonl');
    expect(names).not.toContain('collector-b.2026-01-01T00-00-00-000Z.jsonl.gz');
    expect(
      names.some((name) => name.startsWith('collector-a.') && name.endsWith('.jsonl.gz')),
    ).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drops the oldest gzipped files first when total size exceeds 25 MB', async () => {
    const dateRoot = join(quarantineRoot, '2026-05-03');
    await mkdir(dateRoot, { recursive: true });
    const oldest = join(dateRoot, 'collector-a.2026-05-03T00-00-00-000Z.jsonl.gz');
    const newest = join(dateRoot, 'collector-b.2026-05-04T00-00-00-000Z.jsonl.gz');
    await writeFile(oldest, '', 'utf8');
    await writeFile(newest, '', 'utf8');
    await truncate(oldest, Math.ceil(MAX_BYTES / 2) + 1);
    await truncate(newest, Math.ceil(MAX_BYTES / 2) + 1);
    const olderFreshDate = new Date(Date.now() - 2 * 86_400_000);
    const newerFreshDate = new Date(Date.now() - 86_400_000);
    await utimes(oldest, olderFreshDate, olderFreshDate);
    await utimes(newest, newerFreshDate, newerFreshDate);

    await enforceQuarantineRetention(vaultRoot);

    expect(await readdir(dateRoot)).toEqual(['collector-b.2026-05-04T00-00-00-000Z.jsonl.gz']);
    expect((await stat(newest)).size).toBe(Math.ceil(MAX_BYTES / 2) + 1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('removes per-date subdirectories after deleting their last file', async () => {
    const dateRoot = join(quarantineRoot, '2026-01-01');
    await mkdir(dateRoot, { recursive: true });
    const oldGz = join(dateRoot, 'collector-a.2026-01-01T00-00-00-000Z.jsonl.gz');
    await writeFile(oldGz, 'gz', 'utf8');
    const oldDate = new Date('2000-01-01T00:00:00.000Z');
    await utimes(oldGz, oldDate, oldDate);

    await enforceQuarantineRetention(vaultRoot);

    await expect(readdir(dateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns when the quarantine root does not exist', async () => {
    await expect(enforceQuarantineRetention(vaultRoot)).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
