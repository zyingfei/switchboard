import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanVaultForLinkedNotes } from './linkback.js';

describe('scanVaultForLinkedNotes', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-linkback-test-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('returns empty results for an empty vault', async () => {
    await expect(scanVaultForLinkedNotes(vaultRoot)).resolves.toEqual([]);
  });

  it('finds one markdown note linked by bac_workstream frontmatter', async () => {
    await writeFile(
      join(vaultRoot, 'note.md'),
      ['---', 'title: Linked note', 'bac_workstream: bac_ws_1', '---', '', 'ignored body'].join(
        '\n',
      ),
      'utf8',
    );

    await expect(scanVaultForLinkedNotes(vaultRoot)).resolves.toMatchObject([
      {
        workstreamId: 'bac_ws_1',
        notePath: 'note.md',
        title: 'Linked note',
      },
    ]);
  });

  it('skips non-matches, _BAC, hidden files, and symlinks', async () => {
    await mkdir(join(vaultRoot, '_BAC'), { recursive: true });
    await mkdir(join(vaultRoot, '.hidden'), { recursive: true });
    await writeFile(join(vaultRoot, '_BAC', 'owned.md'), '---\nbac_workstream: bac_ws_no\n---\n');
    await writeFile(join(vaultRoot, '.hidden', 'note.md'), '---\nbac_workstream: bac_ws_no\n---\n');
    await writeFile(join(vaultRoot, 'plain.md'), 'no frontmatter');
    await writeFile(join(vaultRoot, 'real.md'), '---\nbac_workstream: bac_ws_yes\n---\n');
    await symlink(join(vaultRoot, 'real.md'), join(vaultRoot, 'linked.md'));

    const results = await scanVaultForLinkedNotes(vaultRoot);

    expect(results.map((item) => item.notePath)).toEqual(['real.md']);
  });

  it('does not throw on malformed frontmatter', async () => {
    await writeFile(join(vaultRoot, 'bad.md'), '---\nnot yaml\n---\nbody');

    await expect(scanVaultForLinkedNotes(vaultRoot)).resolves.toEqual([]);
  });

  it('skips oversize files', async () => {
    await writeFile(
      join(vaultRoot, 'large.md'),
      `---\nbac_workstream: bac_ws_large\n---\n${'x'.repeat(1024 * 1024)}`,
      'utf8',
    );

    await expect(scanVaultForLinkedNotes(vaultRoot)).resolves.toEqual([]);
  });
});
