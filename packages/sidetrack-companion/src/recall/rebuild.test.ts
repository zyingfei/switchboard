import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubEmbed } from './__test__/stubEmbedder.js';

vi.mock('./embedder.js', () => ({
  MODEL_ID: 'stub-model',
  embed: stubEmbed,
}));

const { readIndex } = await import('./indexFile.js');
const { rebuildFromEventLog } = await import('./rebuild.js');

describe('rebuildFromEventLog', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-rebuild-test-'));
    await mkdir(join(vaultRoot, '_BAC', 'events'), { recursive: true });
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('rebuilds an index from captured turns in the event log', async () => {
    await writeFile(
      join(vaultRoot, '_BAC', 'events', '2026-05-03.jsonl'),
      [
        JSON.stringify({
          bac_id: 'thread_a',
          capturedAt: '2026-05-03T00:00:00.000Z',
          turns: [
            { ordinal: 0, text: 'first turn', capturedAt: '2026-05-03T00:00:00.000Z' },
            { ordinal: 1, text: 'second turn', capturedAt: '2026-05-03T00:01:00.000Z' },
          ],
        }),
        JSON.stringify({
          bac_id: 'thread_b',
          capturedAt: '2026-05-03T00:02:00.000Z',
          turns: [{ ordinal: 0, text: 'third turn', capturedAt: '2026-05-03T00:02:00.000Z' }],
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await rebuildFromEventLog(vaultRoot, join(vaultRoot, '_BAC', 'events'));
    const index = await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin'));

    expect(result.indexed).toBe(3);
    expect(index?.modelId).toBe('stub-model');
    expect(index?.items.map((item) => item.id)).toEqual([
      'thread_a:0',
      'thread_a:1',
      'thread_b:0',
    ]);
  });

  it('writes an empty index for an empty event log', async () => {
    const result = await rebuildFromEventLog(vaultRoot, join(vaultRoot, '_BAC', 'events'));

    expect(result.indexed).toBe(0);
    expect((await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin')))?.items).toEqual([]);
  });

  it('overwrites a corrupt prior index', async () => {
    await mkdir(join(vaultRoot, '_BAC', 'recall'), { recursive: true });
    await writeFile(join(vaultRoot, '_BAC', 'recall', 'index.bin'), 'corrupt');

    await rebuildFromEventLog(vaultRoot, join(vaultRoot, '_BAC', 'events'));

    expect(await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin'))).not.toBeNull();
  });
});
