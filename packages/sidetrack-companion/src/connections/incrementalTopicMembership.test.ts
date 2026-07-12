import { describe, expect, it } from 'vitest';

import { assignIncrementalMembership } from './incrementalTopicMembership.js';
import type { VisitSimilarityEdge } from './topicClusterer.js';
import type { LoadedSimilarityHnswStore } from './visitSimilarityHnsw.js';
import {
  TOPIC_LEIDEN_CPM_REVISION_KEY,
  parseTopicRevision,
  type TopicRevision,
  type TopicRevisionTopic,
} from '../producers/topic-revision.js';

const topic = (
  topicId: string,
  members: readonly string[],
  secondary: TopicRevisionTopic['secondaryAffiliations'] = [],
): TopicRevisionTopic => ({
  topicId,
  memberCanonicalUrls: [...members],
  metadata: {
    memberCount: members.length,
    representativeTitles: [],
    firstObservedAt: '2026-06-01T00:00:00.000Z',
    lastObservedAt: '2026-06-01T00:00:00.000Z',
    cohesion: 0.9,
  },
  ...(secondary === undefined ? {} : { secondaryAffiliations: secondary }),
});

const revision = (topics: readonly TopicRevisionTopic[]): TopicRevision => ({
  revisionId: 'rev-base',
  visitSimilarityRevisionId: 'sim-1',
  cosineThreshold: 0.9,
  algorithmVersion: TOPIC_LEIDEN_CPM_REVISION_KEY,
  topics: [...topics],
  lineage: [],
  producedAt: 1,
});

const edge = (from: string, to: string, cosine: number): VisitSimilarityEdge => ({
  fromVisitKey: from,
  toVisitKey: to,
  cosine,
});

const stubHnsw = (
  vectors: Readonly<Record<string, ReadonlyArray<{ neighborVisitId: string; distance: number }>>>,
): LoadedSimilarityHnswStore => ({
  elementCount: () => Object.keys(vectors).length,
  knownLabels: async () => new Set(Object.keys(vectors)),
  recoveredFromCorruption: () => false,
  insertOrUpdate: async () => undefined,
  delete: async () => undefined,
  embedding: async () => null,
  queryTopK: async (visitId, k) => (vectors[visitId] ?? []).slice(0, k),
  persist: async () => undefined,
  close: async () => undefined,
});

describe('assignIncrementalMembership', () => {
  it('places a candidate into its neighbour cluster via an edge (tier A)', async () => {
    const base = revision([topic('topic:A', ['a1', 'a2']), topic('topic:B', ['b1'])]);
    const out = await assignIncrementalMembership({
      baseRevision: base,
      candidateCanonicalUrls: ['v'],
      edges: [edge('v', 'a1', 0.95)],
      hnswStore: null,
      cosineThreshold: 0.9,
    });
    const a = out.topics.find((t) => t.topicId === 'topic:A');
    expect(a?.memberCanonicalUrls).toEqual(['a1', 'a2']); // primary membership untouched
    expect(a?.metadata.memberCount).toBe(2);
    expect(a?.secondaryAffiliations?.map((s) => s.canonicalUrl)).toEqual(['v']);
    expect(a?.secondaryAffiliations?.[0]?.reasons).toEqual(['edge_support']);
    expect(out.revisionId).toBe(`rev-base:inc:${out.revisionId.split(':inc:')[1] ?? ''}`);
    expect(out.revisionId).not.toBe('rev-base');
  });

  it('does not place a below-threshold edge and returns the base by identity', async () => {
    const base = revision([topic('topic:A', ['a1'])]);
    const out = await assignIncrementalMembership({
      baseRevision: base,
      candidateCanonicalUrls: ['v'],
      edges: [edge('v', 'a1', 0.87)],
      hnswStore: null,
      cosineThreshold: 0.9,
    });
    expect(out).toBe(base); // identity preserved → scoped-delta fast path stays alive
  });

  it('places via the HNSW vector fallback when there is no edge (tier B)', async () => {
    const base = revision([topic('topic:A', ['a1'])]);
    const out = await assignIncrementalMembership({
      baseRevision: base,
      candidateCanonicalUrls: ['v'],
      edges: [],
      hnswStore: stubHnsw({ v: [{ neighborVisitId: 'a1', distance: 0.05 }] }),
      cosineThreshold: 0.9,
    });
    const a = out.topics.find((t) => t.topicId === 'topic:A');
    expect(a?.secondaryAffiliations?.map((s) => s.canonicalUrl)).toEqual(['v']);
    expect(a?.secondaryAffiliations?.[0]?.reasons).toEqual(['member_similarity']);
  });

  it('skips a candidate with no edge and no vector (engagement-gate no-op)', async () => {
    const base = revision([topic('topic:A', ['a1'])]);
    const out = await assignIncrementalMembership({
      baseRevision: base,
      candidateCanonicalUrls: ['v'],
      edges: [],
      hnswStore: stubHnsw({}),
      cosineThreshold: 0.9,
    });
    expect(out).toBe(base);
  });

  it('picks the higher summed-cosine cluster, tie-breaking on smallest topicId', async () => {
    const base = revision([topic('topic:B', ['b1', 'b2']), topic('topic:A', ['a1'])]);
    // Two 0.95 edges into B vs one 0.95 edge into A → B wins on sum.
    const sumWins = await assignIncrementalMembership({
      baseRevision: base,
      candidateCanonicalUrls: ['v'],
      edges: [edge('v', 'b1', 0.95), edge('v', 'b2', 0.95), edge('v', 'a1', 0.95)],
      hnswStore: null,
      cosineThreshold: 0.9,
    });
    expect(sumWins.topics.find((t) => t.topicId === 'topic:B')?.secondaryAffiliations).toHaveLength(1);
    expect(sumWins.topics.find((t) => t.topicId === 'topic:A')?.secondaryAffiliations ?? []).toHaveLength(0);
    // Equal sums (one edge each) → lexicographically-smallest topicId 'topic:A'.
    const tie = await assignIncrementalMembership({
      baseRevision: base,
      candidateCanonicalUrls: ['v'],
      edges: [edge('v', 'b1', 0.95), edge('v', 'a1', 0.95)],
      hnswStore: null,
      cosineThreshold: 0.9,
    });
    expect(tie.topics.find((t) => t.topicId === 'topic:A')?.secondaryAffiliations).toHaveLength(1);
  });

  it('returns the base by identity when there are no candidates', async () => {
    const base = revision([topic('topic:A', ['a1'])]);
    const out = await assignIncrementalMembership({
      baseRevision: base,
      candidateCanonicalUrls: [],
      edges: [edge('v', 'a1', 0.95)],
      hnswStore: null,
      cosineThreshold: 0.9,
    });
    expect(out).toBe(base);
  });

  it('is replay-stable: identical inputs produce a byte-identical revision', async () => {
    const base = revision([topic('topic:A', ['a1']), topic('topic:B', ['b1'])]);
    const params = {
      baseRevision: base,
      candidateCanonicalUrls: ['v1', 'v2'],
      edges: [edge('v1', 'a1', 0.95), edge('v2', 'b1', 0.93)],
      hnswStore: null,
      cosineThreshold: 0.9,
    } as const;
    const a = await assignIncrementalMembership(params);
    const b = await assignIncrementalMembership(params);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not re-add a node that is already a member or secondary', async () => {
    const base = revision([
      topic('topic:A', ['a1'], [
        {
          canonicalUrl: 'sec1',
          score: 0.9,
          reasons: ['member_similarity'],
          supportCount: 1,
          maxCosine: 0.9,
          lexicalScore: 0,
          reciprocalSupport: 0,
        },
      ]),
    ]);
    const out = await assignIncrementalMembership({
      baseRevision: base,
      candidateCanonicalUrls: ['a1', 'sec1'], // both already placed
      edges: [edge('a1', 'a1', 0.95), edge('sec1', 'a1', 0.95)],
      hnswStore: null,
      cosineThreshold: 0.9,
    });
    expect(out).toBe(base);
  });

  it('round-trips through parseTopicRevision (persisted-reload safety)', async () => {
    const base = revision([topic('topic:A', ['a1'])]);
    const out = await assignIncrementalMembership({
      baseRevision: base,
      candidateCanonicalUrls: ['v'],
      edges: [edge('v', 'a1', 0.95)],
      hnswStore: null,
      cosineThreshold: 0.9,
    });
    const reparsed = parseTopicRevision(JSON.parse(JSON.stringify(out)));
    expect(reparsed).not.toBeNull();
    expect(reparsed).toEqual(out);
  });
});
