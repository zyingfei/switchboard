import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sortAcceptedEvents, type AcceptedEvent, type VersionVector } from './causal.js';
import { createEventStore, getCaughtUpSharedEventStore } from './eventStore.js';
import { getEventLaneHealth, resetEventLaneHealthForTests } from './eventLaneHealth.js';

const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

const event = (input: {
  readonly replicaId: string;
  readonly seq: number;
  readonly acceptedAtMs: number;
  readonly type?: string;
}): AcceptedEvent => ({
  clientEventId: `${input.replicaId}-${String(input.seq)}`,
  dot: { replicaId: input.replicaId, seq: input.seq },
  deps: input.seq > 1 ? { [input.replicaId]: input.seq - 1 } : {},
  aggregateId: `agg-${input.replicaId}`,
  type: input.type ?? 'test.event',
  payload: { payloadVersion: 1, value: `${input.replicaId}:${String(input.seq)}` },
  acceptedAtMs: input.acceptedAtMs,
  target: { provider: 'test', canonicalUrl: `https://example.test/${input.replicaId}` },
  hlc: {
    physicalMs: input.acceptedAtMs,
    counter: input.seq,
    replicaId: input.replicaId,
    confidence: 'trusted',
  },
});

const buildEvents = (): readonly AcceptedEvent[] => [
  event({ replicaId: 'replica-b', seq: 2, acceptedAtMs: 50 }),
  event({ replicaId: 'replica-a', seq: 3, acceptedAtMs: 10 }),
  event({ replicaId: 'replica-b', seq: 1, acceptedAtMs: 40 }),
  event({ replicaId: 'replica-a', seq: 1, acceptedAtMs: 70 }),
  event({ replicaId: 'replica-c', seq: 1, acceptedAtMs: 20 }),
  event({ replicaId: 'replica-a', seq: 2, acceptedAtMs: 30 }),
];

const referenceReadSince = (
  events: readonly AcceptedEvent[],
  frontier: VersionVector,
): readonly AcceptedEvent[] =>
  sortAcceptedEvents(events).filter(
    (candidate) => candidate.dot.seq > (frontier[candidate.dot.replicaId] ?? 0),
  );

describe('EventStore ordering', () => {
  it('reference readSince keeps readMerged filter order across replicas', () => {
    const events = buildEvents();
    expect(referenceReadSince(events, { 'replica-a': 1, 'replica-b': 1 })).toEqual([
      event({ replicaId: 'replica-a', seq: 2, acceptedAtMs: 30 }),
      event({ replicaId: 'replica-a', seq: 3, acceptedAtMs: 10 }),
      event({ replicaId: 'replica-b', seq: 2, acceptedAtMs: 50 }),
      event({ replicaId: 'replica-c', seq: 1, acceptedAtMs: 20 }),
    ]);
  });
});

describe('EventStore sqlite', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const tempVault = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'event-store-'));
    dirs.push(dir);
    await mkdir(join(dir, '_BAC', 'connections'), { recursive: true });
    return dir;
  };

  sqliteIt('round-trips events and readSince matches merged.filter order', async () => {
    const events = buildEvents();
    const vault = await tempVault();
    const store = await createEventStore(vault);
    store.ingestMany(events);

    expect(store.count()).toBe(events.length);
    expect(store.maxAcceptedAtMs()).toBe(70);
    expect(store.readSince({ 'replica-a': 1, 'replica-b': 1 })).toEqual(
      referenceReadSince(events, { 'replica-a': 1, 'replica-b': 1 }),
    );
    expect(store.watermark()).toEqual({ 'replica-a': 3, 'replica-b': 2, 'replica-c': 1 });
    store.close();
  });

  sqliteIt('maxAcceptedAtMsForType returns the newest per type, 0 for unseen', async () => {
    const vault = await tempVault();
    const store = await createEventStore(vault);
    store.ingestMany([
      event({ replicaId: 'r', seq: 1, acceptedAtMs: 100, type: 'engagement.interval.observed' }),
      event({ replicaId: 'r', seq: 2, acceptedAtMs: 300, type: 'engagement.interval.observed' }),
      event({ replicaId: 'r', seq: 3, acceptedAtMs: 200, type: 'engagement.session.aggregated' }),
    ]);
    expect(store.maxAcceptedAtMsForType('engagement.interval.observed')).toBe(300);
    expect(store.maxAcceptedAtMsForType('engagement.session.aggregated')).toBe(200);
    expect(store.maxAcceptedAtMsForType('engagement.never.seen')).toBe(0);
    store.close();
  });

  sqliteIt('ingest is idempotent by (replicaId, seq)', async () => {
    const events = buildEvents();
    const vault = await tempVault();
    const store = await createEventStore(vault);
    store.ingestMany(events);
    store.ingestMany(events);

    expect(store.count()).toBe(events.length);
    expect(store.readSince({})).toEqual(referenceReadSince(events, {}));
    store.close();
  });

  sqliteIt(
    'rebuildFromJsonl clears tables, skips malformed lines, and preserves order',
    async () => {
      const events = buildEvents();
      const vault = await tempVault();
      const logRoot = join(vault, '_BAC', 'log');
      await mkdir(join(logRoot, 'replica-a'), { recursive: true });
      await mkdir(join(logRoot, 'replica-b'), { recursive: true });
      await mkdir(join(logRoot, 'replica-c'), { recursive: true });
      await writeFile(
        join(logRoot, 'replica-a', '0001.jsonl'),
        `${events
          .filter((candidate) => candidate.dot.replicaId === 'replica-a')
          .map((candidate) => JSON.stringify(candidate))
          .join('\n')}\nnot-json\n`,
        'utf8',
      );
      await writeFile(
        join(logRoot, 'replica-b', '0001.jsonl'),
        `${events
          .filter((candidate) => candidate.dot.replicaId === 'replica-b')
          .map((candidate) => JSON.stringify(candidate))
          .join('\n')}\n`,
        'utf8',
      );
      await writeFile(
        join(logRoot, 'replica-c', '0001.jsonl'),
        `${JSON.stringify(events.find((candidate) => candidate.dot.replicaId === 'replica-c'))}\n`,
        'utf8',
      );

      const store = await createEventStore(vault);
      store.ingest(event({ replicaId: 'stale', seq: 1, acceptedAtMs: 999 }));
      await store.rebuildFromJsonl(logRoot);

      expect(store.count()).toBe(events.length);
      expect(store.readSince({})).toEqual(referenceReadSince(events, {}));
      expect(store.maxAcceptedAtMs()).toBe(70);
      store.close();
    },
  );

  sqliteIt('catchUpFromJsonl and forEachChunk avoid a full result array', async () => {
    const events = buildEvents();
    const vault = await tempVault();
    const logRoot = join(vault, '_BAC', 'log');
    await mkdir(join(logRoot, 'replica-a'), { recursive: true });
    await mkdir(join(logRoot, 'replica-b'), { recursive: true });
    await mkdir(join(logRoot, 'replica-c'), { recursive: true });
    for (const replicaId of ['replica-a', 'replica-b', 'replica-c']) {
      await writeFile(
        join(logRoot, replicaId, '0001.jsonl'),
        `${events
          .filter((candidate) => candidate.dot.replicaId === replicaId)
          .map((candidate) => JSON.stringify(candidate))
          .join('\n')}\n`,
        'utf8',
      );
    }

    const store = await createEventStore(vault);
    expect(await store.catchUpFromJsonl(logRoot)).toBe(events.length);
    expect(await store.catchUpFromJsonl(logRoot)).toBe(0);

    const chunks: AcceptedEvent[][] = [];
    await store.forEachChunk((chunk) => {
      chunks.push([...chunk]);
      expect(chunk.length).toBeLessThanOrEqual(2);
    }, 2);
    expect(chunks.flat()).toEqual(referenceReadSince(events, {}));
    store.close();
  });

  sqliteIt('catchUpFromJsonl reads only the appended tail of an existing shard', async () => {
    const initialEvents = [
      event({ replicaId: 'replica-a', seq: 1, acceptedAtMs: 10 }),
      event({ replicaId: 'replica-a', seq: 2, acceptedAtMs: 20 }),
    ];
    const appendedEvents = [
      event({ replicaId: 'replica-a', seq: 3, acceptedAtMs: 30 }),
      event({ replicaId: 'replica-a', seq: 4, acceptedAtMs: 40 }),
    ];
    const events = [...initialEvents, ...appendedEvents];
    const vault = await tempVault();
    const logRoot = join(vault, '_BAC', 'log');
    const replicaRoot = join(logRoot, 'replica-a');
    const shardPath = join(replicaRoot, '0001.jsonl');
    await mkdir(replicaRoot, { recursive: true });
    await writeFile(
      shardPath,
      `${initialEvents.map((candidate) => JSON.stringify(candidate)).join('\n')}\n`,
      'utf8',
    );

    const store = await createEventStore(vault);
    expect(await store.catchUpFromJsonl(logRoot)).toBe(initialEvents.length);
    await appendFile(
      shardPath,
      `${appendedEvents.map((candidate) => JSON.stringify(candidate)).join('\n')}\n`,
      'utf8',
    );

    expect(await store.catchUpFromJsonl(logRoot)).toBe(appendedEvents.length);
    expect(store.count()).toBe(events.length);
    expect(store.readSince({})).toEqual(referenceReadSince(events, {}));
    store.close();
  });
});

describe('EventStore data-loss counters', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const tempVault = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'event-store-health-'));
    dirs.push(dir);
    await mkdir(join(dir, '_BAC', 'connections'), { recursive: true });
    return dir;
  };

  sqliteIt(
    'counts events at/below the watermark skipped in catchUp (storeSkippedOutOfOrder)',
    async () => {
      const vault = await tempVault();
      const store = await createEventStore(vault);
      resetEventLaneHealthForTests();
      // First catch-up advances the watermark to replica-a seq 2.
      await store.catchUp([
        event({ replicaId: 'replica-a', seq: 1, acceptedAtMs: 10 }),
        event({ replicaId: 'replica-a', seq: 2, acceptedAtMs: 20 }),
      ]);
      const before = getEventLaneHealth().storeSkippedOutOfOrder;
      // Re-deliver seq 1 + 2 (both at/below watermark → skipped) plus a new
      // seq 3 (accepted).
      const applied = await store.catchUp([
        event({ replicaId: 'replica-a', seq: 1, acceptedAtMs: 10 }),
        event({ replicaId: 'replica-a', seq: 2, acceptedAtMs: 20 }),
        event({ replicaId: 'replica-a', seq: 3, acceptedAtMs: 30 }),
      ]);
      expect(applied).toBe(1);
      expect(getEventLaneHealth().storeSkippedOutOfOrder).toBe(before + 2);
      store.close();
    },
  );

  sqliteIt(
    'counts a redelivered dot with identical content as a duplicate capture (duplicateCaptures)',
    async () => {
      const vault = await tempVault();
      const store = await createEventStore(vault);
      const e = event({ replicaId: 'replica-a', seq: 1, acceptedAtMs: 10 });
      // ingestMany does NOT filter by watermark, so a second ingest of the
      // same event reaches the INSERT OR IGNORE and is detected there.
      store.ingestMany([e]);
      resetEventLaneHealthForTests();
      store.ingestMany([e]);
      const health = getEventLaneHealth();
      expect(health.duplicateCaptures).toBe(1);
      expect(health.dotCollisions).toBe(0);
      store.close();
    },
  );

  sqliteIt(
    'counts two different events on the same dot as a collision (dotCollisions)',
    async () => {
      const vault = await tempVault();
      const store = await createEventStore(vault);
      const first = event({ replicaId: 'replica-a', seq: 1, acceptedAtMs: 10 });
      // Same (replica_id, seq) dot, DIFFERENT clientEventId + payload.
      const colliding: AcceptedEvent = {
        ...first,
        clientEventId: 'different-id',
        payload: { payloadVersion: 1, value: 'collision' },
      };
      store.ingestMany([first]);
      resetEventLaneHealthForTests();
      store.ingestMany([colliding]);
      const health = getEventLaneHealth();
      expect(health.dotCollisions).toBe(1);
      expect(health.duplicateCaptures).toBe(0);
      // The store keeps the first-written row (INSERT OR IGNORE).
      expect(store.count()).toBe(1);
      store.close();
    },
  );
});

describe('getCaughtUpSharedEventStore single-flight', () => {
  const dirs: string[] = [];
  let priorFlag: string | undefined;
  afterEach(async () => {
    if (priorFlag === undefined) delete process.env['SIDETRACK_EVENT_STORE'];
    else process.env['SIDETRACK_EVENT_STORE'] = priorFlag;
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  sqliteIt(
    'concurrent catch-up callers coalesce into one JSONL pass and count is correct',
    async () => {
      priorFlag = process.env['SIDETRACK_EVENT_STORE'];
      process.env['SIDETRACK_EVENT_STORE'] = '1';
      const vault = await mkdtemp(join(tmpdir(), 'event-store-sf-'));
      dirs.push(vault);
      await mkdir(join(vault, '_BAC', 'connections'), { recursive: true });
      const logRoot = join(vault, '_BAC', 'log');
      await mkdir(join(logRoot, 'replica-a'), { recursive: true });
      const events = buildEvents().filter((c) => c.dot.replicaId === 'replica-a');
      await writeFile(
        join(logRoot, 'replica-a', '0001.jsonl'),
        `${events.map((c) => JSON.stringify(c)).join('\n')}\n`,
        'utf8',
      );

      // Fire many concurrent catch-ups: the single-flight guard must coalesce
      // them into one pass (no racing shard-progress/watermark writes) and the
      // resulting store must reflect exactly the shard's events.
      const stores = await Promise.all(
        Array.from({ length: 8 }, () => getCaughtUpSharedEventStore(vault)),
      );
      const store = stores[0];
      expect(store).not.toBeNull();
      // All callers get the SAME shared store instance.
      for (const s of stores) expect(s).toBe(store);
      expect(store!.count()).toBe(events.length);

      // A later call (after the in-flight guard cleared) is a cheap no-op pass
      // and does not double-count.
      const again = await getCaughtUpSharedEventStore(vault);
      expect(again).toBe(store);
      expect(again!.count()).toBe(events.length);
    },
  );
});
