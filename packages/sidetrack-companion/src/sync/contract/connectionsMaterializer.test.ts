import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';

const buildEvent = (input: {
  seq: number;
  type: string;
  payload: unknown;
}): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: Date.parse('2026-05-07T10:00:00.000Z') + input.seq * 1000,
});

describe('connectionsMaterializer (Class B, consumer-only)', () => {
  let vaultRoot: string;
  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-connections-mat-'));
  });
  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('catchUp rebuilds the snapshot from event log alone (replay-recoverable)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        type: THREAD_UPSERTED,
        payload: {
          bac_id: 'thread_a',
          provider: 'chatgpt',
          threadUrl: 'https://x/a',
          title: 'A',
          lastSeenAt: '2026-05-07T10:00:00.000Z',
          tags: [],
          primaryWorkstreamId: 'ws_x',
        },
      }),
    );

    await m.catchUp(eventLog);
    await m.awaitIdle();

    const snap = await store.readCurrent();
    expect(snap, 'current snapshot written').not.toBeNull();
    const ids = snap!.nodes.map((n) => n.id);
    expect(ids).toContain('thread:thread_a');
    expect(ids).toContain('workstream:ws_x');
    expect(snap!.edges.find((e) => e.kind === 'thread_in_workstream')).toBeDefined();
    expect(m.health().status).toBe('healthy');
  });

  it('onAccepted with a handled event triggers drain that writes the snapshot', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    const event = buildEvent({
      seq: 1,
      type: THREAD_UPSERTED,
      payload: {
        bac_id: 'thread_b',
        provider: 'chatgpt',
        threadUrl: 'https://x/b',
        title: 'B',
        lastSeenAt: '2026-05-07T11:00:00.000Z',
        tags: [],
      },
    });
    await eventLog.importPeerEvent(event);
    m.onAccepted(event, { origin: 'peer' });
    await m.awaitIdle();

    const snap = await store.readCurrent();
    expect(snap?.nodes.find((n) => n.id === 'thread:thread_b')).toBeDefined();
  });

  it('onAccepted with a non-handled event type is a no-op (does not flag dirty)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    m.onAccepted(
      {
        clientEventId: 'unrelated',
        dot: { replicaId: 'r', seq: 1 },
        deps: {},
        aggregateId: 'something',
        type: 'unrelated.event',
        payload: { ignored: true },
        acceptedAtMs: 0,
      },
      { origin: 'peer' },
    );
    await m.awaitIdle();

    const snap = await store.readCurrent();
    // Materializer never ran (no handled events) — no snapshot file.
    expect(snap).toBeNull();
  });

  it('bursts coalesce — multiple onAccepted calls produce a single drain pass', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    for (let i = 1; i <= 5; i += 1) {
      const event = buildEvent({
        seq: i,
        type: THREAD_UPSERTED,
        payload: {
          bac_id: `thread_${String(i)}`,
          provider: 'chatgpt',
          threadUrl: `https://x/${String(i)}`,
          title: `t${String(i)}`,
          lastSeenAt: `2026-05-07T${String(i + 9).padStart(2, '0')}:00:00.000Z`,
          tags: [],
        },
      });
      await eventLog.importPeerEvent(event);
      m.onAccepted(event, { origin: 'peer' });
    }
    await m.awaitIdle();

    const snap = await store.readCurrent();
    expect(snap).not.toBeNull();
    // Five threads were imported; the final snapshot must include
    // all of them.
    for (let i = 1; i <= 5; i += 1) {
      expect(snap?.nodes.map((n) => n.id)).toContain(`thread:thread_${String(i)}`);
    }
  });

  it('catchUp bypasses failure cooldown (recovery path)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    let calls = 0;
    const store = {
      putCurrent: async (snapshot: import('../../connections/snapshot.js').ConnectionsSnapshot) => {
        calls += 1;
        if (calls === 1) throw new Error('disk full');
        void snapshot;
      },
      readCurrent: async () => null,
      putDay: async () => undefined,
      readDay: async () => null,
      listDays: async () => [],
    };
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    const event = buildEvent({
      seq: 1,
      type: THREAD_UPSERTED,
      payload: {
        bac_id: 'thread_a',
        provider: 'chatgpt',
        threadUrl: 'https://x/a',
        title: 'A',
        lastSeenAt: '2026-05-07T10:00:00.000Z',
        tags: [],
      },
    });
    await eventLog.importPeerEvent(event);
    m.onAccepted(event, { origin: 'peer' });
    await new Promise((r) => setTimeout(r, 30));
    expect(m.health().status).toBe('failed');
    expect(m.health().lastError).toContain('disk full');

    // catchUp bypasses the failure cooldown and runs the next
    // putCurrent attempt (which succeeds in our stub). Health
    // returns to healthy.
    await m.catchUp(eventLog);
    await m.awaitIdle();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(m.health().status).toBe('healthy');
  });

  it('handles set covers expected event types', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    const expected = [
      'thread.upserted',
      'workstream.upserted',
      'dispatch.recorded',
      'dispatch.linked',
      'queue.created',
      'annotation.created',
      'capture.recorded',
      'browser.timeline.observed',
    ];
    for (const t of expected) expect(m.handles.has(t)).toBe(true);
    expect(m.handles.has('unrelated.event')).toBe(false);
  });
});
