import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ingestIncremental, readIngestState, readRecallManifest } from './ingestor.js';
import { readIndex } from './indexFile.js';

vi.mock('./embedder.js', async () => {
  const real = await vi.importActual<typeof import('./embedder.js')>('./embedder.js');
  return {
    ...real,
    embed: async (texts: readonly string[]) =>
      texts.map(() => {
        const v = new Float32Array(384);
        v[0] = 1;
        return v;
      }),
  };
});

describe('ingestor', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-ingestor-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('projects new capture.recorded events into chunk entries and advances the frontier', async () => {
    const { createEventLog } = await import('../sync/eventLog.js');
    const { loadOrCreateReplica } = await import('../sync/replicaId.js');
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);

    await eventLog.appendClient({
      clientEventId: 'cap-1',
      aggregateId: 'thread_1',
      type: 'capture.recorded',
      payload: {
        bac_id: 'thread_1',
        capturedAt: '2026-05-06T18:00:00.000Z',
        turns: [{ ordinal: 0, role: 'assistant', text: 'Hello world from chunk one.' }],
      },
      baseVector: {},
    });

    const summary = await ingestIncremental(vaultRoot, eventLog);
    expect(summary.indexedChunks).toBeGreaterThan(0);

    const state = await readIngestState(vaultRoot);
    expect(state.processedEvents[replica.replicaId]).toBeGreaterThan(0);
    expect(state.lastIncrementalIngestAt).toBeDefined();

    const manifest = await readRecallManifest(vaultRoot);
    expect(manifest).not.toBeNull();
    expect(manifest?.modelId).toContain('multilingual-e5-small');

    const index = await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin'));
    expect(index?.items.length ?? 0).toBeGreaterThan(0);
    expect(index?.items[0]?.metadata?.text).toContain('Hello world');
  });

  it('is idempotent — replaying a no-op ingest produces no new entries', async () => {
    const { createEventLog } = await import('../sync/eventLog.js');
    const { loadOrCreateReplica } = await import('../sync/replicaId.js');
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);

    await eventLog.appendClient({
      clientEventId: 'cap-once',
      aggregateId: 'thread_x',
      type: 'capture.recorded',
      payload: {
        bac_id: 'thread_x',
        capturedAt: '2026-05-06T18:00:00.000Z',
        turns: [{ ordinal: 0, role: 'assistant', text: 'one and only' }],
      },
      baseVector: {},
    });

    const first = await ingestIncremental(vaultRoot, eventLog);
    const second = await ingestIncremental(vaultRoot, eventLog);
    expect(first.indexedChunks).toBeGreaterThan(0);
    expect(second.indexedChunks).toBe(0);
    const index = await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin'));
    // chunkIds are deterministic; replaying must not duplicate.
    const ids = (index?.items ?? []).map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('honors recall.tombstone.target events from the merged log', async () => {
    const { createEventLog } = await import('../sync/eventLog.js');
    const { loadOrCreateReplica } = await import('../sync/replicaId.js');
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);

    await eventLog.appendClient({
      clientEventId: 'cap-tomb',
      aggregateId: 'thread_tomb',
      type: 'capture.recorded',
      payload: {
        bac_id: 'thread_tomb',
        capturedAt: '2026-05-06T18:00:00.000Z',
        turns: [{ ordinal: 0, role: 'assistant', text: 'soon to be tombstoned' }],
      },
      baseVector: {},
    });
    await eventLog.appendClient({
      clientEventId: 'tomb-1',
      aggregateId: 'thread_tomb',
      type: 'recall.tombstone.target',
      payload: { threadId: 'thread_tomb' },
      baseVector: {},
    });

    await ingestIncremental(vaultRoot, eventLog);
    const index = await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin'));
    expect(index?.items.length).toBeGreaterThan(0);
    expect(index?.items.every((item) => item.tombstoned === true)).toBe(true);
  });

  it('applies a tombstone that arrives AFTER the capture has already been ingested', async () => {
    // Regression for the "tombstone consumed but never applied to
    // existing entries" bug. Sequence:
    //   1. ingest a capture → entries land tombstoned: false
    //   2. append a tombstone targeting that thread
    //   3. ingest again — must flip the existing entries
    const { createEventLog } = await import('../sync/eventLog.js');
    const { loadOrCreateReplica } = await import('../sync/replicaId.js');
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);

    await eventLog.appendClient({
      clientEventId: 'cap-late',
      aggregateId: 'thread_late',
      type: 'capture.recorded',
      payload: {
        bac_id: 'thread_late',
        capturedAt: '2026-05-06T18:00:00.000Z',
        turns: [{ ordinal: 0, role: 'assistant', text: 'soon to be tombstoned' }],
      },
      baseVector: {},
    });
    const first = await ingestIncremental(vaultRoot, eventLog);
    expect(first.indexedChunks).toBeGreaterThan(0);
    const after1 = await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin'));
    expect(after1?.items.every((item) => item.tombstoned !== true)).toBe(true);

    // Append the tombstone AFTER the first ingest. The frontier
    // already advanced past the capture event, so a buggy ingestor
    // would not touch the existing entries here.
    await eventLog.appendClient({
      clientEventId: 'tomb-late',
      aggregateId: 'thread_late',
      type: 'recall.tombstone.target',
      payload: { threadId: 'thread_late' },
      baseVector: {},
    });
    const second = await ingestIncremental(vaultRoot, eventLog);
    // No new chunks (no fresh capture.recorded), but the existing
    // entries should now be tombstoned.
    expect(second.indexedChunks).toBe(0);
    expect(second.tombstonedEntries).toBeGreaterThan(0);
    const after2 = await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin'));
    expect(after2?.items.every((item) => item.tombstoned === true)).toBe(true);
  });
});
