import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    // V3: each turn produces one or more chunks; ids encode the
    // source bac_id + ordinal + content hash.
    const ids = index?.items.map((item) => item.id) ?? [];
    expect(ids.every((id) => id.startsWith('chunk:'))).toBe(true);
    const sourceBacs = new Set(index?.items.map((item) => item.metadata?.sourceBacId));
    expect(sourceBacs).toEqual(new Set(['thread_a', 'thread_b']));
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

  it('reads from the per-replica log when an EventLog is wired and skips legacy lines whose bac_id is already in the log', async () => {
    const { createEventLog } = await import('../sync/eventLog.js');
    const { loadOrCreateReplica } = await import('../sync/replicaId.js');
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    // Capture written into the per-replica log carries (replicaId, lamport).
    await eventLog.appendClient({
      clientEventId: 'capture-A',
      aggregateId: 'thread_a',
      type: 'capture.recorded',
      payload: {
        bac_id: 'thread_a',
        capturedAt: '2026-05-03T00:00:00.000Z',
        turns: [
          { ordinal: 0, text: 'log first' },
          { ordinal: 1, text: 'log second' },
        ],
      },
      baseVector: {},
    });
    // Same capture in the legacy file — must be skipped.
    await writeFile(
      join(vaultRoot, '_BAC', 'events', '2026-05-03.jsonl'),
      JSON.stringify({
        bac_id: 'thread_a',
        capturedAt: '2026-05-03T00:00:00.000Z',
        turns: [{ ordinal: 0, text: 'should be skipped' }],
      }),
      'utf8',
    );

    const result = await rebuildFromEventLog(vaultRoot, join(vaultRoot, '_BAC', 'events'), {
      eventLog,
    });
    const index = await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin'));
    // V3 rebuild emits one entry per chunk. Both turns are short
    // single-paragraph captures, so each produces exactly one chunk.
    expect(result.indexed).toBe(2);
    // chunkIds carry the source bac_id + turnOrdinal + paragraph
    // index + a content hash so they're deterministic across rebuilds.
    expect(index?.items.map((item) => item.id).every((id) => id.startsWith('chunk:thread_a:'))).toBe(
      true,
    );
    // Per-replica stamp survives the chunk projection — a multi-
    // replica reader can still merge by (chunkId, replicaId).
    expect(index?.items.every((item) => item.replicaId === replica.replicaId)).toBe(true);
    // Chunk metadata round-trips through the V3 index.
    const texts = index?.items.map((item) => item.metadata?.text) ?? [];
    expect(new Set(texts)).toEqual(new Set(['log first', 'log second']));
    expect(index?.items.every((item) => item.metadata?.sourceBacId === 'thread_a')).toBe(true);
  });

  it('applies recall.tombstone.target events from the merged log', async () => {
    const { createEventLog } = await import('../sync/eventLog.js');
    const { loadOrCreateReplica } = await import('../sync/replicaId.js');
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    await eventLog.appendClient({
      clientEventId: 'capture-x',
      aggregateId: 'thread_x',
      type: 'capture.recorded',
      payload: {
        bac_id: 'thread_x',
        capturedAt: '2026-05-03T00:00:00.000Z',
        turns: [{ ordinal: 0, text: 'goodbye' }],
      },
      baseVector: {},
    });
    await eventLog.appendClient({
      clientEventId: 'tomb-x',
      aggregateId: 'thread_x',
      type: 'recall.tombstone.target',
      payload: { threadId: 'thread_x' },
      baseVector: {},
    });
    await rebuildFromEventLog(vaultRoot, join(vaultRoot, '_BAC', 'events'), { eventLog });
    const index = await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin'));
    expect(index?.items.map((item) => item.tombstoned)).toEqual([true]);
  });

  it('produces byte-identical output across runs given the same merged event log (deterministic build)', async () => {
    await writeFile(
      join(vaultRoot, '_BAC', 'events', '2026-05-03.jsonl'),
      [
        // Out-of-order ordinals across a couple of threads — the
        // canonical sort in writeIndex must wash this out.
        JSON.stringify({
          bac_id: 'thread_b',
          capturedAt: '2026-05-03T00:00:00.000Z',
          turns: [
            { ordinal: 1, text: 'b second' },
            { ordinal: 0, text: 'b first' },
          ],
        }),
        JSON.stringify({
          bac_id: 'thread_a',
          capturedAt: '2026-05-03T00:01:00.000Z',
          turns: [
            { ordinal: 2, text: 'a third' },
            { ordinal: 0, text: 'a first' },
            { ordinal: 1, text: 'a second' },
          ],
        }),
      ].join('\n'),
      'utf8',
    );

    const indexPath = join(vaultRoot, '_BAC', 'recall', 'index.bin');
    await rebuildFromEventLog(vaultRoot, join(vaultRoot, '_BAC', 'events'));
    const firstBytes = await readFile(indexPath);

    // Tear down everything but keep the same source data, then
    // rebuild a second time into a fresh dir from the same input.
    const secondRoot = await mkdtemp(join(tmpdir(), 'sidetrack-rebuild-determinism-'));
    try {
      await mkdir(join(secondRoot, '_BAC', 'events'), { recursive: true });
      await writeFile(
        join(secondRoot, '_BAC', 'events', '2026-05-03.jsonl'),
        await readFile(join(vaultRoot, '_BAC', 'events', '2026-05-03.jsonl')),
      );
      await rebuildFromEventLog(secondRoot, join(secondRoot, '_BAC', 'events'));
      const secondBytes = await readFile(join(secondRoot, '_BAC', 'recall', 'index.bin'));
      expect(secondBytes.equals(firstBytes)).toBe(true);
    } finally {
      await rm(secondRoot, { recursive: true, force: true });
    }
  });
});
