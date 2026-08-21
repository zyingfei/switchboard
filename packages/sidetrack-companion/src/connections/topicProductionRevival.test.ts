import { describe, expect, it } from 'vitest';

import {
  TOPIC_INCREMENTAL_REVISION_KEY,
  TOPIC_LEIDEN_CPM_REVISION_KEY,
  TOPIC_UNION_FIND_REVISION_KEY,
  type TopicAlgorithmVersion,
  type TopicRevision,
  type TopicRevisionStore,
} from '../producers/topic-revision.js';
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
