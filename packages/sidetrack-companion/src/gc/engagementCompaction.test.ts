import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { engagementInputsFromEvents } from '../engagement/engagementFactsStore.js';
import {
  ENGAGEMENT_INTERVAL_OBSERVED,
  ENGAGEMENT_SESSION_AGGREGATED,
  type EngagementDimensions,
} from '../engagement/events.js';
import { NAVIGATION_COMMITTED } from '../navigation/events.js';
import { VISIT_SIMILARITY_DEFAULT_ENGAGEMENT_GATE_MS } from '../connections/visitSimilarity.js';
import type { AcceptedEvent } from '../sync/causal.js';
import { getEventLaneHealth, resetEventLaneHealthForTests } from '../sync/eventLaneHealth.js';
import { createEventLog, isAcceptedEvent, type EventLog } from '../sync/eventLog.js';
import { createEventStore, type EventStore } from '../sync/eventStore.js';
import { loadOrCreateReplica } from '../sync/replicaId.js';
import {
  applyEngagementCompaction,
  type EngagementCompactionObservation,
  planEngagementCompaction,
} from './compactionPlanner.js';

const dimensions = (overrides: Partial<EngagementDimensions> = {}): EngagementDimensions => ({
  activeMs: 0,
  visibleMs: 0,
  focusedWindowMs: 0,
  idleMs: 0,
  foregroundBursts: 0,
  returnCount: 0,
  scrollEvents: 0,
  maxScrollRatio: 0,
  copyCount: 0,
  pasteCount: 0,
  ...overrides,
});

const acceptedEventFromFixtureLine = (line: string): AcceptedEvent => {
  const parsed = JSON.parse(line) as unknown;
  if (!isAcceptedEvent(parsed)) throw new Error('invalid fixture event');
  return parsed;
};

const servedArtifact = async (
  store: EventStore,
): Promise<{
  readonly aggregateRows: string;
  readonly focusedWindowMs: string;
  readonly eligibleVisits: string;
}> => {
  const aggregates: AcceptedEvent[] = [];
  await store.forEachChunkOfTypes(
    [ENGAGEMENT_SESSION_AGGREGATED],
    (chunk) => {
      aggregates.push(...chunk);
    },
    20,
  );
  const inputs = [...engagementInputsFromEvents(aggregates, [])].sort((left, right) =>
    left.visitId.localeCompare(right.visitId),
  );
  const focused = inputs.map((input) => [input.visitId, input.engagement.focusedWindowMs] as const);
  return {
    aggregateRows: JSON.stringify(aggregates),
    focusedWindowMs: JSON.stringify(focused),
    eligibleVisits: JSON.stringify(
      focused
        .filter(([, focusedWindowMs]) => {
          return focusedWindowMs >= VISIT_SIMILARITY_DEFAULT_ENGAGEMENT_GATE_MS;
        })
        .map(([visitId]) => visitId),
    ),
  };
};

describe('engagement compaction through the canonical log and served event store', () => {
  let vaultRoot: string;
  let eventLog: EventLog;
  let now: Date;

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-engagement-compaction-'));
    now = new Date('2020-01-01T12:00:00.000Z');
    const replica = await loadOrCreateReplica(vaultRoot);
    eventLog = createEventLog(vaultRoot, replica, { now: () => now });
    process.env['SIDETRACK_ENGAGEMENT_COMPACT'] = '1';
    resetEventLaneHealthForTests();
  });

  afterEach(async () => {
    delete process.env['SIDETRACK_ENGAGEMENT_COMPACT'];
    delete process.env['SIDETRACK_ENGAGEMENT_COMPACT_DAYS'];
    resetEventLaneHealthForTests();
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const appendInterval = async (
    id: string,
    visitId: string,
    focusedWindowMs: number,
  ): Promise<void> => {
    await eventLog.appendClientObserved({
      clientEventId: id,
      aggregateId: `${ENGAGEMENT_INTERVAL_OBSERVED}:${visitId}`,
      type: ENGAGEMENT_INTERVAL_OBSERVED,
      baseVector: {},
      payload: {
        payloadVersion: 1,
        visitId,
        intervalStart: now.getTime(),
        intervalEnd: now.getTime() + 1_000,
        dimensions: {
          engagement: dimensions({ activeMs: focusedWindowMs, focusedWindowMs }),
        },
      },
    });
  };

  const appendAggregate = async (
    id: string,
    visitId: string,
    focusedWindowMs: number,
  ): Promise<void> => {
    await eventLog.appendClientObserved({
      clientEventId: id,
      aggregateId: `${ENGAGEMENT_SESSION_AGGREGATED}:${visitId}`,
      type: ENGAGEMENT_SESSION_AGGREGATED,
      baseVector: {},
      payload: {
        payloadVersion: 1,
        visitId,
        sessionId: `session-${visitId}`,
        dimensions: {
          engagement: dimensions({ activeMs: focusedWindowMs, focusedWindowMs }),
        },
      },
    });
  };

  const appendNavigation = async (id: string, visitId: string): Promise<void> => {
    await eventLog.appendClientObserved({
      clientEventId: id,
      aggregateId: `${NAVIGATION_COMMITTED}:${visitId}`,
      type: NAVIGATION_COMMITTED,
      baseVector: {},
      payload: {
        payloadVersion: 1,
        visitId,
        url: `https://example.com/${visitId}`,
        canonicalUrl: `https://example.com/${visitId}`,
      },
    });
  };

  const writeCanonicalFixture = async (): Promise<string> => {
    await appendInterval('covered-1', 'covered', 400);
    await appendInterval('covered-2', 'covered', 400);
    await appendNavigation('nav-covered', 'covered');
    await appendInterval('covered-3', 'covered', 400);
    await appendInterval('uncovered-1', 'uncovered', 7_000);
    await appendNavigation('nav-uncovered', 'uncovered');
    const replicaId = (await eventLog.listReplicaIds())[0];
    if (replicaId === undefined) throw new Error('fixture replica missing');

    // Coverage deliberately lives in a later shard and disagrees with the raw
    // sum (9000 vs 1200), proving the served value comes from the aggregate.
    now = new Date('2026-07-29T12:00:00.000Z');
    await appendAggregate('aggregate-covered', 'covered', 9_000);
    await appendAggregate('aggregate-below', 'below', 1_200);
    await appendNavigation('nav-below', 'below');
    return replicaId;
  };

  it('writes canonical events, compacts online, and reads the identical served aggregate artifact after restart', async () => {
    const replicaId = await writeCanonicalFixture();
    const logRoot = join(vaultRoot, '_BAC', 'log');
    const sealedPath = join(logRoot, replicaId, '2020-01-01.jsonl');
    const observations: EngagementCompactionObservation[] = [];

    const beforeStore = await createEventStore(vaultRoot);
    await beforeStore.catchUpFromJsonl(logRoot);
    const before = await servedArtifact(beforeStore);
    expect(before.eligibleVisits).toBe(JSON.stringify(['covered']));
    expect(beforeStore.expectedRetainedCount()).toBe(beforeStore.count());
    beforeStore.close();

    // Warm the add-only append indexes before the rewrite. The real online
    // maintenance path must invalidate them and allow a subsequent append.
    await eventLog.prewarmAppendIndexes();
    const plan = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00.000Z'),
      retainDays: 30,
      onlineMaintenance: true,
      observe: (observation) => observations.push(observation),
    });
    expect(plan.wouldRewrite).toBe(true);
    expect(plan.intervalsFolded).toBe(3);
    expect(Object.values(plan.proofs).every((proof) => proof.status === 'passed')).toBe(true);

    const result = await applyEngagementCompaction(plan, {
      eventLog,
      observe: (observation) => observations.push(observation),
    });
    expect(result).toMatchObject({ rewrittenShards: 1, droppedLines: 3, skipped: null });
    expect(result.errors).toEqual([]);

    await appendNavigation('post-compaction-append', 'post-compaction');
    const restartedStore = await createEventStore(vaultRoot);
    await restartedStore.catchUpFromJsonl(logRoot);
    const after = await servedArtifact(restartedStore);
    expect(after).toEqual(before);
    expect(restartedStore.expectedRetainedCount()).toBe(restartedStore.count());
    expect(getEventLaneHealth().storeSkippedOutOfOrder).toBe(0);

    // A true rebuild from canonical JSONL has the same semantics and exact
    // compacted-dot accounting; no stale pre-compaction mirror rows help it.
    await restartedStore.rebuildFromJsonl(logRoot);
    expect(await servedArtifact(restartedStore)).toEqual(before);
    expect(restartedStore.expectedRetainedCount()).toBe(restartedStore.count());
    restartedStore.close();

    const sealedEvents = (await readFile(sealedPath, 'utf8'))
      .trim()
      .split('\n')
      .map(acceptedEventFromFixtureLine);
    expect(
      sealedEvents.filter((event) => event.type === ENGAGEMENT_INTERVAL_OBSERVED),
    ).toHaveLength(1);
    expect(sealedEvents.filter((event) => event.type === NAVIGATION_COMMITTED)).toHaveLength(2);
    expect(observations.map((observation) => [observation.operation, observation.outcome])).toEqual(
      [
        ['sidetrack.gc.engagement_compaction.plan', 'ready'],
        ['sidetrack.gc.engagement_compaction.apply', 'succeeded'],
      ],
    );
  });

  it('retains raw detail without aggregate coverage and has no force bypass', async () => {
    await appendInterval('only-raw', 'uncovered', 6_000);
    const plan = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00.000Z'),
      retainDays: 30,
      offline: true,
    });
    expect(plan.intervalsFolded).toBe(0);
    expect(plan.visitsUncovered).toBe(1);
    expect(plan.wouldRewrite).toBe(false);
    const result = await applyEngagementCompaction(plan, { offline: true });
    expect(result.skipped).toBe('blocked');
  });

  it('fails closed when a planned source changes before apply', async () => {
    const replicaId = await writeCanonicalFixture();
    const plan = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00.000Z'),
      retainDays: 30,
      offline: true,
    });
    await appendFile(
      join(vaultRoot, '_BAC', 'log', replicaId, '2020-01-01.jsonl'),
      '{"tampered":true}\n',
      'utf8',
    );
    const result = await applyEngagementCompaction(plan, { offline: true });
    expect(result.skipped).toBe('blocked');
    expect(result.errors).toEqual(['source-changed']);
  });

  it('recovers a prepared receipt whose shard is still in source state', async () => {
    const replicaId = await writeCanonicalFixture();
    const sealedPath = join(vaultRoot, '_BAC', 'log', replicaId, '2020-01-01.jsonl');
    const source = await readFile(sealedPath, 'utf8');
    const firstPlan = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00.000Z'),
      retainDays: 30,
      offline: true,
    });
    expect((await applyEngagementCompaction(firstPlan, { offline: true })).errors).toEqual([]);

    // Models a crash after the prepared manifest became durable but before the
    // shard rename. Source digest + receipt are both intact, so retry finishes.
    await writeFile(sealedPath, source, 'utf8');
    const recoveryPlan = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00.000Z'),
      retainDays: 30,
      offline: true,
    });
    expect(recoveryPlan.proofs.crashRecovery.status).toBe('passed');
    const recovered = await applyEngagementCompaction(recoveryPlan, { offline: true });
    expect(recovered).toMatchObject({ rewrittenShards: 1, droppedLines: 3, errors: [] });
  });

  it('does not let compacted-dot accounting hide a genuine unrelated sequence hole', async () => {
    const replicaId = await writeCanonicalFixture();
    const plan = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00.000Z'),
      retainDays: 30,
      offline: true,
    });
    await applyEngagementCompaction(plan, { offline: true });

    const livePath = join(vaultRoot, '_BAC', 'log', replicaId, '2026-07-29.jsonl');
    const live = (await readFile(livePath, 'utf8'))
      .trim()
      .split('\n')
      .filter((line) => {
        const parsed = acceptedEventFromFixtureLine(line);
        return parsed.clientEventId !== 'aggregate-below';
      });
    await writeFile(livePath, `${live.join('\n')}\n`, 'utf8');

    const store = await createEventStore(vaultRoot);
    await store.rebuildFromJsonl(join(vaultRoot, '_BAC', 'log'));
    expect(store.expectedRetainedCount() - store.count()).toBe(1);
    store.close();
  });

  it('withdraws compacted-dot credit when the durable manifest becomes invalid', async () => {
    await writeCanonicalFixture();
    const plan = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00.000Z'),
      retainDays: 30,
      offline: true,
    });
    await applyEngagementCompaction(plan, { offline: true });
    const logRoot = join(vaultRoot, '_BAC', 'log');
    const store = await createEventStore(vaultRoot);
    await store.catchUpFromJsonl(logRoot);
    expect(store.expectedRetainedCount() - store.count()).toBe(0);

    await writeFile(
      join(vaultRoot, '_BAC', 'connections', 'engagement-compaction-manifest.json'),
      '{"schemaVersion":1,"entries":"tampered"}\n',
      'utf8',
    );
    await store.catchUpFromJsonl(logRoot);
    expect(store.expectedRetainedCount() - store.count()).toBe(3);
    store.close();
  });

  it('blocks planning when a durable receipt or covered shard is tampered', async () => {
    const replicaId = await writeCanonicalFixture();
    const ready = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00.000Z'),
      retainDays: 30,
      offline: true,
    });
    await applyEngagementCompaction(ready, { offline: true });
    const sealedPath = join(vaultRoot, '_BAC', 'log', replicaId, '2020-01-01.jsonl');
    await appendFile(sealedPath, '{"tampered":true}\n', 'utf8');
    const blockedByShard = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00.000Z'),
      retainDays: 30,
      offline: true,
    });
    expect(blockedByShard.blockers.map((blocker) => blocker.id)).toContain(
      'compaction-receipt-shard-mismatch',
    );

    const manifestPath = join(
      vaultRoot,
      '_BAC',
      'connections',
      'engagement-compaction-manifest.json',
    );
    await writeFile(manifestPath, '{"schemaVersion":1,"entries":"bad"}\n', 'utf8');
    const blockedByManifest = await planEngagementCompaction(vaultRoot, {
      now: new Date('2026-07-29T12:00:00.000Z'),
      retainDays: 30,
      offline: true,
    });
    expect(blockedByManifest.blockers.map((blocker) => blocker.id)).toContain(
      'compaction-manifest-invalid',
    );
  });
});
