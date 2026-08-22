import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  TOPIC_INCREMENTAL_REVISION_KEY,
  TOPIC_LEIDEN_CPM_REVISION_KEY,
  TOPIC_UNION_FIND_REVISION_KEY,
  type TopicAlgorithmVersion,
  type TopicRevision,
  type TopicRevisionStore,
} from '../producers/topic-revision.js';
import { createIncrementalTopicStateCarry } from './topicIncrementalStateCarry.js';
import { wrapTopicRevisionStoreForProduction } from './topicProductionRevival.js';

const revision = (
  revisionId: string,
  topics: readonly { readonly topicId: string; readonly members: readonly string[] }[],
  overrides: {
    readonly algorithmVersion?: TopicAlgorithmVersion;
    readonly visitSimilarityRevisionId?: string;
  } = {},
): TopicRevision => ({
  revisionId,
  visitSimilarityRevisionId: overrides.visitSimilarityRevisionId ?? 'sim-rev',
  cosineThreshold: 0.9,
  algorithmVersion: overrides.algorithmVersion ?? TOPIC_LEIDEN_CPM_REVISION_KEY,
  topics: topics.map((topic) => ({
    topicId: topic.topicId,
    memberCanonicalUrls: topic.members,
    metadata: {
      memberCount: topic.members.length,
      representativeTitles: [topic.topicId],
      firstObservedAt: '2026-08-15T10:00:00.000Z',
      lastObservedAt: '2026-08-15T10:00:00.000Z',
      cohesion: 0.9,
    },
  })),
  lineage: [],
  producedAt: Date.parse('2026-08-15T10:00:00.000Z'),
});

/** In-memory TopicRevisionStore stub — enough surface for the wrapper. */
const createMemoryStore = (initial?: {
  readonly active?: TopicRevision;
  readonly candidateShadows?: Record<string, TopicRevision>;
}): TopicRevisionStore & { readonly writes: TopicRevision[]; readonly activePutCount: () => number } => {
  let active: TopicRevision | null = initial?.active ?? null;
  const revisions = new Map<string, TopicRevision>();
  const candidateShadows = new Map<string, TopicRevision>(
    Object.entries(initial?.candidateShadows ?? {}),
  );
  const writes: TopicRevision[] = [];
  let activePuts = 0;

  return {
    writes,
    activePutCount: () => activePuts,
    putRevision: async (rev) => {
      writes.push(rev);
      revisions.set(rev.revisionId, rev);
    },
    putActiveRevision: async (rev) => {
      writes.push(rev);
      revisions.set(rev.revisionId, rev);
      active = rev;
      activePuts += 1;
    },
    putShadowRevision: async () => {
      throw new Error('not used in these tests');
    },
    putCandidateShadowRevision: async (candidate, rev) => {
      writes.push(rev);
      revisions.set(rev.revisionId, rev);
      candidateShadows.set(candidate, rev);
    },
    readShadowRevision: async () => null,
    readCandidateShadowRevision: async (candidate) => candidateShadows.get(candidate) ?? null,
    readRevision: async (id) => revisions.get(id) ?? null,
    readActiveRevision: async () => active,
    listRevisionIds: async () => [...revisions.keys()],
  };
};

describe('wrapTopicRevisionStoreForProduction — collapse guard', () => {
  it('suppresses a leiden-cpm write that wipes a populated active revision to zero topics', async () => {
    const healthy = revision('rev-healthy', [{ topicId: 'topic:a', members: ['u1', 'u2'] }]);
    const inner = createMemoryStore({ active: healthy });
    const logs: string[] = [];
    const wrapped = wrapTopicRevisionStoreForProduction(inner, { log: (line) => logs.push(line) });

    const collapsed = revision('rev-collapsed', [], {
      visitSimilarityRevisionId: 'sim-rev-2',
    });
    await wrapped.putActiveRevision(collapsed);

    // Active pointer never moved — still the healthy revision.
    expect(await inner.readActiveRevision()).toBe(healthy);
    // The collapsed build is still persisted for audit/lineage (putRevision,
    // not putActiveRevision).
    expect(await inner.readRevision('rev-collapsed')).not.toBeNull();
    expect(inner.activePutCount()).toBe(0);
    expect(logs.some((l) => l.startsWith('[topic.collapse-suppressed]'))).toBe(true);
    expect(logs.some((l) => l.startsWith('[topic.cycle] producer=leiden'))).toBe(true);
  });

  it('is stateless — auto-recovers the moment the next build is healthy (no manual reset)', async () => {
    const healthy = revision('rev-healthy', [{ topicId: 'topic:a', members: ['u1', 'u2'] }]);
    const inner = createMemoryStore({ active: healthy });
    const wrapped = wrapTopicRevisionStoreForProduction(inner, { log: () => undefined });

    const collapsed = revision('rev-collapsed', [], { visitSimilarityRevisionId: 'sim-rev-2' });
    await wrapped.putActiveRevision(collapsed);
    expect(await inner.readActiveRevision()).toBe(healthy);

    const recovered = revision('rev-recovered', [{ topicId: 'topic:a', members: ['u1', 'u2', 'u3'] }], {
      visitSimilarityRevisionId: 'sim-rev-3',
    });
    await wrapped.putActiveRevision(recovered);
    expect(await inner.readActiveRevision()).toBe(recovered);
    expect(inner.activePutCount()).toBe(1);
  });

  it('does not suppress a legitimate zero-to-zero (no previous revision, fresh vault)', async () => {
    const inner = createMemoryStore();
    const wrapped = wrapTopicRevisionStoreForProduction(inner, { log: () => undefined });
    const empty = revision('rev-empty', []);
    await wrapped.putActiveRevision(empty);
    expect(await inner.readActiveRevision()).toBe(empty);
    expect(inner.activePutCount()).toBe(1);
  });

  it('does not suppress a legitimate zero-to-zero (previous revision already empty)', async () => {
    const alreadyEmpty = revision('rev-already-empty', []);
    const inner = createMemoryStore({ active: alreadyEmpty });
    const wrapped = wrapTopicRevisionStoreForProduction(inner, { log: () => undefined });
    const stillEmpty = revision('rev-still-empty', [], { visitSimilarityRevisionId: 'sim-2' });
    await wrapped.putActiveRevision(stillEmpty);
    expect(await inner.readActiveRevision()).toBe(stillEmpty);
    expect(inner.activePutCount()).toBe(1);
  });

  it('passes a healthy N->M leiden-cpm update straight through', async () => {
    const before = revision('rev-1', [{ topicId: 'topic:a', members: ['u1', 'u2'] }]);
    const inner = createMemoryStore({ active: before });
    const wrapped = wrapTopicRevisionStoreForProduction(inner, { log: () => undefined });
    const after = revision('rev-2', [{ topicId: 'topic:a', members: ['u1', 'u2', 'u3'] }], {
      visitSimilarityRevisionId: 'sim-2',
    });
    await wrapped.putActiveRevision(after);
    expect(await inner.readActiveRevision()).toBe(after);
  });

  it('leaves non-leiden-cpm active writes (e.g. union-find) completely untouched', async () => {
    const healthy = revision('rev-healthy', [{ topicId: 'topic:a', members: ['u1'] }], {
      algorithmVersion: TOPIC_UNION_FIND_REVISION_KEY,
    });
    const inner = createMemoryStore({ active: healthy });
    const logs: string[] = [];
    const wrapped = wrapTopicRevisionStoreForProduction(inner, { log: (line) => logs.push(line) });

    const collapsedUnionFind = revision('rev-collapsed-uf', [], {
      algorithmVersion: TOPIC_UNION_FIND_REVISION_KEY,
      visitSimilarityRevisionId: 'sim-2',
    });
    await wrapped.putActiveRevision(collapsedUnionFind);

    // No guard for non-leiden-cpm producers — passes straight through,
    // matching the pre-existing (non-served-by-default) behavior.
    expect(await inner.readActiveRevision()).toBe(collapsedUnionFind);
    expect(logs.length).toBe(0);
  });
});

describe('wrapTopicRevisionStoreForProduction — parity/cycle marks', () => {
  it('emits a [topic.cycle] mark for the incremental candidate-shadow slot', async () => {
    const inner = createMemoryStore();
    const logs: string[] = [];
    const wrapped = wrapTopicRevisionStoreForProduction(inner, { log: (line) => logs.push(line) });

    const shadowRev = revision('rev-shadow-1', [{ topicId: 'topic:a', members: ['u1', 'u2'] }], {
      algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
    });
    await wrapped.putCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY, shadowRev);

    const mark = logs.find((l) => l.startsWith('[topic.cycle]'));
    expect(mark).toBeDefined();
    expect(mark).toContain('producer=incremental');
    expect(mark).toContain('topics=1');
    expect(mark).toContain('members=2');
    expect(await inner.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY)).toBe(shadowRev);
  });

  it('does not emit a cycle mark for unrelated candidate-shadow slots (e.g. the leiden candidate)', async () => {
    const inner = createMemoryStore();
    const logs: string[] = [];
    const wrapped = wrapTopicRevisionStoreForProduction(inner, { log: (line) => logs.push(line) });

    const leidenCandidate = revision('rev-leiden-candidate', [
      { topicId: 'topic:a', members: ['u1'] },
    ]);
    await wrapped.putCandidateShadowRevision(TOPIC_LEIDEN_CPM_REVISION_KEY, leidenCandidate);
    expect(logs.length).toBe(0);
  });

  it('reports churn between successive incremental shadow cycles', async () => {
    const inner = createMemoryStore();
    const logs: string[] = [];
    const wrapped = wrapTopicRevisionStoreForProduction(inner, { log: (line) => logs.push(line) });

    // buildServedTopicProducerReport requires >=5 shared pages before it
    // reports a churn number instead of null — use 6 to clear that floor.
    const members1 = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];
    const first = revision('rev-1', [{ topicId: 'topic:a', members: members1 }], {
      algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
    });
    await wrapped.putCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY, first);

    const second = revision(
      'rev-2',
      [
        { topicId: 'topic:a', members: ['u1', 'u2', 'u3'] },
        { topicId: 'topic:b', members: ['u4', 'u5', 'u6'] },
      ],
      { algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY, visitSimilarityRevisionId: 'sim-2' },
    );
    await wrapped.putCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY, second);

    const marks = logs.filter((l) => l.startsWith('[topic.cycle] producer=incremental'));
    expect(marks.length).toBe(2);
    // The second mark should report a non-trivial churn value (the topic
    // split changed co-membership for every shared page), not 'n/a'.
    expect(marks[1]).not.toContain('churn=p50:n/a,p90:n/a');
  });
});

describe('wrapTopicRevisionStoreForProduction — incremental state carry', () => {
  const withVault = async (
    run: (vaultRoot: string) => Promise<void>,
  ): Promise<void> => {
    const vaultRoot = await mkdtemp(join(tmpdir(), 'sidetrack-revival-carry-'));
    try {
      await run(vaultRoot);
    } finally {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  };

  const wrap = (
    inner: TopicRevisionStore,
    vaultRoot: string,
    logs: string[],
  ): TopicRevisionStore => {
    const log = (line: string): void => {
      logs.push(line);
    };
    return wrapTopicRevisionStoreForProduction(inner, {
      log,
      stateCarry: createIncrementalTopicStateCarry(vaultRoot, { log }),
    });
  };

  it('treats an EMPTY legacy incremental slot as absent and seeds from the populated active revision (kills the sticky-empty trap)', async () => {
    await withVault(async (vaultRoot) => {
      const activeLeiden = revision('rev-active', [
        { topicId: 'topic:a', members: ['u1', 'u2', 'u3'] },
      ]);
      const emptySlot = revision('rev-empty-slot', [], {
        algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
      });
      const inner = createMemoryStore({
        active: activeLeiden,
        candidateShadows: { [TOPIC_INCREMENTAL_REVISION_KEY]: emptySlot },
      });
      const logs: string[] = [];
      const wrapped = wrap(inner, vaultRoot, logs);

      const prior = await wrapped.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY);
      // NOT the sticky empty slot — the populated served revision.
      expect(prior).toBe(activeLeiden);
      expect(logs.some((l) => l.includes('seed base=active-leiden'))).toBe(true);
    });
  });

  it('prefers a POPULATED legacy slot over the active revision when no carried state exists', async () => {
    await withVault(async (vaultRoot) => {
      const activeLeiden = revision('rev-active', [{ topicId: 'topic:a', members: ['u1'] }]);
      const populatedSlot = revision(
        'rev-slot',
        [{ topicId: 'topic:b', members: ['u2', 'u3'] }],
        { algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY },
      );
      const inner = createMemoryStore({
        active: activeLeiden,
        candidateShadows: { [TOPIC_INCREMENTAL_REVISION_KEY]: populatedSlot },
      });
      const logs: string[] = [];
      const wrapped = wrap(inner, vaultRoot, logs);
      expect(await wrapped.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY)).toBe(
        populatedSlot,
      );
      expect(logs.some((l) => l.includes('seed base=legacy-slot'))).toBe(true);
    });
  });

  it('adopts the first populated write, then serves the carried state on subsequent reads with the extended mark fields', async () => {
    await withVault(async (vaultRoot) => {
      const activeLeiden = revision('rev-active', [
        { topicId: 'topic:a', members: ['u1', 'u2', 'u3'] },
      ]);
      const inner = createMemoryStore({ active: activeLeiden });
      const logs: string[] = [];
      const wrapped = wrap(inner, vaultRoot, logs);

      // Cycle 1: read (seed) then write a populated incremental build.
      await wrapped.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY);
      const built = revision('rev-inc-1', [{ topicId: 'topic:a', members: ['u1', 'u2', 'u3'] }], {
        algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
      });
      await wrapped.putCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY, built);

      const adoptMark = logs.find((l) => l.startsWith('[topic.cycle] producer=incremental'));
      expect(adoptMark).toContain('carried=false');
      expect(adoptMark).toContain('action=adopt');
      expect(adoptMark).toContain('collapse-suspect=false');
      // Coverage reached the active revision (3/3) ⇒ not partial.
      expect(adoptMark).toContain('partial=false');
      // Legacy slot mirrored for raw readers.
      expect(
        await inner.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY),
      ).toBe(built);

      // Cycle 2: the carried state is the prior now.
      const prior = await wrapped.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY);
      expect(prior?.revisionId).toBe('rev-inc-1');
      expect(prior?.topics.length).toBe(1);
    });
  });

  it('collapse-suspect: an empty incremental build over a carried prior keeps the slot and state, audibly', async () => {
    await withVault(async (vaultRoot) => {
      const activeLeiden = revision('rev-active', [{ topicId: 'topic:a', members: ['u1', 'u2'] }]);
      const inner = createMemoryStore({ active: activeLeiden });
      const logs: string[] = [];
      const wrapped = wrap(inner, vaultRoot, logs);

      const built = revision('rev-inc-1', [{ topicId: 'topic:a', members: ['u1', 'u2'] }], {
        algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
      });
      await wrapped.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY);
      await wrapped.putCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY, built);

      const empty = revision('rev-inc-empty', [], {
        algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
        visitSimilarityRevisionId: 'sim-2',
      });
      await wrapped.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY);
      await wrapped.putCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY, empty);

      const marks = logs.filter((l) => l.startsWith('[topic.cycle] producer=incremental'));
      expect(marks[1]).toContain('collapse-suspect=true');
      expect(marks[1]).toContain('carried=true');
      expect(marks[1]).toContain('priorTopics=1');
      // The slot still holds the populated build (never empty-over-populated).
      expect(
        (await inner.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY))?.revisionId,
      ).toBe('rev-inc-1');
      // The empty build is persisted for audit only.
      expect(await inner.readRevision('rev-inc-empty')).not.toBeNull();
      // And the carried read still serves the populated prior.
      const carried = await wrapped.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY);
      expect(carried?.topics.length).toBe(1);
    });
  });

  it('change-gate: identical membership under a new revisionId skips the slot write but advances the carried revisionId (skip-gate continuity)', async () => {
    await withVault(async (vaultRoot) => {
      const activeLeiden = revision('rev-active', [{ topicId: 'topic:a', members: ['u1', 'u2'] }]);
      const inner = createMemoryStore({ active: activeLeiden });
      const logs: string[] = [];
      const wrapped = wrap(inner, vaultRoot, logs);

      const built = revision('rev-inc-1', [{ topicId: 'topic:a', members: ['u1', 'u2'] }], {
        algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
      });
      await wrapped.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY);
      await wrapped.putCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY, built);
      const writesAfterAdopt = inner.writes.length;

      const sameContent = revision(
        'rev-inc-2',
        [{ topicId: 'topic:a', members: ['u1', 'u2'] }],
        { algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY, visitSimilarityRevisionId: 'sim-2' },
      );
      await wrapped.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY);
      await wrapped.putCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY, sameContent);

      // No inner writes at all for the unchanged-content cycle.
      expect(inner.writes.length).toBe(writesAfterAdopt);
      const marks = logs.filter((l) => l.startsWith('[topic.cycle] producer=incremental'));
      expect(marks[1]).toContain('action=cursor-only');
      expect(marks[1]).toContain('delta=0');

      // But the carried read serves the ADVANCED revisionId, so the
      // materializer's skip-gate can cache-hit next drain.
      const carried = await wrapped.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY);
      expect(carried?.revisionId).toBe('rev-inc-2');
    });
  });

  it('carries state across wrapper instances via disk (fork-per-drain shape)', async () => {
    await withVault(async (vaultRoot) => {
      const activeLeiden = revision('rev-active', [{ topicId: 'topic:a', members: ['u1', 'u2'] }]);
      const built = revision('rev-inc-1', [{ topicId: 'topic:a', members: ['u1', 'u2'] }], {
        algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
      });
      {
        const inner = createMemoryStore({ active: activeLeiden });
        const logs: string[] = [];
        const wrapped = wrap(inner, vaultRoot, logs);
        await wrapped.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY);
        await wrapped.putCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY, built);
      }
      // A NEW wrapper + NEW inner store (the child process shape): the
      // carried prior comes from the state artifact, not process memory.
      const inner2 = createMemoryStore({ active: activeLeiden });
      const logs2: string[] = [];
      const wrapped2 = wrap(inner2, vaultRoot, logs2);
      const carried = await wrapped2.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY);
      expect(carried).not.toBeNull();
      expect(carried!.revisionId).toBe('rev-inc-1');
      expect(logs2.some((l) => l.startsWith('[topic.state] loaded'))).toBe(true);
    });
  });

  it('never seeds from a non-leiden active revision (foreign producer clustering is not a refinement base)', async () => {
    await withVault(async (vaultRoot) => {
      const activeUnionFind = revision('rev-active-uf', [{ topicId: 'topic:a', members: ['u1'] }], {
        algorithmVersion: TOPIC_UNION_FIND_REVISION_KEY,
      });
      const inner = createMemoryStore({ active: activeUnionFind });
      const logs: string[] = [];
      const wrapped = wrap(inner, vaultRoot, logs);
      expect(await wrapped.readCandidateShadowRevision(TOPIC_INCREMENTAL_REVISION_KEY)).toBeNull();
    });
  });
});
