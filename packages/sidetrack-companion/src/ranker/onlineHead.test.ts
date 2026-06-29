import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConnectionNode, ConnectionsSnapshot } from '../connections/types.js';
import { nodeIdFor } from '../connections/types.js';
import { USER_FLOW_CONFIRMED } from '../feedback/events.js';
import { NAVIGATION_COMMITTED } from '../navigation/events.js';
import type { AcceptedEvent } from '../sync/causal.js';
import type { CandidatePairFeatures } from './feature-schema.js';
import { FEATURE_SCHEMA_VERSION } from './feature-schema.js';
import {
  applyOnlineHeadDrainStep,
  onlineDelta,
  onlineRankerEnabled,
} from './onlineHead.js';
import {
  EMPTY_ONLINE_RANKER_STATE,
  onlineRankerStatePath,
  readOnlineRankerState,
  writeOnlineRankerState,
} from './onlineLabelLedger.js';
import { ONLINE_RANKER_WEIGHTS_LENGTH } from './onlinePairwiseUpdate.js';
import { RANKER_FEATURE_KEYS } from './train.js';

const FEATURE_COUNT = RANKER_FEATURE_KEYS.length;
const BASE_TIME = Date.parse('2026-05-07T10:00:00.000Z');

const navEvent = (seq: number, visitId: string, canonicalUrl: string): AcceptedEvent => ({
  clientEventId: `nav-${String(seq)}`,
  dot: { replicaId: 'replica-a', seq },
  deps: {},
  aggregateId: `agg-${String(seq)}`,
  type: NAVIGATION_COMMITTED,
  payload: {
    payloadVersion: 1,
    visitId,
    url: canonicalUrl,
    canonicalUrl,
    documentId: `doc-${visitId}`,
    parentDocumentId: null,
    tabSessionIdHash: 'tab-a',
    windowSessionIdHash: 'window-a',
    openerVisitId: null,
    previousVisitId: null,
    navigationSequence: 1,
    transitionType: 'link',
    transitionQualifiers: [],
    commitTimestamp: BASE_TIME + seq * 1_000,
  },
  acceptedAtMs: BASE_TIME + seq * 1_000,
});

const flowConfirmed = (seq: number, fromId: string, toId: string): AcceptedEvent => ({
  clientEventId: `flow-confirmed-${String(seq)}`,
  dot: { replicaId: 'replica-a', seq },
  deps: {},
  aggregateId: `flow:${fromId}:${toId}`,
  type: USER_FLOW_CONFIRMED,
  payload: { payloadVersion: 1, relationKind: 'closest_visit', fromId, toId },
  acceptedAtMs: BASE_TIME + seq * 1_000,
});

const visitNode = (visitKey: string, canonicalUrl: string): ConnectionNode => ({
  id: nodeIdFor('timeline-visit', visitKey),
  kind: 'timeline-visit',
  label: visitKey,
  firstSeenAt: '2026-05-07T10:00:01.000Z',
  lastSeenAt: '2026-05-07T10:00:03.000Z',
  originReplicaIds: ['replica-a'],
  metadata: { canonicalUrl, url: canonicalUrl, title: visitKey },
});

// Three github-repo siblings: a, b, c. `same_repo_or_domain` makes b
// and c candidates for a, so a flow-confirm of a→b leaves c as the
// deterministic competitor.
const REPO = 'https://github.com/zyingfei/switchboard';
const snapshot = (): ConnectionsSnapshot => ({
  scope: {},
  nodes: [
    visitNode('visit-a', `${REPO}/pull/1`),
    visitNode('visit-b', `${REPO}/pull/2`),
    visitNode('visit-c', `${REPO}/issues/3`),
  ],
  edges: [],
  updatedAt: '2026-05-07T10:00:03.000Z',
  nodeCount: 3,
  edgeCount: 0,
});
const repoMerged = (): readonly AcceptedEvent[] => [
  navEvent(1, 'visit-a', `${REPO}/pull/1`),
  navEvent(2, 'visit-b', `${REPO}/pull/2`),
  navEvent(3, 'visit-c', `${REPO}/issues/3`),
];

const zeros = (): readonly number[] => new Array(ONLINE_RANKER_WEIGHTS_LENGTH).fill(0) as number[];
const features = (overrides: Partial<CandidatePairFeatures> = {}): CandidatePairFeatures =>
  ({ schemaVersion: FEATURE_SCHEMA_VERSION, ...overrides }) as CandidatePairFeatures;

describe('onlineDelta', () => {
  it('returns 0 on a weight-vector length mismatch', () => {
    expect(onlineDelta(features(), [0, 0, 0])).toBe(0);
  });

  it('is 0 when all weights are 0', () => {
    expect(onlineDelta(features({ same_repo: 1 }), zeros())).toBe(0);
  });

  it('is deterministic for the same features + weights', () => {
    const weights = zeros().map((_, index) => (index === 1 ? 0.02 : 0)) as number[];
    const a = onlineDelta(features({ same_workstream: 1 }), weights, 1);
    const b = onlineDelta(features({ same_workstream: 1 }), weights, 1);
    expect(a).toBe(b);
  });

  it('clamps the magnitude to ±clamp', () => {
    const big = zeros().map(() => 100);
    expect(onlineDelta(features({ same_repo: 1, same_workstream: 1 }), big, 0.15)).toBeLessThanOrEqual(
      0.15,
    );
    const bigNeg = zeros().map(() => -100);
    expect(
      onlineDelta(features({ same_repo: 1, same_workstream: 1 }), bigNeg, 0.15),
    ).toBeGreaterThanOrEqual(-0.15);
  });
});

describe('onlineRankerEnabled', () => {
  const prior = process.env['SIDETRACK_ONLINE_RANKER'];
  afterEach(() => {
    if (prior === undefined) delete process.env['SIDETRACK_ONLINE_RANKER'];
    else process.env['SIDETRACK_ONLINE_RANKER'] = prior;
  });
  it('is off unless the flag is exactly "1"', () => {
    delete process.env['SIDETRACK_ONLINE_RANKER'];
    expect(onlineRankerEnabled()).toBe(false);
    process.env['SIDETRACK_ONLINE_RANKER'] = '0';
    expect(onlineRankerEnabled()).toBe(false);
    process.env['SIDETRACK_ONLINE_RANKER'] = '1';
    expect(onlineRankerEnabled()).toBe(true);
  });
});

describe('applyOnlineHeadDrainStep', () => {
  let root = '';
  const prior = process.env['SIDETRACK_ONLINE_RANKER'];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sidetrack-online-head-'));
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env['SIDETRACK_ONLINE_RANKER'];
    else process.env['SIDETRACK_ONLINE_RANKER'] = prior;
    await rm(root, { recursive: true, force: true });
  });

  it('is a no-op returning null when the flag is off (no state file written)', async () => {
    delete process.env['SIDETRACK_ONLINE_RANKER'];
    const result = await applyOnlineHeadDrainStep({
      vaultRoot: root,
      events: [flowConfirmed(10, 'visit-a', 'visit-b')],
      snapshot: snapshot(),
      merged: repoMerged(),
      modelRevisionId: 'rev-1',
      nowMs: BASE_TIME,
    });
    expect(result).toBeNull();
    await expect(readFile(onlineRankerStatePath(root), 'utf8')).rejects.toBeTruthy();
  });

  it('applies a pairwise nudge for a flow-confirmed visit↔visit label', async () => {
    process.env['SIDETRACK_ONLINE_RANKER'] = '1';
    const result = await applyOnlineHeadDrainStep({
      vaultRoot: root,
      events: [flowConfirmed(10, 'visit-a', 'visit-b')],
      snapshot: snapshot(),
      merged: repoMerged(),
      modelRevisionId: 'rev-1',
      nowMs: BASE_TIME,
    });
    expect(result).not.toBeNull();
    expect(result?.appliedUpdates).toBe(1);
    expect(result?.state.baseRevisionId).toBe('rev-1');
    // Weights moved off zero.
    expect(result?.state.weights.some((w) => w !== 0)).toBe(true);
    // Persisted.
    const persisted = await readOnlineRankerState(root);
    expect(persisted?.weights).toEqual(result?.state.weights);
  });

  it('is idempotent — re-running the same tail applies nothing new', async () => {
    process.env['SIDETRACK_ONLINE_RANKER'] = '1';
    const events = [flowConfirmed(10, 'visit-a', 'visit-b')];
    const first = await applyOnlineHeadDrainStep({
      vaultRoot: root,
      events,
      snapshot: snapshot(),
      merged: repoMerged(),
      modelRevisionId: 'rev-1',
      nowMs: BASE_TIME,
    });
    const second = await applyOnlineHeadDrainStep({
      vaultRoot: root,
      events,
      snapshot: snapshot(),
      merged: repoMerged(),
      modelRevisionId: 'rev-1',
      nowMs: BASE_TIME + 1,
    });
    expect(second?.appliedUpdates).toBe(0);
    expect(second?.state.weights).toEqual(first?.state.weights);
  });

  it('re-bases on a model swap: zeroes weights, keeps the ledger', async () => {
    process.env['SIDETRACK_ONLINE_RANKER'] = '1';
    // Seed a state based on rev-1 with non-zero weights + an applied key.
    const seeded = {
      ...EMPTY_ONLINE_RANKER_STATE(FEATURE_COUNT),
      baseRevisionId: 'rev-1',
      weights: zeros().map((_, index) => (index === 1 ? 0.5 : 0)) as number[],
      appliedLabelKeys: ['visit-a visit-b positive'],
      updateCount: 1,
    };
    await writeOnlineRankerState(root, seeded);

    // A drain serving rev-2 with no new labels must rebase.
    const result = await applyOnlineHeadDrainStep({
      vaultRoot: root,
      events: [],
      snapshot: snapshot(),
      merged: repoMerged(),
      modelRevisionId: 'rev-2',
      nowMs: BASE_TIME + 5,
    });
    expect(result?.state.baseRevisionId).toBe('rev-2');
    expect(result?.state.weights.every((w) => w === 0)).toBe(true);
    // Ledger preserved so the already-folded label is never re-applied.
    expect(result?.state.appliedLabelKeys).toContain('visit-a visit-b positive');
  });
});
