import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { USER_FLOW_CONFIRMED } from '../feedback/events.js';
import { ENGAGEMENT_INTERVAL_OBSERVED } from '../engagement/events.js';
import { RECALL_ACTION, RECALL_SERVED } from '../recall/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  fingerprintTrainableEvents,
  readTrainableEventsFromShard,
  trainableEventsShardDir,
  type TrainableEventsSource,
} from './trainableEventsShard.js';

const BASE_TIME = Date.parse('2026-07-11T18:00:00.000Z');

const evt = (seq: number, type: string): AcceptedEvent => ({
  clientEventId: `evt-${String(seq)}`,
  dot: { replicaId: 'replica-a', seq },
  deps: {},
  aggregateId: `agg-${String(seq)}`,
  type,
  payload: { payloadVersion: 1, seq },
  acceptedAtMs: BASE_TIME + seq,
});

/**
 * A stub log source that streams a fixed event list. Mirrors the eventLog
 * contract the shard needs: a signature that changes iff the events change, and
 * a type-filtered stream. Counts scans so the test can prove the whole-log read
 * runs at most once per signature.
 */
const stubSource = (
  events: AcceptedEvent[],
): TrainableEventsSource & { scans: () => number; setEvents: (next: AcceptedEvent[]) => void } => {
  let current = events;
  let scans = 0;
  return {
    scans: () => scans,
    setEvents: (next) => {
      current = next;
    },
    logSignature: async () =>
      current.map((e) => `${e.dot.replicaId}:${String(e.dot.seq)}:${e.type}`).join('|'),
    streamFiltered: async (predicate, typeHints) => {
      scans += 1;
      const out = current.filter(
        (e) => (typeHints === undefined || typeHints.has(e.type)) && predicate(e),
      );
      return out;
    },
  };
};

describe('trainableEventsShard', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-trainable-shard-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('reads only the trainable subset and drops the engagement bulk', async () => {
    const source = stubSource([
      evt(1, RECALL_SERVED),
      evt(2, ENGAGEMENT_INTERVAL_OBSERVED),
      evt(3, RECALL_ACTION),
      evt(4, ENGAGEMENT_INTERVAL_OBSERVED),
      evt(5, USER_FLOW_CONFIRMED),
    ]);
    const { events, rebuilt } = await readTrainableEventsFromShard(vaultRoot, source);
    expect(rebuilt).toBe(true);
    expect(events.map((e) => e.type)).toEqual([RECALL_SERVED, RECALL_ACTION, USER_FLOW_CONFIRMED]);
  });

  it('rebuilds once on first read, then serves the shard without re-scanning the log', async () => {
    const source = stubSource([evt(1, RECALL_SERVED), evt(2, RECALL_ACTION)]);
    const first = await readTrainableEventsFromShard(vaultRoot, source);
    expect(first.rebuilt).toBe(true);
    expect(source.scans()).toBe(1);

    // Second read with an unchanged log signature: served from the shard, NO
    // second whole-log scan.
    const second = await readTrainableEventsFromShard(vaultRoot, source);
    expect(second.rebuilt).toBe(false);
    expect(source.scans()).toBe(1);
    expect(second.events.map((e) => e.dot.seq)).toEqual(first.events.map((e) => e.dot.seq));
  });

  it('rebuilds when the log signature moves (a new trainable event landed)', async () => {
    const source = stubSource([evt(1, RECALL_SERVED)]);
    await readTrainableEventsFromShard(vaultRoot, source);
    expect(source.scans()).toBe(1);

    source.setEvents([evt(1, RECALL_SERVED), evt(3, RECALL_ACTION)]);
    const after = await readTrainableEventsFromShard(vaultRoot, source);
    expect(after.rebuilt).toBe(true);
    expect(source.scans()).toBe(2);
    expect(after.events.map((e) => e.type)).toEqual([RECALL_SERVED, RECALL_ACTION]);
  });

  it('rebuilds-from-scratch (missing shard) matches the incremental shard contents', async () => {
    const events = [
      evt(1, RECALL_SERVED),
      evt(2, RECALL_ACTION),
      evt(3, USER_FLOW_CONFIRMED),
      evt(4, ENGAGEMENT_INTERVAL_OBSERVED),
    ];
    const sourceA = stubSource(events);
    const built = await readTrainableEventsFromShard(vaultRoot, sourceA);

    // Wipe the shard dir and rebuild from scratch against the same log.
    await rm(trainableEventsShardDir(vaultRoot), { recursive: true, force: true });
    const sourceB = stubSource(events);
    const rebuilt = await readTrainableEventsFromShard(vaultRoot, sourceB);
    expect(rebuilt.rebuilt).toBe(true);
    expect(rebuilt.events.map((e) => e.clientEventId)).toEqual(
      built.events.map((e) => e.clientEventId),
    );
    // Fingerprints must match across a fresh rebuild.
    expect(fingerprintTrainableEvents(rebuilt.events).hash).toBe(
      fingerprintTrainableEvents(built.events).hash,
    );
  });

  it('rebuilds when the signature file is present but the shard body is missing', async () => {
    const source = stubSource([evt(1, RECALL_SERVED)]);
    await readTrainableEventsFromShard(vaultRoot, source);
    // Delete only the shard body, keep the signature.
    await rm(join(trainableEventsShardDir(vaultRoot), 'shard.jsonl'), { force: true });
    const after = await readTrainableEventsFromShard(vaultRoot, source);
    expect(after.rebuilt).toBe(true);
    expect(after.events).toHaveLength(1);
  });

  it('drops foreign/garbled shard lines defensively on read', async () => {
    const source = stubSource([evt(1, RECALL_SERVED), evt(2, RECALL_ACTION)]);
    await readTrainableEventsFromShard(vaultRoot, source);
    const shardFile = join(trainableEventsShardDir(vaultRoot), 'shard.jsonl');
    // Append a garbled line + a foreign-type line; both must be ignored.
    const body = await readFile(shardFile, 'utf8');
    await writeFile(
      shardFile,
      `${body}not-json\n${JSON.stringify(evt(9, ENGAGEMENT_INTERVAL_OBSERVED))}\n`,
    );
    // Signature still matches (log unchanged) → shard is read as-is.
    const result = await readTrainableEventsFromShard(vaultRoot, source);
    expect(result.rebuilt).toBe(false);
    expect(result.events.map((e) => e.type)).toEqual([RECALL_SERVED, RECALL_ACTION]);
  });

  describe('fingerprintTrainableEvents', () => {
    it('is stable under reordering and shard layout', () => {
      const a = [evt(1, RECALL_SERVED), evt(2, RECALL_ACTION)];
      const b = [evt(2, RECALL_ACTION), evt(1, RECALL_SERVED)];
      expect(fingerprintTrainableEvents(a).hash).toBe(fingerprintTrainableEvents(b).hash);
    });

    it('moves when a new trainable event is added', () => {
      const before = fingerprintTrainableEvents([evt(1, RECALL_SERVED)]);
      const after = fingerprintTrainableEvents([evt(1, RECALL_SERVED), evt(2, RECALL_ACTION)]);
      expect(after.hash).not.toBe(before.hash);
      expect(after.count).toBe(2);
      expect(before.count).toBe(1);
    });

    it('reports zero count on an empty set', () => {
      const fp = fingerprintTrainableEvents([]);
      expect(fp.count).toBe(0);
    });
  });
});
