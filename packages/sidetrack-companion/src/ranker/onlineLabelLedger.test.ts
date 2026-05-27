import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  USER_FLOW_CONFIRMED,
  USER_FLOW_REJECTED,
  USER_ORGANIZED_ITEM,
  USER_SNIPPET_PROMOTED,
} from '../feedback/events.js';
import { type AcceptedEvent } from '../sync/causal.js';
import { FEATURE_SCHEMA_VERSION } from './feature-schema.js';
import {
  advanceFrontier,
  EMPTY_ONLINE_RANKER_STATE,
  labelKeyFor,
  readOnlineRankerState,
  replayLabelLedger,
  writeOnlineRankerState,
} from './onlineLabelLedger.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const baseAt = Date.parse('2026-05-26T12:00:00.000Z');

const flowConfirmed = (
  replicaId: string,
  seq: number,
  fromId: string,
  toId: string,
): AcceptedEvent => ({
  clientEventId: `flow-confirmed-${replicaId}-${String(seq)}`,
  dot: { replicaId, seq },
  deps: {},
  aggregateId: `flow:${fromId}:${toId}`,
  type: USER_FLOW_CONFIRMED,
  payload: {
    payloadVersion: 1,
    relationKind: 'closest_visit',
    fromId,
    toId,
  },
  acceptedAtMs: baseAt + seq,
});

const flowRejected = (
  replicaId: string,
  seq: number,
  fromId: string,
  toId: string,
): AcceptedEvent => ({
  clientEventId: `flow-rejected-${replicaId}-${String(seq)}`,
  dot: { replicaId, seq },
  deps: {},
  aggregateId: `flow:${fromId}:${toId}`,
  type: USER_FLOW_REJECTED,
  payload: {
    payloadVersion: 1,
    relationKind: 'closest_visit',
    fromId,
    toId,
    reason: 'not-related',
  },
  acceptedAtMs: baseAt + seq,
});

const organizedMove = (
  replicaId: string,
  seq: number,
  itemId: string,
  toContainer: string | null,
): AcceptedEvent => ({
  clientEventId: `organized-${replicaId}-${String(seq)}`,
  dot: { replicaId, seq },
  deps: {},
  aggregateId: `feedback:${itemId}`,
  type: USER_ORGANIZED_ITEM,
  payload: {
    payloadVersion: 1,
    itemKind: 'canonical-url',
    itemId,
    action: 'move',
    toContainer,
  },
  acceptedAtMs: baseAt + seq,
});

const organizedIgnore = (replicaId: string, seq: number, itemId: string): AcceptedEvent => ({
  clientEventId: `organized-ignore-${replicaId}-${String(seq)}`,
  dot: { replicaId, seq },
  deps: {},
  aggregateId: `feedback:${itemId}`,
  type: USER_ORGANIZED_ITEM,
  payload: {
    payloadVersion: 1,
    itemKind: 'canonical-url',
    itemId,
    action: 'ignore',
  },
  acceptedAtMs: baseAt + seq,
});

const snippetPromoted = (
  replicaId: string,
  seq: number,
  sourceVisitId: string,
  targetId: string,
): AcceptedEvent => ({
  clientEventId: `snippet-${replicaId}-${String(seq)}`,
  dot: { replicaId, seq },
  deps: {},
  aggregateId: `snippet:${sourceVisitId}:${targetId}`,
  type: USER_SNIPPET_PROMOTED,
  payload: {
    payloadVersion: 1,
    snippetId: `snippet-${sourceVisitId}`,
    targetKind: 'thread',
    targetId,
    sourceVisitId,
  },
  acceptedAtMs: baseAt + seq,
});

describe('replayLabelLedger — deterministic projection of feedback events', () => {
  it('extracts a positive label from USER_FLOW_CONFIRMED', () => {
    const labels = replayLabelLedger([flowConfirmed('a', 1, 'visit-1', 'visit-2')]);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      labelKey: labelKeyFor('visit-1', 'visit-2', 'positive'),
      fromVisitId: 'visit-1',
      toVisitId: 'visit-2',
      polarity: 'positive',
      eventType: USER_FLOW_CONFIRMED,
    });
  });

  it('extracts a negative label from USER_FLOW_REJECTED', () => {
    const labels = replayLabelLedger([flowRejected('a', 1, 'visit-1', 'visit-2')]);
    expect(labels).toHaveLength(1);
    expect(labels[0]?.polarity).toBe('negative');
  });

  it('extracts a positive label from USER_ORGANIZED_ITEM move (the dogfood case)', () => {
    const labels = replayLabelLedger([organizedMove('a', 1, 'visit-x', 'workstream-y')]);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      polarity: 'positive',
      fromVisitId: 'visit-x',
      toVisitId: 'workstream-y',
    });
  });

  it('does NOT extract a label from USER_ORGANIZED_ITEM ignore', () => {
    // Container-level negatives remain event-scoped and are not
    // expanded by the online ledger.
    expect(replayLabelLedger([organizedIgnore('a', 1, 'visit-x')])).toEqual([]);
  });

  it('extracts a positive label from USER_SNIPPET_PROMOTED', () => {
    const labels = replayLabelLedger([snippetPromoted('a', 1, 'visit-src', 'thread-dst')]);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      polarity: 'positive',
      fromVisitId: 'visit-src',
      toVisitId: 'thread-dst',
    });
  });

  it('dedupes repeated (fromId, toId, polarity) emissions across events', () => {
    // The user might USER_FLOW_CONFIRMED the same pair twice (UI
    // retry, sync re-import, etc.). The ledger collapses to one
    // record per labelKey, anchored at the causally-earliest dot.
    const labels = replayLabelLedger([
      flowConfirmed('a', 2, 'visit-1', 'visit-2'),
      flowConfirmed('a', 5, 'visit-1', 'visit-2'),
      flowConfirmed('a', 1, 'visit-1', 'visit-2'),
    ]);
    expect(labels).toHaveLength(1);
    expect(labels[0]?.firstObservedDot.seq).toBe(1);
    expect(labels[0]?.lastObservedDot.seq).toBe(5);
  });

  it('returns labels in sorted labelKey order (replay determinism)', () => {
    const a = replayLabelLedger([
      flowConfirmed('r', 1, 'visit-c', 'visit-d'),
      flowConfirmed('r', 2, 'visit-a', 'visit-b'),
    ]);
    const b = replayLabelLedger([
      flowConfirmed('r', 2, 'visit-a', 'visit-b'),
      flowConfirmed('r', 1, 'visit-c', 'visit-d'),
    ]);
    // Same event set, different arrival order → identical ledger.
    expect(a.map((l) => l.labelKey)).toEqual(b.map((l) => l.labelKey));
  });

  it('produces the same ledger across interleaved replicas (causal commutativity)', () => {
    // Two replicas emit feedback concurrently; the merged log can
    // arrive in any interleaving. The projection must be insensitive
    // to interleaving (causal commutativity is the IVM contract).
    const replicaA = flowConfirmed('A', 1, 'visit-1', 'visit-2');
    const replicaB = flowConfirmed('B', 1, 'visit-3', 'visit-4');
    const interleaved1 = [replicaA, replicaB];
    const interleaved2 = [replicaB, replicaA];
    expect(replayLabelLedger(interleaved1)).toEqual(replayLabelLedger(interleaved2));
  });
});

describe('advanceFrontier — exactly-once per labelKey, monotone frontier', () => {
  it('starts from EMPTY_ONLINE_RANKER_STATE and folds in a batch', () => {
    const empty = EMPTY_ONLINE_RANKER_STATE(33);
    const result = advanceFrontier(
      empty,
      [flowConfirmed('r', 1, 'visit-1', 'visit-2'), flowConfirmed('r', 2, 'visit-3', 'visit-4')],
      baseAt,
    );
    expect(result.state.updateCount).toBe(2);
    expect(result.state.appliedLabelKeys).toHaveLength(2);
    expect(result.state.appliedLabelFrontier['r']).toBe(2);
    expect(result.newLabels).toHaveLength(2);
  });

  it('is idempotent — re-folding the same batch produces the same state and no new labels', () => {
    const empty = EMPTY_ONLINE_RANKER_STATE(33);
    const events = [flowConfirmed('r', 1, 'visit-1', 'visit-2')];
    const once = advanceFrontier(empty, events, baseAt).state;
    const twice = advanceFrontier(once, events, baseAt + 1);
    expect(twice.newLabels).toEqual([]);
    expect(twice.state.appliedLabelKeys).toEqual(once.appliedLabelKeys);
    expect(twice.state.appliedLabelFrontier).toEqual(once.appliedLabelFrontier);
  });

  it('returns only LABEL-keys not previously applied as `newLabels`', () => {
    // Snapshot the state after batch 1, then advance with batch 2
    // that overlaps with batch 1. Only the strictly-new keys appear
    // in `newLabels`.
    const empty = EMPTY_ONLINE_RANKER_STATE(33);
    const batch1 = [flowConfirmed('r', 1, 'visit-1', 'visit-2')];
    const batch2 = [
      flowConfirmed('r', 1, 'visit-1', 'visit-2'), // same as batch1 → no-op
      flowConfirmed('r', 2, 'visit-3', 'visit-4'), // new
    ];
    const state1 = advanceFrontier(empty, batch1, baseAt).state;
    const result2 = advanceFrontier(state1, batch2, baseAt + 1);
    expect(result2.newLabels).toHaveLength(1);
    expect(result2.newLabels[0]?.fromVisitId).toBe('visit-3');
    expect(result2.state.updateCount).toBe(2);
  });

  it('advances the frontier monotonically across replicas', () => {
    const empty = EMPTY_ONLINE_RANKER_STATE(33);
    const result = advanceFrontier(
      empty,
      [
        flowConfirmed('A', 3, 'visit-1', 'visit-2'),
        flowConfirmed('B', 7, 'visit-3', 'visit-4'),
        flowConfirmed('A', 1, 'visit-5', 'visit-6'),
      ],
      baseAt,
    );
    // Per-replica max of observed dots.
    expect(result.state.appliedLabelFrontier).toEqual({ A: 3, B: 7 });
  });

  it('keeps the digest invariant under arrival-order permutation', () => {
    // Same event SET in two arrival orders produces the same digest
    // (sortedness of appliedLabelKeys is the invariant).
    const empty = EMPTY_ONLINE_RANKER_STATE(33);
    const events1 = [
      flowConfirmed('A', 1, 'visit-1', 'visit-2'),
      flowConfirmed('B', 2, 'visit-3', 'visit-4'),
    ];
    const events2 = [events1[1]!, events1[0]!];
    const digest1 = advanceFrontier(empty, events1, baseAt).state.appliedLabelKeysDigest;
    const digest2 = advanceFrontier(empty, events2, baseAt).state.appliedLabelKeysDigest;
    expect(digest1).toBe(digest2);
  });

  it('captures labels from late-arriving lower-seq events when the frontier was already advanced past them (Codex review of #231)', () => {
    // Codex review caught: the earlier implementation filtered
    // events upfront by `vectorCovers(frontier, dot)` AND advanced
    // the frontier by `maxVector` (not contiguous-prefix). So a
    // replica that emitted events 1, 7 would advance the frontier
    // to {r:7}; a late-arriving event 4 from the same replica would
    // be silently dropped because vectorCovers({r:7}, {r,4}) is
    // true. Fix: use appliedLabelKeys as the sole source of truth
    // for de-dup, with the frontier purely informational.
    const empty = EMPTY_ONLINE_RANKER_STATE(33);
    // Batch 1: seq 1 and 7 (a gap at 2..6).
    const batch1 = [
      flowConfirmed('r', 1, 'visit-1', 'visit-2'),
      flowConfirmed('r', 7, 'visit-7', 'visit-8'),
    ];
    const state1 = advanceFrontier(empty, batch1, baseAt).state;
    expect(state1.appliedLabelKeys).toHaveLength(2);
    expect(state1.appliedLabelFrontier['r']).toBe(7);

    // Batch 2: the gap-filling event at seq 4. Per the old
    // vectorCovers-based filter this would be `covered` and the
    // label dropped silently. Post-fix it must land.
    const batch2 = [flowConfirmed('r', 4, 'visit-4', 'visit-5')];
    const result = advanceFrontier(state1, batch2, baseAt + 1);
    expect(result.newLabels).toHaveLength(1);
    expect(result.newLabels[0]?.fromVisitId).toBe('visit-4');
    expect(result.state.appliedLabelKeys).toHaveLength(3);
    // Frontier is informational (max-per-replica); it stays at 7
    // because 4 < 7, but the label still got captured.
    expect(result.state.appliedLabelFrontier['r']).toBe(7);
  });
});

describe('OnlineRankerState persistence', () => {
  it('round-trips through write/read and preserves every field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidetrack-online-state-'));
    tempRoots.push(root);
    const empty = EMPTY_ONLINE_RANKER_STATE(33);
    const populated = advanceFrontier(
      empty,
      [flowConfirmed('r', 1, 'visit-1', 'visit-2'), flowConfirmed('r', 2, 'visit-3', 'visit-4')],
      baseAt,
    ).state;
    await writeOnlineRankerState(root, populated);
    const reloaded = await readOnlineRankerState(root);
    expect(reloaded).toEqual(populated);
  });

  it('returns null when the state file is absent (caller treats as fresh start)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sidetrack-online-state-absent-'));
    tempRoots.push(root);
    expect(await readOnlineRankerState(root)).toBeNull();
  });

  it('returns null when the persisted featureSchemaVersion differs (refuse-to-score on schema drift)', async () => {
    // Future schema bump (FEATURE_SCHEMA_VERSION: 4 → 5) invalidates
    // every persisted state — the loader refuses to score under the
    // wrong feature regime, forcing the caller to re-base.
    const root = await mkdtemp(join(tmpdir(), 'sidetrack-online-state-stale-'));
    tempRoots.push(root);
    const empty = EMPTY_ONLINE_RANKER_STATE(33);
    await writeOnlineRankerState(root, empty);
    // Hand-edit the persisted state to a divergent schema version.
    const { writeFile } = await import('node:fs/promises');
    const { onlineRankerStatePath } = await import('./onlineLabelLedger.js');
    const path = onlineRankerStatePath(root);
    const stale = { ...empty, featureSchemaVersion: FEATURE_SCHEMA_VERSION + 1 };
    await writeFile(path, `${JSON.stringify(stale, null, 2)}\n`, 'utf8');
    expect(await readOnlineRankerState(root)).toBeNull();
  });
});
