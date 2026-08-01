import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BROWSER_TIMELINE_OBSERVED,
  type BrowserTimelineObservedPayload,
} from '../../timeline/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { getCaughtUpSharedEventStore } from '../eventStore.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createTimelineMaterializer } from './timelineMaterializer.js';

// Class B timeline materializer — required properties:
//   1. Idempotent: catchUp twice produces the same on-disk state.
//   2. Coalesced: bursts schedule one in-flight worker.
//   3. Replayable: catchUp from log alone (no notifications).
//   4. Independently failing: throw → health failed; doesn't bubble.
//   5. Deterministic: same events in any order → same projection.
//   6. Local-vs-peer symmetric: origin doesn't change output.

const buildEvent = (input: {
  seq: number;
  payload: BrowserTimelineObservedPayload;
}): AcceptedEvent => ({
  clientEventId: input.payload.eventId,
  dot: { replicaId: 'edge_test', seq: input.seq },
  deps: {},
  aggregateId: input.payload.observedAt.slice(0, 10),
  type: BROWSER_TIMELINE_OBSERVED,
  payload: input.payload,
  acceptedAtMs: Date.parse(input.payload.observedAt),
});

const payload = (
  overrides: Partial<BrowserTimelineObservedPayload> & { observedAt: string; url: string },
): BrowserTimelineObservedPayload => ({
  eventId: overrides.eventId ?? `evt-${overrides.observedAt}-${overrides.url}`,
  observedAt: overrides.observedAt,
  url: overrides.url,
  transition: overrides.transition ?? 'activated',
  ...(overrides.canonicalUrl === undefined ? {} : { canonicalUrl: overrides.canonicalUrl }),
  ...(overrides.title === undefined ? {} : { title: overrides.title }),
  ...(overrides.provider === undefined ? {} : { provider: overrides.provider }),
});

describe('timelineMaterializer (Class B)', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-timeline-mat-'));
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('writes a daily projection from accepted events via catchUp', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createTimelineStore(vaultRoot);
    const m = createTimelineMaterializer({ store, eventLog });

    // Import three events on 2026-05-07.
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        payload: payload({
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://x/a',
          canonicalUrl: 'https://x/a',
        }),
      }),
    );
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 2,
        payload: payload({
          observedAt: '2026-05-07T11:00:00.000Z',
          url: 'https://x/b',
          canonicalUrl: 'https://x/b',
        }),
      }),
    );
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 3,
        payload: payload({
          observedAt: '2026-05-07T12:00:00.000Z',
          url: 'https://x/a',
          canonicalUrl: 'https://x/a',
          transition: 'updated',
        }),
      }),
    );

    await m.catchUp(eventLog);
    await m.awaitIdle();

    const day = await store.readDay('2026-05-07');
    expect(day, 'projection written').not.toBeNull();
    expect(day!.entryCount).toBe(2);
    const a = day!.entries.find((e) => e.id === 'https://x/a');
    expect(a?.visitCount).toBe(2);
  });

  it('idempotent — catchUp twice produces same on-disk state', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createTimelineStore(vaultRoot);
    const m = createTimelineMaterializer({ store, eventLog });

    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        payload: payload({
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://x/a',
          canonicalUrl: 'https://x/a',
        }),
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const after1 = await store.readDay('2026-05-07');
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const after2 = await store.readDay('2026-05-07');
    expect(after1?.entries).toEqual(after2?.entries);
    expect(after1?.entryCount).toBe(after2?.entryCount);
  });

  it('coalesces a burst — onAccepted N times then awaitIdle', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createTimelineStore(vaultRoot);
    const m = createTimelineMaterializer({ store, eventLog });

    // Import 10 events for the same day in rapid succession.
    for (let i = 1; i <= 10; i += 1) {
      const event = buildEvent({
        seq: i,
        payload: payload({
          observedAt: `2026-05-07T10:${String(i).padStart(2, '0')}:00.000Z`,
          url: `https://x/p${String(i)}`,
          canonicalUrl: `https://x/p${String(i)}`,
        }),
      });
      await eventLog.importPeerEvent(event);
      m.onAccepted(event, { origin: 'peer' });
    }
    await m.awaitIdle();
    const day = await store.readDay('2026-05-07');
    expect(day?.entryCount).toBe(10);
  });

  it('groups events into separate day projections', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createTimelineStore(vaultRoot);
    const m = createTimelineMaterializer({ store, eventLog });

    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        payload: payload({
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://x/a',
          canonicalUrl: 'https://x/a',
        }),
      }),
    );
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 2,
        payload: payload({
          observedAt: '2026-05-08T10:00:00.000Z',
          url: 'https://x/b',
          canonicalUrl: 'https://x/b',
        }),
      }),
    );
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const day1 = await store.readDay('2026-05-07');
    const day2 = await store.readDay('2026-05-08');
    expect(day1?.entryCount).toBe(1);
    expect(day2?.entryCount).toBe(1);
  });

  it('replay-recoverable — projection is a function of the merged log alone', async () => {
    // Materialize once, then a SECOND fresh materializer with no
    // notification history catches up to the same on-disk state.
    // This is the L2-G10 analogue for timeline.
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createTimelineStore(vaultRoot);
    const first = createTimelineMaterializer({ store, eventLog });
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        payload: payload({
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://x/a',
          canonicalUrl: 'https://x/a',
        }),
      }),
    );
    first.onAccepted(
      buildEvent({
        seq: 1,
        payload: payload({
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://x/a',
          canonicalUrl: 'https://x/a',
        }),
      }),
      { origin: 'peer' },
    );
    await first.awaitIdle();

    // Simulate a "fresh" materializer with no in-memory state.
    const second = createTimelineMaterializer({ store, eventLog });
    await second.catchUp(eventLog);
    await second.awaitIdle();
    const day = await store.readDay('2026-05-07');
    expect(day?.entryCount).toBe(1);
    expect(second.health().status).toBe('healthy');
  });

  it('drain failure re-adds dirty days for next-trigger retry (no silent drop)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    // Inject a store whose putDay rejects on the first call but
    // succeeds on subsequent ones. Reviewer F7: failed days must
    // come back into the dirty set so a future trigger retries
    // them — without that, the projection would be stale until
    // some unrelated event flipped the same day dirty again.
    let calls = 0;
    const store = {
      putDay: async (day: import('../../timeline/projection.js').TimelineDayProjection) => {
        calls += 1;
        if (calls === 1) throw new Error('disk full');
        // Subsequent calls succeed silently — the test asserts via
        // the materializer's pending state.
        void day;
      },
      readDay: async () => null,
      listDays: async () => [],
    };
    const m = createTimelineMaterializer({ store, eventLog });

    const event = buildEvent({
      seq: 1,
      payload: payload({
        observedAt: '2026-05-07T10:00:00.000Z',
        url: 'https://x/a',
        canonicalUrl: 'https://x/a',
      }),
    });
    await eventLog.importPeerEvent(event);
    m.onAccepted(event, { origin: 'peer' });
    // Wait for the in-flight drain attempt to finish (it'll fail).
    await new Promise((r) => setTimeout(r, 30));

    // After the failure, the day MUST still be flagged so a future
    // trigger picks it up. Health reports 'failed' with the error.
    expect(m.health().status).toBe('failed');
    expect(m.health().pending).toBe(true);
    expect(m.health().lastError).toContain('disk full');

    // Recovery happens via catchUp (the documented "always-retry"
    // path). onAccepted is gated by FAILURE_COOLDOWN_MS so a busy
    // event stream doesn't tight-loop on persistent failures —
    // catchUp bypasses that gate. Fires a fresh merged-log scan
    // which sees the second event's day in dirtyDays AND the
    // first day still flagged from the recovery path.
    const event2 = buildEvent({
      seq: 2,
      payload: payload({
        observedAt: '2026-05-07T11:00:00.000Z',
        url: 'https://x/b',
        canonicalUrl: 'https://x/b',
      }),
    });
    await eventLog.importPeerEvent(event2);
    await m.catchUp(eventLog);
    await m.awaitIdle();

    // putDay was called: once for the failed first attempt + at
    // least once for the recovered drain.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(m.health().status).toBe('healthy');
    expect(m.health().pending).toBe(false);
  });

  it('non-timeline events are no-ops', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const store = createTimelineStore(vaultRoot);
    const m = createTimelineMaterializer({ store, eventLog });

    m.onAccepted(
      {
        clientEventId: 'unrelated',
        dot: { replicaId: 'r', seq: 1 },
        deps: {},
        aggregateId: 'thread-1',
        type: 'thread.upserted',
        payload: { ignored: true },
        acceptedAtMs: 1,
      },
      { origin: 'peer' },
    );
    await m.awaitIdle();
    const days = await store.listDays();
    expect(days).toHaveLength(0);
  });
});

// The store-backed read inside readTimelineEvents used to be an UNTYPED
// store.forEachChunk full scan: it materialised (JSON.parse'd) EVERY row in
// the event store and threw away the ~92% that are engagement intervals,
// once per boot catchUp and once per dirty day per drain. It is now
// forEachChunkOfTypes over the single type the fold consumes, pushed down
// to the events_type_idx index.
//
// This block drives the REAL production path (createTimelineMaterializer
// with vaultRoot + SIDETRACK_EVENT_STORE=1 → getCaughtUpSharedEventStore),
// against a store seeded with MIXED event types.
const sqliteIt = process.versions['bun'] === undefined ? it.skip : it;

describe('timelineMaterializer store-backed read (typed)', () => {
  let vaultRoot: string;
  let priorFlag: string | undefined;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-timeline-store-'));
    priorFlag = process.env['SIDETRACK_EVENT_STORE'];
    process.env['SIDETRACK_EVENT_STORE'] = '1';
  });
  afterEach(async () => {
    if (priorFlag === undefined) delete process.env['SIDETRACK_EVENT_STORE'];
    else process.env['SIDETRACK_EVENT_STORE'] = priorFlag;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const noiseEvent = (seq: number, type: string, acceptedAtMs: number): AcceptedEvent => ({
    clientEventId: `noise-${String(seq)}`,
    dot: { replicaId: 'edge_test', seq },
    deps: {},
    aggregateId: 'noise',
    type,
    payload: { payloadVersion: 1, value: seq },
    acceptedAtMs,
  });

  // Interleaved so the timeline events are NOT contiguous in the store:
  // seq 1 timeline, 2 noise, 3 timeline, 4 noise, 5 timeline (next day),
  // 6 noise. A read that lost the type filter, or that kept only a
  // contiguous run, would produce a different projection.
  const seedMixedLog = async (): Promise<ReturnType<typeof createEventLog>> => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        payload: payload({
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://x/a',
          canonicalUrl: 'https://x/a',
        }),
      }),
    );
    await eventLog.importPeerEvent(noiseEvent(2, 'engagement.interval.observed', 1));
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 3,
        payload: payload({
          observedAt: '2026-05-07T12:00:00.000Z',
          url: 'https://x/a',
          canonicalUrl: 'https://x/a',
          transition: 'updated',
        }),
      }),
    );
    await eventLog.importPeerEvent(noiseEvent(4, 'engagement.session.aggregated', 2));
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 5,
        payload: payload({
          observedAt: '2026-05-08T09:00:00.000Z',
          url: 'https://x/b',
          canonicalUrl: 'https://x/b',
        }),
      }),
    );
    await eventLog.importPeerEvent(noiseEvent(6, 'navigation.committed', 3));
    return eventLog;
  };

  sqliteIt('catchUp folds only timeline events out of a mixed-type store', async () => {
    const eventLog = await seedMixedLog();
    const store = createTimelineStore(vaultRoot);
    const m = createTimelineMaterializer({ store, eventLog, vaultRoot });

    await m.catchUp(eventLog);
    await m.awaitIdle();

    // The store-backed branch really ran (not the streamFiltered fallback).
    const eventStore = await getCaughtUpSharedEventStore(vaultRoot);
    expect(eventStore, 'event store must be live for this test to mean anything').not.toBeNull();
    expect(eventStore?.count()).toBe(6);

    // Hand-computed: 2026-05-07 has two events for the SAME canonical url
    // (activated + updated) → one entry, visitCount 2; 2026-05-08 has one.
    // Drop BROWSER_TIMELINE_OBSERVED from the needle set and both days
    // vanish; leak the noise types in and collectTimelinePayloads still
    // rejects them, so the counts below are exact either way.
    const day7 = await store.readDay('2026-05-07');
    expect(day7?.entryCount).toBe(1);
    expect(day7?.entries[0]?.id).toBe('https://x/a');
    expect(day7?.entries[0]?.visitCount).toBe(2);
    expect(day7?.updatedAt).toBe('2026-05-07T12:00:00.000Z');

    const day8 = await store.readDay('2026-05-08');
    expect(day8?.entryCount).toBe(1);
    expect(day8?.entries[0]?.id).toBe('https://x/b');
    expect(day8?.entries[0]?.visitCount).toBe(1);

    expect(await store.listDays()).toEqual(['2026-05-07', '2026-05-08']);
    expect(m.health().status).toBe('healthy');
  });

  sqliteIt('typed read is substitutable for the untyped full scan', async () => {
    await seedMixedLog();
    const eventStore = await getCaughtUpSharedEventStore(vaultRoot);
    expect(eventStore).not.toBeNull();

    // Inline reimplementation of the pre-fix read (the oracle).
    const oracle: AcceptedEvent[] = [];
    let untypedRows = 0;
    await eventStore!.forEachChunk((chunk) => {
      untypedRows += chunk.length;
      for (const event of chunk) {
        if (event.type === BROWSER_TIMELINE_OBSERVED) oracle.push(event);
      }
    }, 2000);

    // The shipped read.
    const typed: AcceptedEvent[] = [];
    let typedRows = 0;
    await eventStore!.forEachChunkOfTypes(
      [BROWSER_TIMELINE_OBSERVED],
      (chunk) => {
        typedRows += chunk.length;
        for (const event of chunk) typed.push(event);
      },
      2000,
    );

    // Same events in the same order — both store paths page by
    // ORDER BY replica_id, seq — so the same day projections.
    expect(typed).toEqual(oracle);
    expect(typed.map((e) => e.dot.seq)).toEqual([1, 3, 5]);
    // The whole point: 6 rows parsed before, 3 after. On a real vault the
    // ratio is ~450k-to-a-few-thousand, which is what blew the boot budget.
    expect(untypedRows).toBe(6);
    expect(typedRows).toBe(3);
  });

  sqliteIt('typed read preserves the chunk-yield cadence', async () => {
    await seedMixedLog();
    const eventStore = await getCaughtUpSharedEventStore(vaultRoot);
    expect(eventStore).not.toBeNull();

    const chunkSizes: number[] = [];
    await eventStore!.forEachChunkOfTypes(
      [BROWSER_TIMELINE_OBSERVED],
      (chunk) => {
        chunkSizes.push(chunk.length);
      },
      2,
    );
    // Still pages at the requested size and yields between pages, so a
    // large fold stays interruptible rather than blocking the loop once.
    expect(chunkSizes).toEqual([2, 1]);
  });
});
