import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TOPIC_INCREMENTAL_REVISION_KEY,
  type TopicRevision,
} from '../producers/topic-revision.js';
import {
  computeMembershipDelta,
  computeTopicMembershipFingerprint,
  createIncrementalTopicStateCarry,
  incrementalTopicStateCursorPath,
  incrementalTopicStatePath,
} from './topicIncrementalStateCarry.js';

const revision = (
  revisionId: string,
  topics: readonly {
    readonly topicId: string;
    readonly members: readonly string[];
    readonly secondaries?: readonly string[];
  }[],
  overrides: {
    readonly visitSimilarityRevisionId?: string;
    readonly producedAt?: number;
    readonly lineageObservedAt?: string;
  } = {},
): TopicRevision => ({
  revisionId,
  visitSimilarityRevisionId: overrides.visitSimilarityRevisionId ?? 'sim-rev',
  cosineThreshold: 0.9,
  algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
  topics: topics.map((topic) => ({
    topicId: topic.topicId,
    memberCanonicalUrls: topic.members,
    metadata: {
      memberCount: topic.members.length,
      representativeTitles: [topic.topicId],
      firstObservedAt: '2026-08-15T10:00:00.000Z',
      lastObservedAt: overrides.lineageObservedAt ?? '2026-08-15T10:00:00.000Z',
      cohesion: 0.9,
    },
    ...(topic.secondaries === undefined
      ? {}
      : {
          secondaryAffiliations: topic.secondaries.map((canonicalUrl) => ({
            canonicalUrl,
            score: 0.9,
            reasons: ['edge_support' as const],
            supportCount: 1,
            maxCosine: 0.9,
            lexicalScore: 0,
            reciprocalSupport: 0,
          })),
        }),
  })),
  lineage:
    topics.length === 0
      ? []
      : [
          {
            fromTopicId: topics[0]!.topicId,
            toTopicId: topics[0]!.topicId,
            kind: 'continue' as const,
            observedAt: overrides.lineageObservedAt ?? '2026-08-15T10:00:00.000Z',
          },
        ],
  producedAt: overrides.producedAt ?? Date.parse('2026-08-15T10:00:00.000Z'),
});

describe('computeTopicMembershipFingerprint', () => {
  it('ignores volatile fields — revision ids, producedAt, lineage timestamps, metadata timestamps', async () => {
    const a = revision('rev-1', [{ topicId: 't:a', members: ['u1', 'u2'] }]);
    const b = revision('rev-2', [{ topicId: 't:a', members: ['u2', 'u1'] }], {
      visitSimilarityRevisionId: 'sim-rev-OTHER',
      producedAt: Date.parse('2026-08-22T09:00:00.000Z'),
      lineageObservedAt: '2026-08-22T09:00:00.000Z',
    });
    expect(await computeTopicMembershipFingerprint(a)).toBe(
      await computeTopicMembershipFingerprint(b),
    );
  });

  it('changes when primary membership changes', async () => {
    const a = revision('rev-1', [{ topicId: 't:a', members: ['u1', 'u2'] }]);
    const b = revision('rev-1', [{ topicId: 't:a', members: ['u1', 'u2', 'u3'] }]);
    expect(await computeTopicMembershipFingerprint(a)).not.toBe(
      await computeTopicMembershipFingerprint(b),
    );
  });

  it('changes when secondary affiliations change', async () => {
    const a = revision('rev-1', [{ topicId: 't:a', members: ['u1'] }]);
    const b = revision('rev-1', [{ topicId: 't:a', members: ['u1'], secondaries: ['u9'] }]);
    expect(await computeTopicMembershipFingerprint(a)).not.toBe(
      await computeTopicMembershipFingerprint(b),
    );
  });
});

describe('computeMembershipDelta', () => {
  it('counts added, removed, and moved placements once each', () => {
    const prior = revision('rev-1', [
      { topicId: 't:a', members: ['u1', 'u2'] },
      { topicId: 't:b', members: ['u3'] },
    ]);
    const incoming = revision('rev-2', [
      { topicId: 't:a', members: ['u1', 'u3'] }, // u3 moved, u2 removed
      { topicId: 't:c', members: ['u4'] }, // u4 added
    ]);
    // u2 removed (1) + u3 moved (1) + u4 added (1)
    expect(computeMembershipDelta(prior, incoming)).toBe(3);
  });

  it('treats a null prior as all-added', () => {
    const incoming = revision('rev-1', [{ topicId: 't:a', members: ['u1', 'u2'] }]);
    expect(computeMembershipDelta(null, incoming)).toBe(2);
  });
});

describe('createIncrementalTopicStateCarry', () => {
  let vaultRoot: string;
  let logs: string[];

  beforeEach(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-topic-state-carry-'));
    logs = [];
  });

  afterEach(async () => {
    await rm(vaultRoot, { recursive: true, force: true });
  });

  const carry = () =>
    createIncrementalTopicStateCarry(vaultRoot, { log: (line) => logs.push(line) });

  const active = revision('rev-active', [
    { topicId: 't:a', members: ['u1', 'u2'] },
    { topicId: 't:b', members: ['u3', 'u4', 'u5'] },
  ]);

  it('adopts the first populated result as a partial state with an audible mark', async () => {
    const c = carry();
    expect(await c.readCarriedRevision()).toBeNull();

    const first = revision('rev-1', [{ topicId: 't:a', members: ['u1', 'u2'] }]);
    const decision = await c.recordCycleResult(first, {
      activeRevision: active,
      seedSource: 'active-leiden',
    });
    expect(decision.action).toBe('adopt');
    expect(decision.carried).toBe(false);
    expect(decision.membershipDelta).toBe(2);
    // 2 members < 5 active members ⇒ still partial.
    expect(decision.partial).toBe(true);
    expect(decision.stateWritten).toBe(true);
    expect(logs.some((l) => l.startsWith('[topic.state] adopted'))).toBe(true);

    const onDisk = JSON.parse(
      await readFile(incrementalTopicStatePath(vaultRoot), 'utf8'),
    ) as Record<string, unknown>;
    expect(onDisk['schemaVersion']).toBe(1);
    expect(onDisk['partial']).toBe(true);
    expect(onDisk['seededFrom']).toBe('active-leiden');
  });

  it('flips partial=false once coverage reaches the active revision', async () => {
    const c = carry();
    const full = revision('rev-1', [
      { topicId: 't:a', members: ['u1', 'u2'] },
      { topicId: 't:b', members: ['u3', 'u4', 'u5'] },
    ]);
    const decision = await c.recordCycleResult(full, {
      activeRevision: active,
      seedSource: 'active-leiden',
    });
    expect(decision.partial).toBe(false);
  });

  it('change-gates: identical membership with a new revisionId writes ONLY the cursor', async () => {
    const c = carry();
    const first = revision('rev-1', [{ topicId: 't:a', members: ['u1', 'u2'] }]);
    await c.recordCycleResult(first, { activeRevision: active, seedSource: 'active-leiden' });
    const stateBytes = await readFile(incrementalTopicStatePath(vaultRoot), 'utf8');

    const sameContent = revision('rev-2', [{ topicId: 't:a', members: ['u2', 'u1'] }], {
      visitSimilarityRevisionId: 'sim-rev-2',
      producedAt: Date.parse('2026-08-22T09:00:00.000Z'),
      lineageObservedAt: '2026-08-22T09:00:00.000Z',
    });
    const decision = await c.recordCycleResult(sameContent, {
      activeRevision: active,
      seedSource: 'state',
    });
    expect(decision.action).toBe('cursor-only');
    expect(decision.stateWritten).toBe(false);
    expect(decision.cursorWritten).toBe(true);
    expect(decision.membershipDelta).toBe(0);
    // The heavy state file is byte-identical — no rewrite.
    expect(await readFile(incrementalTopicStatePath(vaultRoot), 'utf8')).toBe(stateBytes);
    // The cursor carries the new ids.
    const cursor = JSON.parse(
      await readFile(incrementalTopicStateCursorPath(vaultRoot), 'utf8'),
    ) as Record<string, unknown>;
    expect(cursor['revisionId']).toBe('rev-2');
    expect(logs.some((l) => l.startsWith('[topic.state] cursor'))).toBe(true);

    // The carried read serves the cursor-patched ids over the same content.
    const carried = await c.readCarriedRevision();
    expect(carried?.revisionId).toBe('rev-2');
    expect(carried?.visitSimilarityRevisionId).toBe('sim-rev-2');
    expect(carried?.topics.length).toBe(1);
  });

  it('does not rewrite the cursor when even the revisionId is unchanged', async () => {
    const c = carry();
    const first = revision('rev-1', [{ topicId: 't:a', members: ['u1', 'u2'] }]);
    await c.recordCycleResult(first, { activeRevision: active, seedSource: 'active-leiden' });
    const decision = await c.recordCycleResult(first, {
      activeRevision: active,
      seedSource: 'state',
    });
    expect(decision.action).toBe('cursor-only');
    expect(decision.cursorWritten).toBe(false);
  });

  it('updates state on membership change and reports the delta', async () => {
    const c = carry();
    const first = revision('rev-1', [{ topicId: 't:a', members: ['u1', 'u2'] }]);
    await c.recordCycleResult(first, { activeRevision: active, seedSource: 'active-leiden' });

    const grown = revision('rev-2', [{ topicId: 't:a2', members: ['u1', 'u2', 'u3'] }], {
      visitSimilarityRevisionId: 'sim-rev-2',
    });
    const decision = await c.recordCycleResult(grown, {
      activeRevision: active,
      seedSource: 'state',
    });
    expect(decision.action).toBe('update');
    expect(decision.carried).toBe(true);
    expect(decision.priorTopicCount).toBe(1);
    expect(decision.priorMemberCount).toBe(2);
    // u1+u2 moved to t:a2 (2) + u3 added (1).
    expect(decision.membershipDelta).toBe(3);
    expect(decision.stateWritten).toBe(true);
    expect(logs.some((l) => l.startsWith('[topic.state] wrote'))).toBe(true);
  });

  it('collapse-suspect: an empty result over a populated prior is never persisted', async () => {
    const c = carry();
    const first = revision('rev-1', [{ topicId: 't:a', members: ['u1', 'u2'] }]);
    await c.recordCycleResult(first, { activeRevision: active, seedSource: 'active-leiden' });
    const stateBytes = await readFile(incrementalTopicStatePath(vaultRoot), 'utf8');

    const empty = revision('rev-empty', [], { visitSimilarityRevisionId: 'sim-rev-2' });
    const decision = await c.recordCycleResult(empty, {
      activeRevision: active,
      seedSource: 'state',
    });
    expect(decision.action).toBe('collapse-suspect');
    expect(decision.carried).toBe(true);
    expect(decision.priorTopicCount).toBe(1);
    expect(decision.stateWritten).toBe(false);
    expect(await readFile(incrementalTopicStatePath(vaultRoot), 'utf8')).toBe(stateBytes);
    // The carried prior survives for the next cycle.
    expect((await c.readCarriedRevision())?.topics.length).toBe(1);
  });

  it('observe-empty: empty over no prior stays silent on disk (fresh vault)', async () => {
    const c = carry();
    const empty = revision('rev-empty', []);
    const decision = await c.recordCycleResult(empty, {
      activeRevision: null,
      seedSource: 'none',
    });
    expect(decision.action).toBe('observe-empty');
    await expect(readFile(incrementalTopicStatePath(vaultRoot), 'utf8')).rejects.toThrow();
  });

  it('survives a process restart — a fresh carry instance loads the state + cursor from disk', async () => {
    const first = revision('rev-1', [{ topicId: 't:a', members: ['u1', 'u2'] }]);
    const sameContent = revision('rev-2', [{ topicId: 't:a', members: ['u1', 'u2'] }], {
      visitSimilarityRevisionId: 'sim-rev-2',
      producedAt: Date.parse('2026-08-22T09:00:00.000Z'),
    });
    {
      const c = carry();
      await c.recordCycleResult(first, { activeRevision: active, seedSource: 'active-leiden' });
      await c.recordCycleResult(sameContent, { activeRevision: active, seedSource: 'state' });
    }
    const fresh = carry();
    const carried = await fresh.readCarriedRevision();
    expect(carried).not.toBeNull();
    expect(carried!.topics.length).toBe(1);
    // Cursor-patched revisionId survives the restart (skip-gate continuity).
    expect(carried!.revisionId).toBe('rev-2');
    expect(logs.some((l) => l.startsWith('[topic.state] loaded'))).toBe(true);
  });

  it('ignores a state file with a foreign schemaVersion (audible, treated as absent)', async () => {
    const c1 = carry();
    const first = revision('rev-1', [{ topicId: 't:a', members: ['u1'] }]);
    await c1.recordCycleResult(first, { activeRevision: active, seedSource: 'active-leiden' });

    const raw = JSON.parse(
      await readFile(incrementalTopicStatePath(vaultRoot), 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(
      incrementalTopicStatePath(vaultRoot),
      JSON.stringify({ ...raw, schemaVersion: 999 }),
      'utf8',
    );

    const c2 = carry();
    expect(await c2.readCarriedRevision()).toBeNull();
    expect(logs.some((l) => l.includes('schemaVersion'))).toBe(true);
  });

  it('treats a hand-broken EMPTY state file as absent (sticky-empty can never return)', async () => {
    const empty = revision('rev-empty', []);
    const c1 = carry();
    const first = revision('rev-1', [{ topicId: 't:a', members: ['u1'] }]);
    await c1.recordCycleResult(first, { activeRevision: active, seedSource: 'active-leiden' });
    const raw = JSON.parse(
      await readFile(incrementalTopicStatePath(vaultRoot), 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(
      incrementalTopicStatePath(vaultRoot),
      JSON.stringify({ ...raw, revision: empty }),
      'utf8',
    );
    const c2 = carry();
    expect(await c2.readCarriedRevision()).toBeNull();
    expect(logs.some((l) => l.includes('empty topic set'))).toBe(true);
  });

  it('ignores a stale cursor whose contentHash no longer matches the state', async () => {
    const c1 = carry();
    const first = revision('rev-1', [{ topicId: 't:a', members: ['u1', 'u2'] }]);
    await c1.recordCycleResult(first, { activeRevision: active, seedSource: 'active-leiden' });
    await writeFile(
      incrementalTopicStateCursorPath(vaultRoot),
      JSON.stringify({
        schemaVersion: 1,
        contentHash: 'not-the-right-hash',
        revisionId: 'rev-bogus',
        visitSimilarityRevisionId: 'sim-bogus',
        producedAt: Date.parse('2026-08-23T00:00:00.000Z'),
      }),
      'utf8',
    );
    const c2 = carry();
    const carried = await c2.readCarriedRevision();
    expect(carried!.revisionId).toBe('rev-1');
  });
});
