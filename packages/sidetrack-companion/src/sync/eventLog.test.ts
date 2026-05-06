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
});
