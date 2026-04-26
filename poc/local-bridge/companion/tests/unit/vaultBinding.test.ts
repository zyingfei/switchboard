import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { VaultBinding, mergeFrontmatter } from '../../src/vault/binding';

describe('VaultBinding', () => {
  let vaultPath: string;

  beforeEach(async () => {
    vaultPath = await mkdtemp(path.join(os.tmpdir(), 'bac-local-bridge-vault-'));
  });

  afterEach(async () => {
    await rm(vaultPath, { recursive: true, force: true });
  });

  it('writes notes atomically inside the vault', async () => {
    const binding = new VaultBinding(vaultPath);
    const relative = await binding.writeNote('Inbox/test.md', '# Test');
    expect(relative).toBe('Inbox/test.md');
    await expect(readFile(path.join(vaultPath, 'Inbox/test.md'), 'utf8')).resolves.toBe('# Test\n');
  });

  it('rejects paths that escape the vault', async () => {
    const binding = new VaultBinding(vaultPath);
    await expect(binding.writeNote('../escape.md', 'nope')).rejects.toThrow(/escapes root/u);
  });

  it('patches frontmatter without replacing the body', async () => {
    const binding = new VaultBinding(vaultPath);
    await binding.writeNote('note.md', '---\ntitle: \"Old\"\n---\n# Body\n');
    await binding.patchFrontmatter('note.md', { status: 'active', title: 'New' });
    const next = await readFile(path.join(vaultPath, 'note.md'), 'utf8');
    expect(next).toContain('status: "active"');
    expect(next).toContain('title: "New"');
    expect(next).toContain('# Body');
  });

  it('attaches track rows as JSONL', async () => {
    const binding = new VaultBinding(vaultPath);
    await binding.attachToTrack('chat/session', { n: 1 });
    const file = path.join(vaultPath, '_BAC', 'tracks', 'chat-session.jsonl');
    await expect(stat(file)).resolves.toBeTruthy();
    expect(await readFile(file, 'utf8')).toBe('{"n":1}\n');
  });
});

describe('mergeFrontmatter', () => {
  it('creates frontmatter when missing', () => {
    expect(mergeFrontmatter('# Note\n', { status: 'new' })).toBe('---\nstatus: "new"\n---\n\n# Note\n');
  });
});
