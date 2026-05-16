// Stage 5.2 — integration gap tests for W1 worker drain swap,
// W3 warmth-tracker recording, W4 topic accumulator shadow state,
// and W7 content-lane reconciler orchestration.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionsStore } from '../../connections/snapshot.js';
import { createTimelineStore } from '../../timeline/projection.js';
import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from '../../recall/events.js';
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
  acceptedAtMs: 1_700_000_000_000 + input.seq * 1000,
});

describe('Stage 5.2 integration gaps — materializer wiring', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-int-gaps-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  it('W3 — embedder warmth tracker exposes a snapshot', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const mat = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
    });
    const tracker = mat.getEmbedderWarmthTracker();
    const initial = tracker.snapshot(0);
    // Warmth is unknown before any embed has run.
    expect(initial.embedderWarmUntilMs).toBeUndefined();
    // After a recordEmbed call, warmth + p99 should be populated.
    tracker.recordEmbed(15);
    const after = tracker.snapshot(0);
    expect(after.embedderWarmUntilMs).toBeGreaterThan(0);
    expect(after.recentEmbedP99Ms).toBe(15);
  });

  it('W4 — topic accumulator is exposed and starts empty', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const mat = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
    });
    const acc = mat.getTopicAccumulator();
    expect(await acc.getComponents()).toEqual([]);
    // After an external addVisit + edge, derive components without
    // running a full materializer build.
    acc.addVisit({
      canonicalUrl: 'a',
      title: 'A',
      focusedWindowMs: 1000,
      firstObservedAt: '2026-05-12T00:00:00.000Z',
      lastObservedAt: '2026-05-12T00:00:00.000Z',
    });
    acc.addVisit({
      canonicalUrl: 'b',
      title: 'B',
      focusedWindowMs: 1000,
      firstObservedAt: '2026-05-12T00:00:00.000Z',
      lastObservedAt: '2026-05-12T00:00:00.000Z',
    });
    acc.addSimilarityEdge({ fromVisitKey: 'a', toVisitKey: 'b', cosine: 0.9 }, 0.85);
    const components = await acc.getComponents();
    expect(components).toHaveLength(1);
  });

  it('W7 — drainContentLaneQueue invokes the reconciler + acks via clearDirtySources', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const mat = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
    });

    // Seed three Group B events: two captures (dirty) + one tombstone.
    mat.onAccepted(
      buildEvent({
        seq: 1,
        type: CAPTURE_RECORDED,
        payload: { sourceUnitId: 'src-1' },
      }),
      { origin: 'local' },
    );
    mat.onAccepted(
      buildEvent({
        seq: 2,
        type: CAPTURE_RECORDED,
        payload: { sourceUnitId: 'src-2' },
      }),
      { origin: 'local' },
    );
    mat.onAccepted(
      buildEvent({
        seq: 3,
        type: RECALL_TOMBSTONE_TARGET,
        payload: { sourceUnitId: 'src-tomb' },
      }),
      { origin: 'local' },
    );

    expect(mat.getDirtySources().dirtySourceUnitIds).toHaveLength(3);

    const reconciled: string[] = [];
    const tombstoned: string[] = [];
    const processed = await mat.drainContentLaneQueue({
      reconcileSourceUnit: (id) => {
        reconciled.push(id);
        return Promise.resolve(true);
      },
      reconcileTombstone: (id) => {
        tombstoned.push(id);
        return Promise.resolve(true);
      },
    });
    expect(processed).toBe(3);
    expect(tombstoned).toEqual(['src-tomb']);
    expect(reconciled.sort()).toEqual(['src-1', 'src-2']);
    expect(mat.getDirtySources().dirtySourceUnitIds).toEqual([]);
  });

  it('W7 — reconciler returning false leaves the source dirty for retry', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const mat = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
    });
    mat.onAccepted(
      buildEvent({
        seq: 1,
        type: CAPTURE_RECORDED,
        payload: { sourceUnitId: 'src-fail' },
      }),
      { origin: 'local' },
    );
    const processed = await mat.drainContentLaneQueue({
      reconcileSourceUnit: () => Promise.resolve(false),
      reconcileTombstone: () => Promise.resolve(true),
    });
    expect(processed).toBe(0);
    expect(mat.getDirtySources().dirtySourceUnitIds).toEqual(['src-fail']);
  });

  it('W7 — reconciler throwing leaves the source dirty for retry', async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    const timelineStore = createTimelineStore(vaultRoot);
    const store = createConnectionsStore(vaultRoot);
    const mat = createConnectionsMaterializer({
      vaultRoot,
      eventLog,
      timelineStore,
      store,
    });
    mat.onAccepted(
      buildEvent({
        seq: 1,
        type: CAPTURE_RECORDED,
        payload: { sourceUnitId: 'src-boom' },
      }),
      { origin: 'local' },
    );
    const processed = await mat.drainContentLaneQueue({
      reconcileSourceUnit: () => {
        throw new Error('boom');
      },
      reconcileTombstone: () => Promise.resolve(true),
    });
    expect(processed).toBe(0);
    expect(mat.getDirtySources().dirtySourceUnitIds).toEqual(['src-boom']);
  });
});
