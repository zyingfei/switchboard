import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importSettings } from './importBundle.js';

const bundle = {
  schemaVersion: 1,
  exportedAt: '2026-05-03T23:00:00.000Z',
  settings: {
    autoSendOptIn: { chatgpt: true, claude: true, gemini: true },
    defaultPacketKind: 'coding',
    defaultDispatchTarget: 'claude',
    screenShareSafeMode: true,
    revision: '7',
  },
  workstreams: [
    { bac_id: 'ws_existing', title: 'Existing from bundle' },
    { bac_id: 'ws_new', title: 'New' },
  ],
  templates: [],
};

describe('importSettings', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-import-test-'));
    await mkdir(join(vaultRoot, '_BAC', 'workstreams'), { recursive: true });
    await writeFile(
      join(vaultRoot, '_BAC', 'workstreams', 'ws_existing.json'),
      JSON.stringify({ bac_id: 'ws_existing', title: 'Keep me' }),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('overwrites settings and skips workstream id conflicts', async () => {
    const result = await importSettings(vaultRoot, bundle);
    const settings = JSON.parse(
      await readFile(join(vaultRoot, '_BAC', '.config', 'settings.json'), 'utf8'),
    ) as { readonly defaultPacketKind?: string };
    const existing = await readFile(
      join(vaultRoot, '_BAC', 'workstreams', 'ws_existing.json'),
      'utf8',
    );

    expect(result).toEqual({
      applied: 2,
      skipped: 1,
      conflicts: [{ kind: 'workstream', bac_id: 'ws_existing', reason: 'already_exists' }],
    });
    expect(settings.defaultPacketKind).toBe('coding');
    expect(existing).toContain('Keep me');
    await expect(
      readFile(join(vaultRoot, '_BAC', 'workstreams', 'ws_new.json'), 'utf8'),
    ).resolves.toContain('New');
  });

  it('rejects unsupported schema versions and malformed bundles', async () => {
    await expect(importSettings(vaultRoot, { ...bundle, schemaVersion: 2 })).rejects.toThrow();
    await expect(importSettings(vaultRoot, { schemaVersion: 1 })).rejects.toThrow();
  });
});
