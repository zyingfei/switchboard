import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sortAcceptedEvents, type AcceptedEvent, type VersionVector } from './causal.js';
import { createEventStore } from './eventStore.js';

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
