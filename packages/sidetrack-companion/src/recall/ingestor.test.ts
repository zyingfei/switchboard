import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installStubEmbedder, type StubEmbedderHandle } from '../test-helpers/stubEmbedder.js';
import { ingestIncremental, readIngestState, readRecallManifest } from './ingestor.js';
import { readIndex } from './indexFile.js';

// The embedder is stubbed through the production `setEmbedderOverride`
// seam (see installStubEmbedder) rather than a module mock — `bun test`
// has no `vi.importActual` and `vi.mock` leaks process-globally here.
describe('ingestor', () => {
  let vaultRoot: string;
  let stubEmbedder: StubEmbedderHandle;

  beforeEach(async () => {
    stubEmbedder = installStubEmbedder();
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-ingestor-'));
  });

  afterEach(async () => {
    stubEmbedder.restore();
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

  it('dedups recall-index ingest by threadId, role, and content hash', async () => {
    const { createEventLog } = await import('../sync/eventLog.js');
    const { loadOrCreateReplica } = await import('../sync/replicaId.js');
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);

    for (const ordinal of [0, 1]) {
      await eventLog.appendClient({
        clientEventId: `cap-dup-${String(ordinal)}`,
        aggregateId: 'thread_dup',
        type: 'capture.recorded',
        payload: {
          bac_id: 'thread_dup',
          threadId: 'thread_dup',
          capturedAt: '2026-05-06T18:00:00.000Z',
          turns: [{ ordinal, role: 'assistant', text: 'same recalled answer' }],
        },
        baseVector: {},
      });
    }

    const summary = await ingestIncremental(vaultRoot, eventLog);
    expect(summary.indexedChunks).toBe(1);
    const index = await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin'));
    const live = (index?.items ?? []).filter(
      (item) =>
        item.threadId === 'thread_dup' &&
        item.metadata?.role === 'assistant' &&
        item.metadata?.textHash !== undefined,
    );
    expect(live).toHaveLength(1);
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

  it('T3.1 — peer-imported capture is chunked + indexed; chunks stamped with the origin replicaId', async () => {
    // PR #93's invariant: events imported via importPeerEvent
    // preserve their origin dot.replicaId in the recall index, NOT
    // the local replica's. A buggy ingestor that re-stamped chunks
    // with the local replicaId would lose attribution + break
    // multi-replica merge by (chunkId, replicaId).
    const { createEventLog } = await import('../sync/eventLog.js');
    const { loadOrCreateReplica } = await import('../sync/replicaId.js');
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);

    const peerReplicaId = 'remote-peer-aaa';
    await eventLog.importPeerEvent({
      clientEventId: 'peer-capture-1',
      dot: { replicaId: peerReplicaId, seq: 7 },
      deps: {},
      aggregateId: 'thread_peer_capture',
      type: 'capture.recorded',
      payload: {
        bac_id: 'thread_peer_capture',
        capturedAt: '2026-05-07T07:00:00.000Z',
        turns: [{ ordinal: 0, role: 'user', text: 'peer-imported turn' }],
      },
      acceptedAtMs: 1_780_000_000_000,
    });

    const result = await ingestIncremental(vaultRoot, eventLog);
    expect(result.indexedChunks).toBeGreaterThan(0);
    const index = await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin'));
    const peerChunks = (index?.items ?? []).filter(
      (item) => item.threadId === 'thread_peer_capture',
    );
    expect(peerChunks.length).toBeGreaterThan(0);
    // Origin replicaId preserved end-to-end. Cross-replica merge
    // by (chunkId, replicaId) depends on this — re-stamping with
    // the local id would silently dedupe two distinct replicas'
    // events.
    expect(peerChunks.every((item) => item.replicaId === peerReplicaId)).toBe(true);
    // dot.seq → lamport/per-replica seq on the index entry.
    expect(peerChunks.every((item) => item.lamport === 7)).toBe(true);
  });

  it('T3.6 — same merged log on two replicas produces byte-equal index files (cross-replica determinism)', async () => {
    // PR #93's deterministic-build invariant extends across
    // replicas: if A and B observe the same set of dots in the
    // merged log, their recall index files are byte-equal. This is
    // the property that makes "rebuild from source-of-truth log"
    // safe — peers don't drift just because they project at
    // different times.
    const { createEventLog } = await import('../sync/eventLog.js');
    const { loadOrCreateReplica } = await import('../sync/replicaId.js');
    const { readFile } = await import('node:fs/promises');

    const seedReplica = async (root: string) => {
      const r = await loadOrCreateReplica(root);
      const log = createEventLog(root, r);
      // Both replicas import the SAME peer-event sequence — that's
      // the cross-replica determinism setup. Local-emit writes
      // would assign each replica its own dot/seq, breaking the
      // merged-log equivalence; importPeerEvent preserves the
      // foreign dot exactly.
      const events: Parameters<typeof log.importPeerEvent>[0][] = [
        {
          clientEventId: 'det-1',
          dot: { replicaId: 'origin-X', seq: 1 },
          deps: {},
          aggregateId: 'thread_det_a',
          type: 'capture.recorded',
          payload: {
            bac_id: 'thread_det_a',
            capturedAt: '2026-05-07T08:00:00.000Z',
            turns: [{ ordinal: 0, role: 'user', text: 'first' }],
          },
          acceptedAtMs: 1_780_000_100_000,
        },
        {
          clientEventId: 'det-2',
          dot: { replicaId: 'origin-Y', seq: 1 },
          deps: {},
          aggregateId: 'thread_det_b',
          type: 'capture.recorded',
          payload: {
            bac_id: 'thread_det_b',
            capturedAt: '2026-05-07T08:00:01.000Z',
            turns: [{ ordinal: 0, role: 'user', text: 'second' }],
          },
          acceptedAtMs: 1_780_000_100_001,
        },
      ];
      for (const event of events) await log.importPeerEvent(event);
      await ingestIncremental(root, log);
      return readFile(join(root, '_BAC', 'recall', 'index.bin'));
    };

    const replicaA = await mkdtemp(join(tmpdir(), 'sidetrack-det-A-'));
    const replicaB = await mkdtemp(join(tmpdir(), 'sidetrack-det-B-'));
    try {
      const [bytesA, bytesB] = await Promise.all([seedReplica(replicaA), seedReplica(replicaB)]);
      expect(bytesA.equals(bytesB)).toBe(true);
    } finally {
      await rm(replicaA, { recursive: true, force: true });
      await rm(replicaB, { recursive: true, force: true });
    }
  });

  it('T3.3 — peer capture from replica A + concurrent peer tombstone from replica B → target-level tombstone', async () => {
    // Corrected P0 case from the test plan. Recall tombstones are
    // target-level (NOT observed-remove): a tombstone targeting
    // threadId T flips every chunk for T to tombstoned=true,
    // regardless of causal relation to the captures it covers.
    //
    // Setup: replica A captures thread T; replica B emits the
    // tombstone WITHOUT observing A's capture (empty deps).
    // Both arrive at THIS replica via importPeerEvent — exactly
    // the path the relay takes when fanning peer events out.
    //
    // Invariants asserted, layered per the test plan:
    //   layer-1 event-log: both events present in the merged log.
    //   layer-2 projection: A's chunks land in the index with
    //     tombstoned=true. (Key target-level distinction —
    //     OR-Set add-wins would have left them tombstoned=false
    //     because B's tombstone has no causal observation of A's
    //     capture.)
    //   layer-3 query: not asserted here; that's an HTTP-route
    //     test. ingestor-level coverage stops at the projection
    //     flag.
    const { createEventLog } = await import('../sync/eventLog.js');
    const { loadOrCreateReplica } = await import('../sync/replicaId.js');
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);

    // Peer event from replica A: capture.
    await eventLog.importPeerEvent({
      clientEventId: 'peer-A-capture',
      dot: { replicaId: 'replica-A-aaaaaa', seq: 1 },
      deps: {},
      aggregateId: 'thread_concurrent',
      type: 'capture.recorded',
      payload: {
        bac_id: 'thread_concurrent',
        capturedAt: '2026-05-07T07:00:00.000Z',
        turns: [{ ordinal: 0, role: 'user', text: 'concurrent peer-A turn' }],
      },
      acceptedAtMs: 1_780_000_000_000,
    });
    // Peer event from replica B: tombstone with empty deps —
    // explicitly does NOT observe A's capture.
    await eventLog.importPeerEvent({
      clientEventId: 'peer-B-tombstone',
      dot: { replicaId: 'replica-B-bbbbbb', seq: 1 },
      deps: {},
      aggregateId: 'thread_concurrent',
      type: 'recall.tombstone.target',
      payload: { threadId: 'thread_concurrent' },
      acceptedAtMs: 1_780_000_000_001,
    });

    // Layer-1: both events present in the merged log.
    const merged = await eventLog.readMerged();
    expect(merged.map((e) => e.type).sort()).toEqual([
      'capture.recorded',
      'recall.tombstone.target',
    ]);

    // Run the ingestor over the merged log.
    const result = await ingestIncremental(vaultRoot, eventLog);
    // Indexer ran the chunker on A's capture in the same batch as
    // B's tombstone; tombstonedThreads.has(threadId) returned true
    // → newly produced chunks land tombstoned=true. tombstoneByThread
    // also runs over existing entries (idempotent here).
    expect(result.indexedChunks).toBeGreaterThan(0);

    // Layer-2: chunks for thread_concurrent are present AND
    // tombstoned. Target-level semantics: NOT add-wins.
    const index = await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin'));
    const concurrent = (index?.items ?? []).filter((item) => item.threadId === 'thread_concurrent');
    expect(concurrent.length).toBeGreaterThan(0);
    expect(concurrent.every((item) => item.tombstoned === true)).toBe(true);
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

  it('reviewer-flagged: incremental tombstone honored for delayed captures landing AFTER a tombstone (rebuild equivalence)', async () => {
    // Reviewer scenario: the tombstone is processed FIRST.
    // The frontier advances past it. THEN a delayed peer capture
    // for the same thread arrives. Incremental ingest must still
    // mark the new chunks as tombstoned — otherwise it diverges
    // from full rebuild semantics.
    const { createEventLog } = await import('../sync/eventLog.js');
    const { loadOrCreateReplica } = await import('../sync/replicaId.js');
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);

    // 1. Tombstone arrives first.
    await eventLog.appendClient({
      clientEventId: 'tomb-first',
      aggregateId: 'thread_delayed',
      type: 'recall.tombstone.target',
      payload: { threadId: 'thread_delayed' },
      baseVector: {},
    });
    const first = await ingestIncremental(vaultRoot, eventLog);
    expect(first.indexedChunks).toBe(0);

    // 2. A peer-imported capture for the same thread arrives later.
    await eventLog.importPeerEvent({
      clientEventId: 'cap-late',
      dot: { replicaId: 'peer-X', seq: 1 },
      deps: {},
      aggregateId: 'thread_delayed',
      type: 'capture.recorded',
      payload: {
        bac_id: 'thread_delayed',
        capturedAt: '2026-05-06T19:00:00.000Z',
        turns: [{ ordinal: 0, role: 'assistant', text: 'should land tombstoned, not live' }],
      },
      acceptedAtMs: Date.now(),
    });

    // 3. Incremental ingest. The new chunks must be tombstoned —
    // they're for a thread that was previously deleted. A buggy
    // implementation would only consider FRESH tombstones and
    // index this capture as live.
    const second = await ingestIncremental(vaultRoot, eventLog);
    expect(second.indexedChunks).toBeGreaterThan(0);
    const index = await readIndex(join(vaultRoot, '_BAC', 'recall', 'index.bin'));
    const peerChunks = index?.items.filter((item) => item.threadId === 'thread_delayed') ?? [];
    expect(peerChunks.length).toBeGreaterThan(0);
    expect(
      peerChunks.every((item) => item.tombstoned === true),
      'delayed-capture chunks must inherit the prior tombstone (rebuild equivalence)',
    ).toBe(true);
  });
});
