import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from './causal.js';
import { createEventLog } from './eventLog.js';
import { loadOrCreateReplica, type ReplicaContext } from './replicaId.js';

describe('event log', () => {
  let vaultRoot: string;
  let replica: ReplicaContext;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-event-log-'));
    replica = await loadOrCreateReplica(vaultRoot);
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('appends events under _BAC/log/<replicaId>/<date>.jsonl with server-stamped dot/deps/acceptedAtMs', async () => {
    const fixedAt = new Date('2026-05-05T12:00:00.000Z');
    const log = createEventLog(vaultRoot, replica, { now: () => fixedAt });

    const event = await log.appendClient({
      clientEventId: 'evt-1',
      aggregateId: 'thread-1',
      type: 'review-draft.span.added',
      payload: { spanId: 's-1' },
      baseVector: {},
    });

    expect(event.dot.replicaId).toBe(replica.replicaId);
    expect(event.dot.seq).toBe(1);
    expect(event.acceptedAtMs).toBe(fixedAt.getTime());
    expect(event.deps).toEqual({});

    const path = join(vaultRoot, '_BAC', 'log', replica.replicaId, '2026-05-05.jsonl');
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text.trim()) as AcceptedEvent;
    expect(parsed.clientEventId).toBe('evt-1');
    expect(parsed.dot.seq).toBe(1);
  });

  it('idempotent retry returns the same AcceptedEvent — same dot, same acceptedAtMs', async () => {
    let nowMs = 1_000_000;
    const log = createEventLog(vaultRoot, replica, {
      now: () => new Date(nowMs),
    });

    const first = await log.appendClient({
      clientEventId: 'evt-retry',
      aggregateId: 'thread-1',
      type: 'review-draft.span.added',
      payload: { spanId: 's-1' },
      baseVector: {},
    });
    nowMs += 5_000;
    const second = await log.appendClient({
      clientEventId: 'evt-retry',
      aggregateId: 'thread-1',
      type: 'review-draft.span.added',
      // Even if the client retried with stale baseVector, the
      // companion must return the original AcceptedEvent unchanged.
      payload: { spanId: 's-1' },
      baseVector: { 'pretend-peer': 99 },
    });

    expect(second.clientEventId).toBe(first.clientEventId);
    expect(second.dot).toEqual(first.dot);
    expect(second.acceptedAtMs).toBe(first.acceptedAtMs);
  });

  it('serialises concurrent appendClient calls so dot.seq is dense and unique', async () => {
    const log = createEventLog(vaultRoot, replica);
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        log.appendClient({
          clientEventId: `evt-${String(i)}`,
          aggregateId: 'agg',
          type: 'noop',
          payload: {},
          baseVector: {},
        }),
      ),
    );
    const seqs = results.map((event) => event.dot.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it('stamps deps from the client baseVector verbatim — does NOT use the companion frontier', async () => {
    const log = createEventLog(vaultRoot, replica);
    // Simulate a peer event landing first (e.g. via Syncthing).
    const peerDir = join(vaultRoot, '_BAC', 'log', '00000000-1111-4222-8333-444444444444');
    await mkdir(peerDir, { recursive: true });
    const peer: AcceptedEvent = {
      clientEventId: 'peer-1',
      dot: { replicaId: '00000000-1111-4222-8333-444444444444', seq: 7 },
      deps: {},
      aggregateId: 'thread-1',
      type: 'review-draft.span.added',
      payload: {},
      acceptedAtMs: 1,
    };
    await writeFile(join(peerDir, '2026-05-05.jsonl'), `${JSON.stringify(peer)}\n`, 'utf8');

    // Browser submits an OLD edit whose baseVector pre-dates the peer
    // event. The companion must not silently bump deps to include
    // the peer.
    const accepted = await log.appendClient({
      clientEventId: 'local-1',
      aggregateId: 'thread-1',
      type: 'review-draft.comment.set',
      payload: { spanId: 's-1', text: 'edited offline' },
      baseVector: {},
    });
    expect(accepted.deps).toEqual({});
  });

  it('F11 — no explicit baseVector → deps default to the union of prior events for the same aggregate', async () => {
    // Server-side handlers (POST /v1/threads, POST /v1/workstreams,
    // …) used to pass `baseVector: {}` on every emit. That made
    // every register write causally concurrent with every prior
    // write to the same record — e.g. the user moved a thread, the
    // event was emitted, but the projection had N candidates with
    // the move buried among reverts and the receiver picked the
    // wrong one. Defaulting an unset baseVector to the aggregate's
    // prior frontier makes a sequential write actually dominate.
    const log = createEventLog(vaultRoot, replica);
    const first = await log.appendClient({
      clientEventId: 'mv-1',
      aggregateId: 'thread-mv',
      type: 'thread.upserted',
      payload: { bac_id: 'thread-mv', primaryWorkstreamId: 'ws-A' },
      baseVector: {},
    });
    // No baseVector on the next append — should auto-resolve to
    // {<replica>: <first.dot.seq>} so the second event causally
    // dominates the first.
    const second = await log.appendClient({
      clientEventId: 'mv-2',
      aggregateId: 'thread-mv',
      type: 'thread.upserted',
      payload: { bac_id: 'thread-mv', primaryWorkstreamId: 'ws-B' },
    });
    expect(second.deps[first.dot.replicaId]).toBe(first.dot.seq);
    // Events for OTHER aggregates don't leak into the deps —
    // a brand-new aggregate's first emit should still have empty
    // deps.
    const otherFirst = await log.appendClient({
      clientEventId: 'other-1',
      aggregateId: 'thread-other',
      type: 'thread.upserted',
      payload: { bac_id: 'thread-other' },
    });
    expect(otherFirst.deps).toEqual({});
  });

  it('resolves clientDeps within the same batch into deps', async () => {
    const log = createEventLog(vaultRoot, replica);
    const first = await log.appendClient({
      clientEventId: 'first',
      aggregateId: 'thread-1',
      type: 'review-draft.span.added',
      payload: { spanId: 's-1' },
      baseVector: {},
    });
    const second = await log.appendClient({
      clientEventId: 'second',
      aggregateId: 'thread-1',
      type: 'review-draft.comment.set',
      payload: { spanId: 's-1', text: 'hi' },
      baseVector: {},
      clientDeps: ['first'],
    });
    expect(second.deps[first.dot.replicaId]).toBe(first.dot.seq);
  });

  it('readMerged + readByAggregate filter and sort consistently', async () => {
    const log = createEventLog(vaultRoot, replica);
    await log.appendClient({
      clientEventId: 'a',
      aggregateId: 't1',
      type: 'noop',
      payload: {},
      baseVector: {},
    });
    await log.appendClient({
      clientEventId: 'b',
      aggregateId: 't2',
      type: 'noop',
      payload: {},
      baseVector: {},
    });
    await log.appendClient({
      clientEventId: 'c',
      aggregateId: 't1',
      type: 'noop',
      payload: {},
      baseVector: {},
    });
    expect((await log.readByAggregate('t1')).map((e) => e.clientEventId)).toEqual(['a', 'c']);
    expect((await log.readByAggregate('t2')).map((e) => e.clientEventId)).toEqual(['b']);
    expect((await log.readMerged()).map((e) => e.clientEventId)).toEqual(['a', 'b', 'c']);
  });

  it('rotates files by server date', async () => {
    const log = createEventLog(vaultRoot, replica, {
      now: () => new Date('2026-05-05T23:59:59.999Z'),
    });
    await log.appendClient({
      clientEventId: 'before',
      aggregateId: 'a',
      type: 'noop',
      payload: {},
      baseVector: {},
    });
    const log2 = createEventLog(vaultRoot, replica, {
      now: () => new Date('2026-05-06T00:00:00.001Z'),
    });
    await log2.appendClient({
      clientEventId: 'after',
      aggregateId: 'a',
      type: 'noop',
      payload: {},
      baseVector: {},
    });
    const files = await readdir(join(vaultRoot, '_BAC', 'log', replica.replicaId));
    expect(files.sort()).toEqual(['2026-05-05.jsonl', '2026-05-06.jsonl']);
  });

  it('skips malformed JSONL lines without throwing', async () => {
    const log = createEventLog(vaultRoot, replica, {
      now: () => new Date('2026-05-05T12:00:00.000Z'),
    });
    await log.appendClient({
      clientEventId: 'good',
      aggregateId: 'a',
      type: 'noop',
      payload: {},
      baseVector: {},
    });
    const path = join(vaultRoot, '_BAC', 'log', replica.replicaId, '2026-05-05.jsonl');
    await writeFile(
      path,
      `${await readFile(path, 'utf8')}not-json\n{"missing":"fields"}\n`,
      'utf8',
    );
    const events = await log.readReplica(replica.replicaId);
    expect(events.map((event) => event.clientEventId)).toEqual(['good']);
  });

  it('importPeerEvent: byte-identical re-delivery is a no-op', async () => {
    const log = createEventLog(vaultRoot, replica);
    const peer: AcceptedEvent = {
      clientEventId: 'p-1',
      dot: { replicaId: 'peer-A', seq: 1 },
      deps: {},
      aggregateId: 'agg',
      type: 'noop',
      payload: { x: 1 },
      acceptedAtMs: 100,
    };
    const first = await log.importPeerEvent(peer);
    const second = await log.importPeerEvent(peer);
    expect(first.imported).toBe(true);
    expect(second.imported).toBe(false);
    const stored = await log.readReplica('peer-A');
    expect(stored).toHaveLength(1);
  });

  it('importPeerEvent: same dot + different content throws DotCollisionError', async () => {
    const { DotCollisionError } = await import('./eventLog.js');
    const log = createEventLog(vaultRoot, replica);
    const a: AcceptedEvent = {
      clientEventId: 'p-a',
      dot: { replicaId: 'peer-X', seq: 5 },
      deps: {},
      aggregateId: 'agg',
      type: 'noop',
      payload: { x: 1 },
      acceptedAtMs: 100,
    };
    const b: AcceptedEvent = {
      ...a,
      clientEventId: 'p-b', // different clientEventId, same dot
      payload: { x: 2 },
    };
    await log.importPeerEvent(a);
    await expect(log.importPeerEvent(b)).rejects.toBeInstanceOf(DotCollisionError);
  });

  it('importPeerEvent: same clientEventId + different dot throws ClientEventIdReuseError', async () => {
    const { ClientEventIdReuseError } = await import('./eventLog.js');
    const log = createEventLog(vaultRoot, replica);
    const a: AcceptedEvent = {
      clientEventId: 'reused',
      dot: { replicaId: 'peer-X', seq: 1 },
      deps: {},
      aggregateId: 'agg',
      type: 'noop',
      payload: {},
      acceptedAtMs: 100,
    };
    const b: AcceptedEvent = {
      ...a,
      dot: { replicaId: 'peer-Y', seq: 1 },
    };
    await log.importPeerEvent(a);
    await expect(log.importPeerEvent(b)).rejects.toBeInstanceOf(ClientEventIdReuseError);
  });

  it('importPeerEvent: refuses to import an event that claims our own replica id', async () => {
    const log = createEventLog(vaultRoot, replica);
    const result = await log.importPeerEvent({
      clientEventId: 'spoof',
      dot: { replicaId: replica.replicaId, seq: 999 },
      deps: {},
      aggregateId: 'agg',
      type: 'noop',
      payload: {},
      acceptedAtMs: 100,
    });
    expect(result.imported).toBe(false);
  });

  it('returns empty merged log when _BAC/log/ does not exist yet', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'sidetrack-event-log-empty-'));
    try {
      const freshReplica = await loadOrCreateReplica(fresh);
      const log = createEventLog(fresh, freshReplica);
      expect(await log.readMerged()).toEqual([]);
      expect(await log.listReplicaIds()).toEqual([]);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it('appendClientObservedBatch onAccepted hook fires once per NEW event, never for dedupes', async () => {
    // The timeline ingest (POST /v1/timeline/events) batches the
    // dedupe scan but must still dispatch each accepted event to the
    // contract runner. The hook is how it does that — it must fire
    // exactly once per genuinely-new event and never for a duplicate
    // clientEventId, or the timeline/projection materializers would
    // either miss an event or double-process one.
    const log = createEventLog(vaultRoot, replica);
    const mk = (id: string, x: number) => ({
      clientEventId: id,
      aggregateId: 'agg-batch',
      type: 'browser.timeline.observed',
      payload: { x },
      baseVector: {},
    });

    const seen1: { clientEventId: string; seq: number }[] = [];
    const batch1 = await log.appendClientObservedBatch([mk('b-1', 1), mk('b-2', 2)], (event) => {
      seen1.push({ clientEventId: event.clientEventId, seq: event.dot.seq });
    });
    expect(batch1.map((r) => r.imported)).toEqual([true, true]);
    // Hook fired per new event, with real server-stamped AcceptedEvents.
    expect(seen1.map((s) => s.clientEventId)).toEqual(['b-1', 'b-2']);
    expect(seen1.every((s) => s.seq > 0)).toBe(true);

    // Re-submit b-2 (duplicate) alongside a genuinely-new b-3.
    const seen2: string[] = [];
    const batch2 = await log.appendClientObservedBatch([mk('b-2', 2), mk('b-3', 3)], (event) => {
      seen2.push(event.clientEventId);
    });
    expect(batch2.map((r) => r.imported)).toEqual([false, true]);
    // Hook fired ONLY for b-3 — the deduped b-2 must not dispatch.
    expect(seen2).toEqual(['b-3']);
  });

  it('detects shard files written by another process and dedupes against them', async () => {
    // The append indexes are in-process; events can land in the vault
    // from OUTSIDE (CLI `import` against the same vault, file-level
    // sync dropping a peer shard in). The signature guard must rebuild
    // the indexes before any dedupe decision.
    const log = createEventLog(vaultRoot, replica);
    // Warm the indexes via a first append.
    await log.appendClient({
      clientEventId: 'local-1',
      aggregateId: 'agg-1',
      type: 'review-draft.span.added',
      payload: {},
      baseVector: {},
    });
    // External process writes a peer shard directly.
    const peerEvent: AcceptedEvent = {
      clientEventId: 'ext-1',
      dot: { replicaId: 'replica-ext', seq: 7 },
      deps: {},
      aggregateId: 'agg-ext',
      type: 'review-draft.span.added',
      payload: {},
      acceptedAtMs: Date.parse('2026-05-05T12:00:00.000Z'),
    };
    const dir = join(vaultRoot, '_BAC', 'log', 'replica-ext');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '2026-05-05.jsonl'), `${JSON.stringify(peerEvent)}\n`, 'utf8');

    // Relay redelivery of the SAME event must be a no-op, not a
    // duplicate shard line.
    expect(await log.importPeerEvent(peerEvent)).toEqual({ imported: false });

    // A local append reusing the externally-synced clientEventId must
    // dedupe to the existing event instead of minting a new dot.
    const deduped = await log.appendClientObserved({
      clientEventId: 'ext-1',
      aggregateId: 'agg-ext',
      type: 'review-draft.span.added',
      payload: {},
      baseVector: {},
    });
    expect(deduped.dot).toEqual({ replicaId: 'replica-ext', seq: 7 });
  });

  it('appendClientObservedBatch with no hook still appends + dedupes (edge-event path)', async () => {
    const log = createEventLog(vaultRoot, replica);
    const input = {
      clientEventId: 'no-hook-1',
      aggregateId: 'agg',
      type: 'engagement.interval.observed',
      payload: {},
      baseVector: {},
    };
    expect((await log.appendClientObservedBatch([input])).map((r) => r.imported)).toEqual([true]);
    expect((await log.appendClientObservedBatch([input])).map((r) => r.imported)).toEqual([false]);
    expect((await log.readMerged()).filter((e) => e.clientEventId === 'no-hook-1')).toHaveLength(1);
  });
});
