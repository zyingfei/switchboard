// Move 3 (b)+(c) — impression-path cooldown/fingerprint guard + off-thread train.
//
// (b) A no-new-label second drain must short-circuit BEFORE the group build +
//     train (exactly zero group-builds / trains on the second drain).
// (c) The impression retrain must train through the injected `trainGroups` seam
//     (the worker in production), never inline on the drain thread.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionsSnapshot } from '../connections/types.js';
import {
  RECALL_ACTION,
  RECALL_SERVED,
  type RecallActionKind,
  type RecallActionPayload,
  type RecallServedCandidateSnapshot,
  type RecallServedPayload,
} from '../recall/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import {
  maybeRetrainClosestVisitRanker,
  planImpressionRetrain,
  type ImpressionRetrainGuardState,
  type TrainGroupsFn,
} from './retrain.js';
import { fingerprintTrainableEvents } from './trainableEventsShard.js';
import { trainRankerRevisionFromGroups } from './train.js';

const BASE_TIME = Date.parse('2026-07-11T18:00:00.000Z');

const snapshot: ConnectionsSnapshot = {
  scope: {},
  nodes: [],
  edges: [],
  updatedAt: new Date(BASE_TIME).toISOString(),
  nodeCount: 0,
  edgeCount: 0,
};

const evt = <TPayload>(input: {
  readonly seq: number;
  readonly type: string;
  readonly payload: TPayload;
  readonly acceptedAtMs: number;
}): AcceptedEvent<TPayload> => ({
  clientEventId: `evt-${String(input.seq)}`,
  dot: { replicaId: 'replica-a', seq: input.seq },
  deps: {},
  aggregateId:
    typeof input.payload === 'object' &&
    input.payload !== null &&
    'servedContextId' in input.payload &&
    typeof input.payload.servedContextId === 'string'
      ? input.payload.servedContextId
      : `agg-${String(input.seq)}`,
  type: input.type,
  payload: input.payload,
  acceptedAtMs: input.acceptedAtMs,
});

const servedCandidate = (
  entityId: string,
  sourceKind: string,
  servedPosition: number,
): RecallServedCandidateSnapshot => ({
  entityId,
  sourceKind,
  canonicalUrl: `https://example.test/${entityId}`,
  fusedScore: 1 / (servedPosition + 1),
  servedPosition,
  perLaneRanks: { [sourceKind]: servedPosition + 1 },
  perLaneScores: { [sourceKind]: 1 / (servedPosition + 1) },
});

const served = (
  seq: number,
  servedContextId: string,
  candidates: readonly RecallServedCandidateSnapshot[],
): AcceptedEvent<RecallServedPayload> =>
  evt({
    seq,
    type: RECALL_SERVED,
    payload: {
      payloadVersion: 1,
      servedContextId,
      query: 'ranker training',
      intent: 'search',
      sessionContext: { currentUrl: 'https://example.test/anchor' },
      results: candidates,
      rerankApplied: false,
      sequenceNumber: seq,
      servedAt: new Date(BASE_TIME + seq * 1_000).toISOString(),
    },
    acceptedAtMs: BASE_TIME + seq * 1_000,
  });

const action = (
  seq: number,
  servedContextId: string,
  entityId: string,
  actionKind: RecallActionKind,
): AcceptedEvent<RecallActionPayload> =>
  evt({
    seq,
    type: RECALL_ACTION,
    payload: {
      payloadVersion: 1,
      servedContextId,
      entityId,
      actionKind,
      actionAt: new Date(BASE_TIME + seq * 1_000).toISOString(),
    },
    acceptedAtMs: BASE_TIME + seq * 1_000,
  });

/** A small set of served+judged impression groups: enough positive groups to
 *  enter the impression branch. */
const buildImpressionEvents = (groupCount: number): AcceptedEvent[] => {
  const merged: AcceptedEvent[] = [];
  let seq = 1;
  for (let index = 0; index < groupCount; index += 1) {
    const contextId = `ctx-${String(index)}`;
    merged.push(
      served(seq++, contextId, [
        servedCandidate(`positive-${String(index)}`, 'page_content', 0),
        servedCandidate(`negative-${String(index)}`, 'semantic_query', 1),
      ]),
    );
    merged.push(action(seq++, contextId, `positive-${String(index)}`, 'flow_confirm'));
    merged.push(action(seq++, contextId, `negative-${String(index)}`, 'reject'));
  }
  return merged;
};

describe('planImpressionRetrain', () => {
  const fp = (count: number, hash: string) => ({
    hash,
    count,
    countByType: {},
  });

  it('trains on a fresh fingerprint with no prior state', () => {
    const decision = planImpressionRetrain({ fingerprint: fp(3, 'a'.repeat(64)), state: null });
    expect(decision.action).toBe('train');
  });

  it('skips no-labels regardless of state', () => {
    const decision = planImpressionRetrain({ fingerprint: fp(0, 'a'.repeat(64)), state: null });
    expect(decision).toMatchObject({ action: 'skip', reason: 'no-labels' });
  });

  it('skips unchanged when the fingerprint matches the last attempt', () => {
    const hash = 'b'.repeat(64);
    const state: ImpressionRetrainGuardState = {
      schemaVersion: 1,
      lastFingerprintHash: hash,
      lastTrainableCount: 3,
      updatedAt: BASE_TIME,
    };
    const decision = planImpressionRetrain({
      fingerprint: fp(3, hash),
      state,
      nowMs: BASE_TIME + 60 * 60_000,
    });
    expect(decision).toMatchObject({ action: 'skip', reason: 'unchanged' });
  });

  it('holds during the cooldown window even with new labels', () => {
    const state: ImpressionRetrainGuardState = {
      schemaVersion: 1,
      lastFingerprintHash: 'b'.repeat(64),
      lastTrainableCount: 3,
      updatedAt: BASE_TIME,
    };
    const decision = planImpressionRetrain({
      fingerprint: fp(4, 'c'.repeat(64)),
      state,
      cooldownMs: 10 * 60_000,
      nowMs: BASE_TIME + 60_000,
    });
    expect(decision).toMatchObject({ action: 'skip', reason: 'cooldown' });
  });

  it('trains after the cooldown elapses with new labels', () => {
    const state: ImpressionRetrainGuardState = {
      schemaVersion: 1,
      lastFingerprintHash: 'b'.repeat(64),
      lastTrainableCount: 3,
      updatedAt: BASE_TIME,
    };
    const decision = planImpressionRetrain({
      fingerprint: fp(4, 'c'.repeat(64)),
      state,
      cooldownMs: 10 * 60_000,
      nowMs: BASE_TIME + 11 * 60_000,
    });
    expect(decision.action).toBe('train');
  });

  it('force bypasses unchanged + cooldown but not no-labels', () => {
    const state: ImpressionRetrainGuardState = {
      schemaVersion: 1,
      lastFingerprintHash: 'b'.repeat(64),
      lastTrainableCount: 3,
      updatedAt: BASE_TIME,
    };
    expect(
      planImpressionRetrain({ fingerprint: fp(3, 'b'.repeat(64)), state, force: true }).action,
    ).toBe('train');
    expect(
      planImpressionRetrain({ fingerprint: fp(0, 'b'.repeat(64)), state, force: true }),
    ).toMatchObject({ action: 'skip', reason: 'no-labels' });
  });
});

describe('maybeRetrainClosestVisitRanker — impression guard + off-thread train', () => {
  let vaultRoot: string;
  const priorMinGroups = process.env['SIDETRACK_RANKER_IMPRESSION_MIN_GROUPS'];
  const priorCooldown = process.env['SIDETRACK_RANKER_RETRAIN_COOLDOWN_MS'];

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-impression-guard-'));
    // One positive group is enough to enter the impression branch, so the guard
    // itself is what gates re-trains (not the floor).
    process.env['SIDETRACK_RANKER_IMPRESSION_MIN_GROUPS'] = '1';
    // Disable the cooldown so the ONLY thing suppressing the second drain is the
    // unchanged-fingerprint short-circuit (that's the property under test).
    process.env['SIDETRACK_RANKER_RETRAIN_COOLDOWN_MS'] = '0';
  });

  afterEach(async () => {
    if (priorMinGroups === undefined) delete process.env['SIDETRACK_RANKER_IMPRESSION_MIN_GROUPS'];
    else process.env['SIDETRACK_RANKER_IMPRESSION_MIN_GROUPS'] = priorMinGroups;
    if (priorCooldown === undefined) delete process.env['SIDETRACK_RANKER_RETRAIN_COOLDOWN_MS'];
    else process.env['SIDETRACK_RANKER_RETRAIN_COOLDOWN_MS'] = priorCooldown;
    await rm(vaultRoot, { recursive: true, force: true });
  });

  // In-memory guard-state store so the two drains share state without disk race.
  const guardStore = () => {
    let current: ImpressionRetrainGuardState | null = null;
    return {
      read: async (): Promise<ImpressionRetrainGuardState | null> => current,
      write: async (_root: string, next: ImpressionRetrainGuardState): Promise<void> => {
        current = next;
      },
    };
  };

  // A trainGroups spy that delegates to the REAL group trainer so the ship gate
  // (which loads the trained model) runs against valid model bytes. Counts calls
  // so the test can assert the second drain trains zero additional times.
  const spyTrainGroups = (): { fn: TrainGroupsFn; calls: () => number } => {
    let calls = 0;
    const fn: TrainGroupsFn = async (groups, options, labelingSummary) => {
      calls += 1;
      return trainRankerRevisionFromGroups(
        groups,
        { seed: 7, numRound: 2, trainedAt: BASE_TIME, ...options },
        labelingSummary,
      );
    };
    return { fn, calls: () => calls };
  };

  it('(c) trains via the injected worker seam, not inline', async () => {
    const merged = buildImpressionEvents(4);
    const spy = spyTrainGroups();
    const guard = guardStore();
    // If the impression path trained inline instead of via the seam, this spy
    // would never fire.
    const result = await maybeRetrainClosestVisitRanker({
      vaultRoot,
      merged,
      snapshot,
      trainGroups: spy.fn,
      readImpressionGuardState: guard.read,
      writeImpressionGuardState: guard.write,
    });
    expect(spy.calls()).toBe(1);
    // Whatever the ship-gate verdict, the train ran off the seam (never inline).
    expect(['trained', 'skipped']).toContain(result.status);
  });

  it('(b) a second no-new-label drain trains zero additional times', async () => {
    const merged = buildImpressionEvents(4);
    const spy = spyTrainGroups();
    const guard = guardStore();
    const run = () =>
      maybeRetrainClosestVisitRanker({
        vaultRoot,
        merged,
        snapshot,
        trainGroups: spy.fn,
        readImpressionGuardState: guard.read,
        writeImpressionGuardState: guard.write,
      });

    await run();
    expect(spy.calls()).toBe(1);

    // Identical events → identical trainable fingerprint → guard short-circuits
    // BEFORE the group build + train.
    const second = await run();
    expect(spy.calls()).toBe(1);
    expect(second).toMatchObject({ status: 'skipped', reason: 'unchanged' });
  });

  it('(b) a drain WITH a new label re-trains (fingerprint moved)', async () => {
    const spy = spyTrainGroups();
    const guard = guardStore();
    const first = buildImpressionEvents(4);
    await maybeRetrainClosestVisitRanker({
      vaultRoot,
      merged: first,
      snapshot,
      trainGroups: spy.fn,
      readImpressionGuardState: guard.read,
      writeImpressionGuardState: guard.write,
    });
    expect(spy.calls()).toBe(1);

    // A new judged group lands → fingerprint moves → the guard lets it through.
    const grown = buildImpressionEvents(5);
    expect(fingerprintTrainableEvents(grown).hash).not.toBe(
      fingerprintTrainableEvents(first).hash,
    );
    await maybeRetrainClosestVisitRanker({
      vaultRoot,
      merged: grown,
      snapshot,
      trainGroups: spy.fn,
      readImpressionGuardState: guard.read,
      writeImpressionGuardState: guard.write,
    });
    expect(spy.calls()).toBe(2);
  });

  it('(c) a worker failure surfaces as failed, never an inline fallback', async () => {
    const merged = buildImpressionEvents(4);
    const guard = guardStore();
    let calls = 0;
    const failingTrain: TrainGroupsFn = async () => {
      calls += 1;
      throw new Error('worker crashed');
    };
    const result = await maybeRetrainClosestVisitRanker({
      vaultRoot,
      merged,
      snapshot,
      trainGroups: failingTrain,
      readImpressionGuardState: guard.read,
      writeImpressionGuardState: guard.write,
    });
    expect(calls).toBe(1);
    expect(result.status).toBe('failed');

    // The guard must NOT be stamped on a failed train — a retry with the same
    // trainable set must proceed (not be blocked by the unchanged-hash guard).
    const spy = spyTrainGroups();
    await maybeRetrainClosestVisitRanker({
      vaultRoot,
      merged,
      snapshot,
      trainGroups: spy.fn,
      readImpressionGuardState: guard.read,
      writeImpressionGuardState: guard.write,
    });
    expect(spy.calls()).toBe(1);
  });
});
