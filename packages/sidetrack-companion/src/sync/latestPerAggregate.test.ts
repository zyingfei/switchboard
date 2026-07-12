import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AcceptedEvent } from './causal.js';
import { createEventLog } from './eventLog.js';
import { latestPerAggregate, latestPerAggregateFromLog } from './latestPerAggregate.js';
import { loadOrCreateReplica } from './replicaId.js';

// Fixture log: two aggregates, each with an older and a newer event, plus
// a high-volume type (engagement.interval.observed) that the projection
// materializer's handled-types set intentionally EXCLUDES. Pinning the
// shared fold against this fixture guards the behavior-preserving collapse
// of reproject / antiEntropy / projectionMaterializer.
const FIXTURE_EVENTS: readonly AcceptedEvent[] = [
  {
    clientEventId: 'e-old-t1',
    dot: { replicaId: 'peer-A', seq: 1 },
    deps: {},
    aggregateId: 't-1',
    type: 'thread.upserted',
    payload: { bac_id: 't-1', title: 'old' },
    acceptedAtMs: 10,
  },
  {
    clientEventId: 'e-new-t1',
    dot: { replicaId: 'peer-A', seq: 2 },
    deps: { 'peer-A': 1 },
    aggregateId: 't-1',
    type: 'thread.upserted',
    payload: { bac_id: 't-1', title: 'new' },
    acceptedAtMs: 20,
  },
  {
    clientEventId: 'e-ws1',
    dot: { replicaId: 'peer-A', seq: 3 },
    deps: { 'peer-A': 2 },
    aggregateId: 'ws-1',
    type: 'workstream.upserted',
    payload: { bac_id: 'ws-1', title: 'group' },
    acceptedAtMs: 30,
  },
  {
    clientEventId: 'e-eng',
    dot: { replicaId: 'peer-A', seq: 4 },
    deps: { 'peer-A': 3 },
    aggregateId: 'eng-1',
    type: 'engagement.interval.observed',
    payload: { bac_id: 'eng-1' },
    acceptedAtMs: 40,
  },
];

describe('latestPerAggregate (in-memory fold)', () => {
  it('keeps the newest event per aggregateId', () => {
    const latest = latestPerAggregate(FIXTURE_EVENTS);
    const byId = new Map(latest.map((e) => [e.aggregateId, e]));
    expect(latest.length).toBe(3);
    expect(byId.get('t-1')?.clientEventId).toBe('e-new-t1');
    expect(byId.get('ws-1')?.clientEventId).toBe('e-ws1');
    expect(byId.get('eng-1')?.clientEventId).toBe('e-eng');
  });
});

describe('latestPerAggregateFromLog', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-latest-per-agg-'));
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const seedLog = async () => {
    const replica = await loadOrCreateReplica(vaultRoot);
    const eventLog = createEventLog(vaultRoot, replica);
    for (const event of FIXTURE_EVENTS) {
      await eventLog.importPeerEvent(event);
    }
    return eventLog;
  };

  it('without handles folds EVERY type (reproject / antiEntropy behavior)', async () => {
    const eventLog = await seedLog();
    const latest = await latestPerAggregateFromLog(vaultRoot, eventLog);
    const byId = new Map(latest.map((e) => [e.aggregateId, e]));
    expect(new Set(byId.keys())).toEqual(new Set(['t-1', 'ws-1', 'eng-1']));
    // Newest event per aggregate wins.
    expect(byId.get('t-1')?.clientEventId).toBe('e-new-t1');
  });

  it('with handles folds ONLY the handled types (projection materializer behavior)', async () => {
    const eventLog = await seedLog();
    const handles = new Set(['thread.upserted', 'workstream.upserted']);
    const latest = await latestPerAggregateFromLog(vaultRoot, eventLog, handles);
    const byId = new Map(latest.map((e) => [e.aggregateId, e]));
    // engagement.interval.observed is excluded by the handles filter.
    expect(new Set(byId.keys())).toEqual(new Set(['t-1', 'ws-1']));
    expect(byId.get('t-1')?.clientEventId).toBe('e-new-t1');
  });
});
