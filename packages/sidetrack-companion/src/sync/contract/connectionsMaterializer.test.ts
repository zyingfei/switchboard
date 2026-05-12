import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import type { VisitSimilarityEmbedder } from '../../connections/visitSimilarity.js';
import { THREAD_UPSERTED } from '../../threads/events.js';
import { BROWSER_TIMELINE_OBSERVED } from '../../timeline/events.js';
import { createTimelineStore } from '../../timeline/projection.js';
import {
  TOPIC_HDBSCAN_REVISION_KEY,
  TOPIC_UNION_FIND_REVISION_KEY,
  createTopicRevisionStore,
} from '../../producers/topic-revision.js';
import type { AcceptedEvent } from '../causal.js';
import { createEventLog } from '../eventLog.js';
import { loadOrCreateReplica } from '../replicaId.js';
import { createConnectionsMaterializer } from './connectionsMaterializer.js';

const buildEvent = (input: { seq: number; type: string; payload: unknown }): AcceptedEvent => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-A', seq: input.seq },
  deps: {},
  aggregateId: 'agg',
  type: input.type,
  payload: input.payload,
  acceptedAtMs: Date.parse('2026-05-07T10:00:00.000Z') + input.seq * 1000,
});

const unit = (values: readonly number[]): Float32Array => {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return Float32Array.from(values.map((value) => value / norm));
};

const keyFromEmbeddingText = (text: string): string => {
  const corpus = text.replace(/^(?:passage|query):\s+/u, '');
  return corpus.split(/\s+/u)[0] ?? '';
};

const embedFromVectors =
  (vectors: ReadonlyMap<string, Float32Array>): VisitSimilarityEmbedder =>
  async (texts) =>
    texts.map((text) => {
      const key = keyFromEmbeddingText(text);
      const vector = vectors.get(key);
      if (vector === undefined) {
        throw new Error(`missing vector for ${key}`);
      }
      return vector;
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

  it('runs visitSimilarity before snapshot and persists the active revision', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const embed = embedFromVectors(
      new Map<string, Float32Array>([
        ['visit-alpha', unit([1, 0])],
        ['visit-bravo', unit([1, 0])],
      ]),
    );
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store, embed });

    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-alpha',
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://example.test/alpha',
          canonicalUrl: 'https://example.test/alpha',
          title: 'visit-alpha',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 2,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-bravo',
          observedAt: '2026-05-07T10:05:00.000Z',
          url: 'https://example.test/bravo',
          canonicalUrl: 'https://example.test/bravo',
          title: 'visit-bravo',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );

    await m.catchUp(eventLog);
    await m.awaitIdle();

    const snap = await store.readCurrent();
    expect(snap).not.toBeNull();
    const edge = snap?.edges.find((candidate) => candidate.kind === 'visit_resembles_visit');
    expect(edge).toBeDefined();
    expect(edge?.fromNodeId).toBe('timeline-visit:https://example.test/alpha');
    expect(edge?.toNodeId).toBe('timeline-visit:https://example.test/bravo');
    expect(edge?.confidence).toBe('inferred');
    expect(edge?.producedBy.source).toBe('visit-similarity');
    const revisionId =
      edge?.producedBy.source === 'visit-similarity' ? edge.producedBy.revisionId : undefined;
    expect(revisionId).toMatch(/^[a-f0-9]{16}$/u);
    if (revisionId === undefined) throw new Error('missing visit-similarity revision id');
    const revisionRaw = await readFile(
      join(vaultRoot, '_BAC', 'connections', 'visit-similarity', `${revisionId}.json`),
      'utf8',
    );
    expect(revisionRaw).toContain(`"revisionId": "${revisionId}"`);
    const topicRevision = await createTopicRevisionStore(vaultRoot).readActiveRevision();
    expect(topicRevision?.algorithmVersion).toBe(TOPIC_UNION_FIND_REVISION_KEY);
    expect(m.health().status).toBe('healthy');
  });

  it('can select the HDBSCAN topic revision builder by revision key', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const embed = embedFromVectors(
      new Map<string, Float32Array>([
        ['visit-alpha', unit([1, 0])],
        ['visit-bravo', unit([1, 0])],
      ]),
    );
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed,
      topicRevisionAlgorithm: TOPIC_HDBSCAN_REVISION_KEY,
    });

    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-alpha',
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://example.test/alpha',
          canonicalUrl: 'https://example.test/alpha',
          title: 'visit-alpha',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 2,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-bravo',
          observedAt: '2026-05-07T10:05:00.000Z',
          url: 'https://example.test/bravo',
          canonicalUrl: 'https://example.test/bravo',
          title: 'visit-bravo',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );

    await m.catchUp(eventLog);
    await m.awaitIdle();

    const topicRevision = await createTopicRevisionStore(vaultRoot).readActiveRevision();
    expect(topicRevision?.algorithmVersion).toBe(TOPIC_HDBSCAN_REVISION_KEY);
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
    // Stage 5.2 W1a — drain is debounced; awaitIdle waits through
    // debounce + the failing drain attempt that parks lastError.
    await m.awaitIdle();
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

  it('awaitIdle does not hang when a drain has parked the materializer in a failed state', async () => {
    // Regression for the dirty=true-after-failure trap. After a
    // failed drain the materializer leaves dirty=true so the next
    // trigger retries; if no further trigger arrives, dirty stays
    // true forever and the failure cooldown blocks the SW-level
    // retry. A naive `while (running || dirty)` loop in awaitIdle
    // would wait forever even though work is permanently parked.
    // Updated awaitIdle treats lastError !== null + no in-flight
    // drain as idle so callers can fall through to health() and
    // surface 'failed' rather than hang.
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = {
      putCurrent: async (snapshot: import('../../connections/snapshot.js').ConnectionsSnapshot) => {
        void snapshot;
        throw new Error('disk wedged');
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

    // awaitIdle must resolve within a reasonable bound — the bug
    // would have it spin forever at 5 ms intervals waiting for
    // dirty to clear (which never happens without another trigger
    // because the failure cooldown blocks retries).
    const start = Date.now();
    await Promise.race([
      m.awaitIdle(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('awaitIdle hung past 1s')), 1_000),
      ),
    ]);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1_000);

    // health() reports the failure so callers know not to trust
    // the snapshot.
    const health = m.health();
    expect(health.status).toBe('failed');
    expect(health.lastError).toContain('disk wedged');
  });

  // Stage 5.2 W3 — visit-similarity skip-gate. When the same set of
  // visits is processed twice, the second drain reads the cached
  // revision from disk instead of re-running embed (the most
  // expensive pass on the materializer's hot path).
  it('reuses an existing similarity revision when visit inputs are unchanged', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    let embedCalls = 0;
    const embed: VisitSimilarityEmbedder = async (texts) => {
      embedCalls += 1;
      return texts.map(() => unit([1, 0]));
    };
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store, embed });

    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-alpha',
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://example.test/alpha',
          canonicalUrl: 'https://example.test/alpha',
          title: 'visit-alpha',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 2,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-bravo',
          observedAt: '2026-05-07T10:05:00.000Z',
          url: 'https://example.test/bravo',
          canonicalUrl: 'https://example.test/bravo',
          title: 'visit-bravo',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );

    // First drain populates the similarity revision (calls embed once
    // for the two passages).
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const firstCalls = embedCalls;
    expect(firstCalls).toBeGreaterThan(0);

    // Second drain over the same visit set: skip-gate hits, no
    // additional embed call.
    await m.catchUp(eventLog);
    await m.awaitIdle();
    expect(embedCalls).toBe(firstCalls);
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

  // Stage 5.2 W2b — high-frequency events that fold into the next
  // natural drain (engagement aggregates, visual fingerprints) MUST NOT
  // be in HANDLES, so they don't trigger their own per-event rebuild.
  it('engagement.session.aggregated is NOT in handles (deferred to next structural drain)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    expect(m.handles.has('engagement.session.aggregated')).toBe(false);
    expect(m.handles.has('visual.fingerprint.observed')).toBe(false);
  });

  it('engagement bursts do not trigger any drain (deferred until next structural event)', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    let putCurrentCalls = 0;
    const store = {
      putCurrent: async (snapshot: import('../../connections/snapshot.js').ConnectionsSnapshot) => {
        putCurrentCalls += 1;
        void snapshot;
      },
      readCurrent: async () => null,
      putDay: async () => undefined,
      readDay: async () => null,
      listDays: async () => [],
    };
    const m = createConnectionsMaterializer({ vaultRoot, eventLog, timelineStore, store });

    // Simulate 50 engagement aggregates arriving while a user reads a
    // page (every ~30s per tab × 4 tabs = these would have been 50
    // per-event drains pre-W2b). With W2b they trigger zero drains
    // because the materializer doesn't route the event type.
    for (let i = 1; i <= 50; i += 1) {
      const event = buildEvent({
        seq: i,
        type: 'engagement.session.aggregated',
        payload: {
          payloadVersion: 1,
          visitId: `visit-${String(i % 5)}`,
          sessionId: `session-${String(i)}`,
          dimensions: {
            engagement: {
              activeMs: 1000,
              visibleMs: 1000,
              focusedWindowMs: 1000,
              idleMs: 0,
              foregroundBursts: 1,
              returnCount: 0,
              scrollEvents: 0,
              maxScrollRatio: 0,
              copyCount: 0,
              pasteCount: 0,
            },
          },
        },
      });
      await eventLog.importPeerEvent(event);
      m.onAccepted(event, { origin: 'peer' });
    }
    await m.awaitIdle();

    // No drains — engagement events are not in HANDLES.
    expect(putCurrentCalls).toBe(0);
  });

  // Stage 5.2 W4 — topic-revision skip-gate. When the previous active
  // topic revision matches the id we'd derive from the current visit
  // similarity + threshold + algorithm, skip the union-find pass and
  // reuse it. Pairs with W3: when visit similarity cache-hits, topics
  // inherit the cache hit downstream.
  it('topic-revision skip-gate reuses the active revision when its id matches', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    let putActiveRevisionCalls = 0;
    const baseTopicStore = createTopicRevisionStore(vaultRoot);
    const topicRevisionStore = {
      ...baseTopicStore,
      putActiveRevision: async (
        revision: import('../../producers/topic-revision.js').TopicRevision,
      ) => {
        putActiveRevisionCalls += 1;
        await baseTopicStore.putActiveRevision(revision);
      },
    };
    const embed = embedFromVectors(
      new Map<string, Float32Array>([
        ['visit-alpha', unit([1, 0])],
        ['visit-bravo', unit([1, 0])],
      ]),
    );
    const m = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
      embed,
      topicRevisionStore,
    });

    await eventLog.importPeerEvent(
      buildEvent({
        seq: 1,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-alpha',
          observedAt: '2026-05-07T10:00:00.000Z',
          url: 'https://example.test/alpha',
          canonicalUrl: 'https://example.test/alpha',
          title: 'visit-alpha',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );
    await eventLog.importPeerEvent(
      buildEvent({
        seq: 2,
        type: BROWSER_TIMELINE_OBSERVED,
        payload: {
          eventId: 'timeline-bravo',
          observedAt: '2026-05-07T10:05:00.000Z',
          url: 'https://example.test/bravo',
          canonicalUrl: 'https://example.test/bravo',
          title: 'visit-bravo',
          provider: 'generic',
          transition: 'activated',
          payloadVersion: 1,
          dimensions: { engagement: { focusedWindowMs: 10_000 } },
        },
      }),
    );

    // First drain produces the topic revision.
    await m.catchUp(eventLog);
    await m.awaitIdle();
    const firstCalls = putActiveRevisionCalls;
    expect(firstCalls).toBeGreaterThanOrEqual(1);

    // Second drain with the same inputs hits the skip-gate — no new
    // topic revision written.
    await m.catchUp(eventLog);
    await m.awaitIdle();
    expect(putActiveRevisionCalls).toBe(firstCalls);
  });
});
