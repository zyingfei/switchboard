import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enforceRetention } from './auditRetention.js';

describe('audit retention', () => {
  let vaultRoot: string;
  let auditRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-audit-retention-'));
    auditRoot = join(vaultRoot, '_BAC', 'audit');
    await mkdir(auditRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('rotates logs that exceed the size limit', async () => {
    await writeFile(join(auditRoot, '2026-05-03.jsonl'), 'x'.repeat(32), 'utf8');

    await expect(
      enforceRetention(vaultRoot, { maxBytes: 8 }, new Date('2026-05-04T00:00:00.000Z')),
    ).resolves.toEqual({ removed: 0 });
    expect(await readdir(auditRoot)).toContain(
      '2026-05-03.2026-05-04T00-00-00-000Z.jsonl.gz',
    );
  });

  it('rotates logs older than the max age', async () => {
    const path = join(auditRoot, '2026-05-01.jsonl');
    await writeFile(path, 'old', 'utf8');
    await utimes(path, new Date('2026-05-01T00:00:00.000Z'), new Date('2026-05-01T00:00:00.000Z'));

    await enforceRetention(vaultRoot, { maxAgeDays: 1 }, new Date('2026-05-04T00:00:00.000Z'));

    expect((await readdir(auditRoot)).some((name) => name.endsWith('.jsonl.gz'))).toBe(true);
  });

  it('keeps only the newest twelve rotations', async () => {
    for (let index = 0; index < 13; index += 1) {
      await writeFile(join(auditRoot, `old-${String(index).padStart(2, '0')}.jsonl.gz`), 'gz', 'utf8');
    }

    await expect(enforceRetention(vaultRoot)).resolves.toEqual({ removed: 1 });
    expect((await readdir(auditRoot)).filter((name) => name.endsWith('.jsonl.gz'))).toHaveLength(12);
  });
});
