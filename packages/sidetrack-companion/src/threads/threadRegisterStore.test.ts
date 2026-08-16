import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { THREAD_ARCHIVED, THREAD_DELETED, THREAD_UNARCHIVED, THREAD_UPSERTED } from './events.js';
import { projectThread } from './projection.js';
import { createThreadRegisterStore } from './threadRegisterStore.js';
import type { AcceptedEvent } from '../sync/causal.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const event = (input: {
  readonly type: string;
  readonly replicaId: string;
  readonly seq: number;
  readonly payload: Record<string, unknown>;
  readonly deps?: Record<string, number>;
  readonly acceptedAtMs?: number;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}.${String(input.seq)}.${input.type}`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: input.deps ?? {},
  aggregateId: 'thread-1',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs ?? 0,
});

const upsert = (
  bacId: string,
  replicaId: string,
  seq: number,
  overrides: Record<string, unknown> = {},
  deps: Record<string, number> = {},
): AcceptedEvent =>
  event({
    type: THREAD_UPSERTED,
    replicaId,
    seq,
    deps,
    payload: {
      bac_id: bacId,
      provider: 'chatgpt',
      threadUrl: `https://example.test/${bacId}`,
      title: `${bacId} title`,
      lastSeenAt: '2026-08-15T12:00:00.000Z',
      ...overrides,
    },
  });

const archived = (
  bacId: string,
  replicaId: string,
  seq: number,
  deps: Record<string, number> = {},
): AcceptedEvent =>
  event({ type: THREAD_ARCHIVED, replicaId, seq, deps, payload: { bac_id: bacId } });

const unarchived = (
  bacId: string,
  replicaId: string,
  seq: number,
  deps: Record<string, number> = {},
): AcceptedEvent =>
  event({ type: THREAD_UNARCHIVED, replicaId, seq, deps, payload: { bac_id: bacId } });

const deleted = (
  bacId: string,
  replicaId: string,
  seq: number,
  deps: Record<string, number> = {},
): AcceptedEvent =>
  event({ type: THREAD_DELETED, replicaId, seq, deps, payload: { bac_id: bacId } });

const irrelevantEvent = (replicaId: string, seq: number): AcceptedEvent => ({
  clientEventId: `priv-${replicaId}-${String(seq)}`,
  dot: { replicaId, seq },
  deps: {},
  aggregateId: 'privacy',
  type: 'privacy.gate.flipped',
  payload: { payloadVersion: 1, gate: 'threads', state: 'open' },
  acceptedAtMs: 0,
});

const sortByDot = (events: readonly AcceptedEvent[]): AcceptedEvent[] =>
  [...events].sort((a, b) => {
    if (a.dot.replicaId !== b.dot.replicaId) return a.dot.replicaId < b.dot.replicaId ? -1 : 1;
    return a.dot.seq - b.dot.seq;
  });

describe('ThreadRegisterStore', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const tempVault = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'thread-register-'));
    dirs.push(d);
    await mkdir(join(d, '_BAC', 'connections'), { recursive: true });
    return d;
  };

  sqliteIt('read() matches projectThread over the full ingested history', async () => {
    const vault = await tempVault();
    const store = await createThreadRegisterStore(vault);
    const events = [
      upsert('T1', 'A', 1, { title: 'first' }),
      upsert('T1', 'A', 2, { title: 'second' }, { A: 1 }),
      archived('T1', 'A', 3, { A: 2 }),
      irrelevantEvent('A', 4),
    ];
    store.ingestMany(events);
    const fromStore = store.read('T1');
    store.close();
    expect(fromStore).toEqual(projectThread('T1', events));
  });

  sqliteIt('read() is undefined for a bac_id with no ingested events', async () => {
    const vault = await tempVault();
    const store = await createThreadRegisterStore(vault);
    store.ingestMany([upsert('T1', 'A', 1)]);
    const fromStore = store.read('never-seen');
    store.close();
    expect(fromStore).toBeUndefined();
  });

  sqliteIt('ingest is idempotent by dot — re-ingesting the same batch does not duplicate candidates', async () => {
    const vault = await tempVault();
    const store = await createThreadRegisterStore(vault);
    // Two genuinely concurrent upserts (a real conflict) so a spurious
    // duplicate would double one side and skew the candidate set.
    const events = [upsert('T1', 'A', 1, { title: 'A version' }), upsert('T1', 'B', 1, { title: 'B version' })];
    store.ingestMany(events);
    store.ingestMany(events); // second pass must not duplicate candidates
    const fromStore = store.read('T1');
    store.close();
    expect(fromStore).toEqual(projectThread('T1', events));
    expect(fromStore?.record.status).toBe('conflict');
    if (fromStore?.record.status === 'conflict') {
      expect(fromStore.record.candidates).toHaveLength(2);
    }
  });

  sqliteIt('eventsFor reconstructs exactly the ingested dot set', async () => {
    const vault = await tempVault();
    const store = await createThreadRegisterStore(vault);
    const events = [
      upsert('T1', 'A', 1),
      upsert('T1', 'A', 2, {}, { A: 1 }),
      archived('T1', 'A', 3, { A: 2 }),
      unarchived('T1', 'A', 4, { A: 3 }),
    ];
    store.ingestMany(events);
    const reconstructed = store.eventsFor('T1');
    store.close();
    expect(sortByDot(reconstructed).map((e) => ({ dot: e.dot, type: e.type }))).toEqual(
      sortByDot(events).map((e) => ({ dot: e.dot, type: e.type })),
    );
  });

  sqliteIt('catchUp ingests only events past the watermark', async () => {
    const vault = await tempVault();
    const store = await createThreadRegisterStore(vault);
    const events = [
      upsert('T1', 'A', 1, { title: 'first' }),
      upsert('T1', 'A', 2, { title: 'second' }, { A: 1 }),
      archived('T1', 'A', 3, { A: 2 }),
    ];
    store.ingestMany(events.slice(0, 1));
    const added = await store.catchUp(events);
    const fromStore = store.read('T1');
    store.close();
    expect(added).toBe(2);
    expect(fromStore).toEqual(projectThread('T1', events));
  });

  sqliteIt('rebuildFromJsonl reproduces the same resolved projection', async () => {
    const vault = await tempVault();
    const logRoot = join(vault, '_BAC', 'log');
    const events = [
      upsert('T1', 'A', 1, { title: 'first' }),
      upsert('T1', 'B', 1, { title: 'concurrent' }),
      upsert('T1', 'A', 2, { title: 'merged' }, { A: 1, B: 1 }),
    ];
    await mkdir(join(logRoot, 'A'), { recursive: true });
    await writeFile(
      join(logRoot, 'A', '0001.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\nnot-json\n`,
      'utf8',
    );
    const store = await createThreadRegisterStore(vault);
    await store.rebuildFromJsonl(logRoot);
    const fromStore = store.read('T1');
    store.close();
    expect(fromStore).toEqual(projectThread('T1', events));
  });

  // ---------------------------------------------------------------------
  // F8 W1 equivalence suite: multi-replica out-of-order, conflicting
  // THREAD_UPSERTED events delivered across chunk boundaries. At every
  // watermark, the store's incrementally-folded register state must equal
  // projectThread run over the complete log accepted so far — regardless
  // of the ORDER chunks arrive in relative to causal dependency order.
  // ---------------------------------------------------------------------
  sqliteIt(
    'incremental register state equals projectThread(full log) at every watermark, across out-of-order chunks',
    async () => {
      const vault = await tempVault();
      const store = await createThreadRegisterStore(vault);

      // A1, B1 are genuinely concurrent (no deps between them).
      const a1 = upsert('T1', 'A', 1, { title: 'A1', primaryWorkstreamId: 'W1' });
      const b1 = upsert('T1', 'B', 1, { title: 'B1', primaryWorkstreamId: 'W2' });
      // A2 causally dominates BOTH A1 and B1 (observed both dots).
      const a2 = upsert('T1', 'A', 2, { title: 'A2', primaryWorkstreamId: 'W3' }, { A: 1, B: 1 });
      // C1 archives after observing A2.
      const c1 = archived('T1', 'C', 1, { A: 2 });
      // B2 is concurrent with A2 (only observed B1, not A2) — revives a
      // genuine record conflict against A2 once both are known.
      const b2 = upsert('T1', 'B', 2, { title: 'B2', primaryWorkstreamId: 'W4' }, { B: 1 });

      // Deliberately scrambled relative to causal order, and split across
      // chunk boundaries the way a chunked catch-up would deliver them.
      const chunks: readonly (readonly AcceptedEvent[])[] = [
        [c1, b2],
        [a2],
        [b1],
        [a1],
      ];

      const acceptedSoFar: AcceptedEvent[] = [];
      for (const chunk of chunks) {
        store.ingestMany(chunk);
        acceptedSoFar.push(...chunk);
        const expected = projectThread('T1', acceptedSoFar);
        const actual = store.read('T1');
        expect(actual).toEqual(expected);
      }

      // Final state: A2 and B2 are the true survivors (a genuine
      // concurrent conflict — neither dominates the other).
      const final = store.read('T1');
      store.close();
      expect(final?.record.status).toBe('conflict');
      if (final?.record.status === 'conflict') {
        const titles = final.record.candidates.map((c) => c.value.title).sort();
        expect(titles).toEqual(['A2', 'B2']);
      }
    },
  );

  sqliteIt(
    'delete/revive across out-of-order chunks matches projectThread(full log)',
    async () => {
      const vault = await tempVault();
      const store = await createThreadRegisterStore(vault);

      const a1 = upsert('T1', 'A', 1, { title: 'before' });
      const del = deleted('T1', 'A', 2, { A: 1 });
      // Concurrent revive: does not observe the delete.
      const revive = upsert('T1', 'B', 1, { title: 'concurrent revive' });

      const chunks: readonly (readonly AcceptedEvent[])[] = [[revive], [del], [a1]];
      const acceptedSoFar: AcceptedEvent[] = [];
      for (const chunk of chunks) {
        store.ingestMany(chunk);
        acceptedSoFar.push(...chunk);
        expect(store.read('T1')).toEqual(projectThread('T1', acceptedSoFar));
      }
      const final = store.read('T1');
      store.close();
      expect(final?.deleted).toBe(false);
      if (final?.record.status === 'resolved') {
        expect(final.record.value?.title).toBe('concurrent revive');
      }
    },
  );

  sqliteIt('multiple threads are tracked independently', async () => {
    const vault = await tempVault();
    const store = await createThreadRegisterStore(vault);
    const events = [
      upsert('T1', 'A', 1, { title: 'thread one' }),
      upsert('T2', 'A', 2, { title: 'thread two' }, { A: 1 }),
    ];
    store.ingestMany(events);
    const t1 = store.read('T1');
    const t2 = store.read('T2');
    store.close();
    expect(t1).toEqual(projectThread('T1', events));
    expect(t2).toEqual(projectThread('T2', events));
    if (t1?.record.status === 'resolved') expect(t1.record.value?.title).toBe('thread one');
    if (t2?.record.status === 'resolved') expect(t2.record.value?.title).toBe('thread two');
  });
});
