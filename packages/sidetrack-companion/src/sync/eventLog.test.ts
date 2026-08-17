import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type AcceptedEvent, vectorFromEvents } from './causal.js';
import { createEventLog } from './eventLog.js';
import {
  getEventLaneHealth,
  resetEventLaneHealthForTests,
} from './eventLaneHealth.js';
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
    // the indexes before any dedupe decision — but ONLY in the
    // external-writers mode (single-companion default skips the scan).
    const log = createEventLog(vaultRoot, replica, { externalWritersPossible: true });
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

describe('event-lane health counters', () => {
  let vaultRoot: string;
  let replica: ReplicaContext;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-event-lane-'));
    replica = await loadOrCreateReplica(vaultRoot);
    resetEventLaneHealthForTests();
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('getEventLaneHealth exposes a stable zero baseline after reset', () => {
    expect(getEventLaneHealth()).toEqual({
      skippedMalformedLines: 0,
      storeSkippedOutOfOrder: 0,
      dotCollisions: 0,
      duplicateCaptures: 0,
      unreadableShards: 0,
    });
  });

  it('counts a torn / malformed line skipped during readMerged (skippedMalformedLines)', async () => {
    // One valid event line, one torn tail (crash without fsync), one
    // JSON-parseable-but-not-an-AcceptedEvent line. Blank lines must NOT
    // count.
    const valid: AcceptedEvent = {
      clientEventId: 'v-1',
      dot: { replicaId: 'peer-torn', seq: 1 },
      deps: {},
      aggregateId: 'agg',
      type: 'noop',
      payload: { x: 1 },
      acceptedAtMs: 100,
    };
    const dir = join(vaultRoot, '_BAC', 'log', 'peer-torn');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, '2026-05-05.jsonl'),
      // valid line, torn tail (no closing brace), a valid-JSON non-event,
      // and a blank line (structural — not counted).
      `${JSON.stringify(valid)}\n{"clientEventId":"broke\n{"not":"an event"}\n\n`,
      'utf8',
    );

    const log = createEventLog(vaultRoot, replica);
    const before = getEventLaneHealth().skippedMalformedLines;
    const merged = await log.readMerged();
    // Only the valid event survives.
    expect(merged.map((e) => e.clientEventId)).toEqual(['v-1']);
    // The torn tail + the non-event line both counted; the blank did not.
    expect(getEventLaneHealth().skippedMalformedLines).toBe(before + 2);
  });

  it('counts a dot collision on importPeerEvent (dotCollisions)', async () => {
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
    const b: AcceptedEvent = { ...a, clientEventId: 'p-b', payload: { x: 2 } };
    await log.importPeerEvent(a);
    const before = getEventLaneHealth().dotCollisions;
    await expect(log.importPeerEvent(b)).rejects.toBeInstanceOf(DotCollisionError);
    expect(getEventLaneHealth().dotCollisions).toBe(before + 1);
  });

  it('counts a reused clientEventId on importPeerEvent (duplicateCaptures)', async () => {
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
    const b: AcceptedEvent = { ...a, dot: { replicaId: 'peer-Y', seq: 1 } };
    await log.importPeerEvent(a);
    const before = getEventLaneHealth().duplicateCaptures;
    await expect(log.importPeerEvent(b)).rejects.toBeInstanceOf(ClientEventIdReuseError);
    expect(getEventLaneHealth().duplicateCaptures).toBe(before + 1);
  });

  it('readMergedSince tolerates a shard-read error without throwing + counts unreadableShards', async () => {
    // Two shards for the same peer replica: an OLDER readable one and a
    // NEWER unreadable one (chmod 000 → EACCES). readMergedSince must
    // skip the unreadable shard, count it, still return the readable
    // shard's events, and NOT throw out of the drain.
    const readable: AcceptedEvent = {
      clientEventId: 'r-1',
      dot: { replicaId: 'peer-R', seq: 1 },
      deps: {},
      aggregateId: 'agg',
      type: 'noop',
      payload: {},
      acceptedAtMs: 100,
    };
    const unreadable: AcceptedEvent = {
      clientEventId: 'r-2',
      dot: { replicaId: 'peer-R', seq: 2 },
      deps: { 'peer-R': 1 },
      aggregateId: 'agg',
      type: 'noop',
      payload: {},
      acceptedAtMs: 200,
    };
    const dir = join(vaultRoot, '_BAC', 'log', 'peer-R');
    await mkdir(dir, { recursive: true });
    // Sorted-reverse means '2026-05-06' (newer) is visited first.
    await writeFile(join(dir, '2026-05-05.jsonl'), `${JSON.stringify(readable)}\n`, 'utf8');
    const unreadablePath = join(dir, '2026-05-06.jsonl');
    await writeFile(unreadablePath, `${JSON.stringify(unreadable)}\n`, 'utf8');
    await chmod(unreadablePath, 0o000);

    const log = createEventLog(vaultRoot, replica);
    const before = getEventLaneHealth().unreadableShards;
    let events: readonly AcceptedEvent[];
    try {
      // Must resolve, not reject, even though the newest shard is
      // unreadable.
      events = await log.readMergedSince({});
    } finally {
      // Restore perms so afterEach cleanup can remove the temp dir.
      await chmod(unreadablePath, 0o644);
    }
    // The readable shard's event still came through.
    expect(events.map((e) => e.clientEventId)).toContain('r-1');
    // The unreadable shard was counted.
    expect(getEventLaneHealth().unreadableShards).toBe(before + 1);
  });
});

// A synthetic log whose WARM is expensive on purpose. Warm cost is
// dominated by PER-EVENT work (parse + three index writes + a vector
// allocation), not by bytes, so thin lines buy the most warm time per
// megabyte — and they also keep the mid-warm append's raw-line scan
// (which IS byte-bound) honest rather than flattering.
//
// Calibration: 350k lines ≈ 70 MB ≈ 0.95 s of warm on an M-series Bun,
// measured stable in-suite. `warmExceeds500ms` below asserts the
// property this seed exists to create; if a future machine drops it
// under 500 ms, raise WARM_SEED_EVENTS rather than lowering the bar.
const WARM_SEED_EVENTS = 350_000;

// Lines are written as text (not via appendClient) so seeding costs a
// few string joins instead of N durable appends.
const seedShards = async (
  vaultRoot: string,
  replicaId: string,
  count: number,
): Promise<void> => {
  const dir = join(vaultRoot, '_BAC', 'log', replicaId);
  await mkdir(dir, { recursive: true });
  const linesPerShard = 10_000;
  let written = 0;
  let shard = 1;
  while (written < count) {
    const lines: string[] = [];
    for (let i = 0; i < linesPerShard && written < count; i += 1, written += 1) {
      lines.push(
        `{"clientEventId":"seed-${String(written)}","dot":{"replicaId":"${replicaId}","seq":${String(written + 1)}},"deps":{},"aggregateId":"agg-${String(written % 500)}","type":"engagement.interval.observed","payload":{"u":"https://example.test/p/${String(written)}","focusedMs":${String(written % 9999)}},"acceptedAtMs":${String(1_700_000_000_000 + written)}}`,
      );
    }
    await writeFile(
      join(dir, `seed-${String(shard).padStart(4, '0')}.jsonl`),
      `${lines.join('\n')}\n`,
      'utf8',
    );
    shard += 1;
  }
};

const delay = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

// CI budget: these tests seed 40k-350k real event lines to disk (seedShards)
// and then walk them (prewarmAppendIndexes — sometimes twice, plus an oracle
// cold rebuild) to make the timing/ordering assertions meaningful at real
// scale. Locally that's well under 2s, but bun:test's 5000ms DEFAULT has
// been observed failing on the shared, contended CI runner — parsing/
// folding hundreds of thousands of lines is genuinely CPU-bound work whose
// wall-clock cost scales with runner contention, not a hang. Give each an
// explicit budget (same pattern as ae4a8d5a) instead of letting loaded-
// runner slowness block unrelated merges.
describe('append-index prewarm holds the append mutex only for bounded segments', () => {
  let vaultRoot: string;
  let replica: ReplicaContext;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-event-log-warm-'));
    replica = await loadOrCreateReplica(vaultRoot);
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('completes an append issued mid-warm without waiting for the rest of the warm', async () => {
    // The regression: prewarmAppendIndexes() used to run the whole
    // streaming pass as ONE enqueueAppend unit, so every write-shaped
    // endpoint sat behind the full warm — ~a minute after boot on a
    // real vault.
    await seedShards(vaultRoot, 'replica-seed', WARM_SEED_EVENTS);
    const log = createEventLog(vaultRoot, replica);

    const settled: string[] = [];
    const warmStartedAt = Date.now();
    const warm = log.prewarmAppendIndexes().then(() => {
      settled.push('warm');
    });
    // Let a few segments land first, then confirm the warm really is
    // mid-flight before the write is issued.
    await delay(50);
    expect(settled).toEqual([]);

    const appendStartedAt = Date.now();
    const appended = await log
      .appendClientObserved({
        clientEventId: 'mid-warm-write',
        aggregateId: 'agg-live',
        type: 'thread.upserted',
        payload: { bac_id: 'agg-live' },
        baseVector: {},
      })
      .then((event) => {
        settled.push('append');
        return event;
      });
    const appendMs = Date.now() - appendStartedAt;
    await warm;
    const warmMs = Date.now() - warmStartedAt;

    // The write is real and durable, not a short-circuit.
    expect(appended.dot.replicaId).toBe(replica.replicaId);
    expect(await log.findByClientEventId('mid-warm-write')).toEqual(appended);

    // Structural pin, independent of machine speed: the append
    // RESOLVED BEFORE the warm did. Under the single-unit warm that is
    // impossible — the append could not even start until the warm's
    // mutex task settled.
    expect(settled).toEqual(['append', 'warm']);

    // Precondition for the quantitative bound: this log is big enough
    // that the warm is not instantaneous.
    expect(warmMs).toBeGreaterThan(500);

    // Bound with margin. The append waits for at most ONE segment
    // (<= 2000 lines of parse+fold) plus its own single raw-line scan
    // for the ids it actually asks about; the warm parses and folds all
    // 350k lines. Measured ratio is ~0.15, and both numbers scale
    // together on a slower box, so half the warm leaves >3x headroom
    // while still failing loudly if an append ever goes back to waiting
    // for the whole pass (ratio ~1.0).
    expect(appendMs).toBeLessThan(warmMs / 2);
  }, 30_000);

  it('builds the same index a cold rebuild would, after a chunked warm with interleaved appends', async () => {
    await seedShards(vaultRoot, 'replica-seed', 40_000);
    const log = createEventLog(vaultRoot, replica);

    let warmDone = false;
    const warm = log.prewarmAppendIndexes().then(() => {
      warmDone = true;
    });

    const interleaved: AcceptedEvent[] = [];
    let issuedDuringWarm = 0;
    for (let i = 0; i < 12; i += 1) {
      const before = warmDone;
      const event = await log.appendClientObserved({
        clientEventId: `mid-${String(i)}`,
        aggregateId: 'agg-mid',
        type: 'thread.upserted',
        payload: { bac_id: 'agg-mid', step: i },
        baseVector: {},
      });
      if (!before) issuedDuringWarm += 1;
      interleaved.push(event);
      await delay(2);
    }
    await warm;
    // The test is only meaningful if writes actually landed mid-warm.
    expect(issuedDuringWarm).toBeGreaterThan(0);

    // Oracle: a FRESH event log over the same directory, warmed by a
    // cold walk that sees every line already on disk.
    const oracle = createEventLog(vaultRoot, replica);
    await oracle.prewarmAppendIndexes();

    // (a) Membership. findByClientEventId's negative fast path trusts
    // the warmed index, so an entry the chunked warm dropped surfaces
    // here as a null.
    for (const event of interleaved) {
      expect(await log.findByClientEventId(event.clientEventId)).toEqual(event);
    }
    expect(await log.findByClientEventId('seed-39999')).not.toBeNull();
    expect(await log.findByClientEventId('never-written')).toBeNull();
    expect(await oracle.findByClientEventId('never-written')).toBeNull();

    // (b) Dedupe. A replay of an interleaved id returns the SAME event
    // rather than minting a second dot for it.
    const replay = await log.appendClientObserved({
      clientEventId: 'mid-0',
      aggregateId: 'agg-mid',
      type: 'thread.upserted',
      payload: { bac_id: 'agg-mid', step: 0 },
      baseVector: {},
    });
    expect(replay).toEqual(interleaved[0] as AcceptedEvent);

    // (c) Aggregate frontier. A server-observed append stamps deps from
    // the aggregate's prior events — computed here from the cold read,
    // BEFORE the append that would otherwise join it.
    const expectedDeps = vectorFromEvents(await oracle.readByAggregate('agg-mid'));
    const serverObserved = await log.appendServerObserved({
      clientEventId: 'after-warm',
      aggregateId: 'agg-mid',
      type: 'thread.upserted',
      payload: { bac_id: 'agg-mid' },
    });
    expect(serverObserved.deps).toEqual(expectedDeps);
    expect(expectedDeps).not.toEqual({});
  }, 30_000);

  it('catches a foreign shard written between warm segments via the signature guard', async () => {
    await seedShards(vaultRoot, 'replica-seed', 40_000);
    const log = createEventLog(vaultRoot, replica, { externalWritersPossible: true });

    let warmDone = false;
    const warm = log.prewarmAppendIndexes().then(() => {
      warmDone = true;
    });
    await delay(20);
    expect(warmDone).toBe(false);

    // Another process drops a peer shard in — under a replica dir that
    // did not exist when the walk snapshotted the file list, so the
    // in-progress index can never contain it.
    const foreign: AcceptedEvent = {
      clientEventId: 'ext-mid-warm',
      dot: { replicaId: 'replica-ext', seq: 7 },
      deps: {},
      aggregateId: 'agg-ext',
      type: 'review-draft.span.added',
      payload: {},
      acceptedAtMs: Date.parse('2026-05-05T12:00:00.000Z'),
    };
    const foreignDir = join(vaultRoot, '_BAC', 'log', 'replica-ext');
    await mkdir(foreignDir, { recursive: true });
    await writeFile(join(foreignDir, '2026-05-05.jsonl'), `${JSON.stringify(foreign)}\n`, 'utf8');

    // Mid-warm, a local append reusing the externally-synced
    // clientEventId must dedupe to the foreign dot. A partially-warm
    // index would have answered "absent" and minted a second dot for
    // the same id — the ClientEventIdReuse that poisons sync.
    const deduped = await log.appendClientObserved({
      clientEventId: 'ext-mid-warm',
      aggregateId: 'agg-ext',
      type: 'review-draft.span.added',
      payload: {},
      baseVector: {},
    });
    expect(deduped.dot).toEqual({ replicaId: 'replica-ext', seq: 7 });
    // Still mid-warm — the append did not silently wait it out.
    expect(warmDone).toBe(false);

    await warm;
    // And the PUBLISHED index is not the pre-foreign snapshot: the
    // drift restarted the walk, so the negative fast path does not
    // hand out a stale "absent" for the foreign id.
    expect(await log.findByClientEventId('ext-mid-warm')).toEqual(foreign);
    const dedupedAgain = await log.appendClientObserved({
      clientEventId: 'ext-mid-warm',
      aggregateId: 'agg-ext',
      type: 'review-draft.span.added',
      payload: {},
      baseVector: {},
    });
    expect(dedupedAgain.dot).toEqual({ replicaId: 'replica-ext', seq: 7 });
  }, 30_000);
});
