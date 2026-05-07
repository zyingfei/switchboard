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

const payload = (overrides: Partial<BrowserTimelineObservedPayload> & { observedAt: string; url: string }):
  BrowserTimelineObservedPayload => ({
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
      buildEvent({ seq: 1, payload: payload({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a' }) }),
    );
    await eventLog.importPeerEvent(
      buildEvent({ seq: 2, payload: payload({ observedAt: '2026-05-07T11:00:00.000Z', url: 'https://x/b', canonicalUrl: 'https://x/b' }) }),
    );
    await eventLog.importPeerEvent(
      buildEvent({ seq: 3, payload: payload({ observedAt: '2026-05-07T12:00:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a', transition: 'updated' }) }),
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
      buildEvent({ seq: 1, payload: payload({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a' }) }),
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
      buildEvent({ seq: 1, payload: payload({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a' }) }),
    );
    await eventLog.importPeerEvent(
      buildEvent({ seq: 2, payload: payload({ observedAt: '2026-05-08T10:00:00.000Z', url: 'https://x/b', canonicalUrl: 'https://x/b' }) }),
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
      buildEvent({ seq: 1, payload: payload({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a' }) }),
    );
    first.onAccepted(
      buildEvent({ seq: 1, payload: payload({ observedAt: '2026-05-07T10:00:00.000Z', url: 'https://x/a', canonicalUrl: 'https://x/a' }) }),
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
