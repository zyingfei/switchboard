import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createVaultWatcher, type VaultChangeEvent } from './watcher.js';

const delay = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
};

describe('vault watcher', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-watcher-'));
    await mkdir(join(vaultRoot, '_BAC', 'threads'), { recursive: true });
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('emits debounced create/modify/delete events with path kind', async () => {
    const events: VaultChangeEvent[] = [];
    const watcher = createVaultWatcher(vaultRoot, {
      debounceMs: 20,
      onChange: (event) => {
        events.push(event);
      },
    });
    try {
      const path = join(vaultRoot, '_BAC', 'threads', 'bac_thread_1.json');
      await writeFile(path, '{}', 'utf8');
      await writeFile(path, '{"title":"updated"}', 'utf8');
      await delay(80);
      await unlink(path);
      await delay(80);
    } finally {
      await watcher.close();
    }

    expect(events.map((event) => event.kind)).toContain('thread');
    expect(events.map((event) => event.relPath)).toContain('_BAC/threads/bac_thread_1.json');
    expect(events.some((event) => event.type === 'deleted')).toBe(true);
  });
});
