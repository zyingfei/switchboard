// W5 Phase A — acceptance tests for the incremental topic-revision
// builder: equivalence with a full leiden-cpm rebuild on the affected
// region (unaffected topics carried over byte-identical), split/merge
// lineage out of local refinement, the subgraph-cap overflow path, the
// primary-promotion rule in isolation, and determinism.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TOPIC_PROMOTE_MARGIN,
  DEFAULT_TOPIC_PROMOTE_SUPPORT,
  buildIncrementalTopicRevision,
  resolveTopicPromoteMargin,
  resolveTopicPromoteSupport,
  resolveTopicSubgraphCap,
  type BuildIncrementalTopicRevisionInput,
  type EligibleVisitLookup,
  type SimilarityEdgesAccessor,
} from './incrementalTopicRevision.js';
import { buildLeidenCpmTopicRevision, LEIDEN_CPM_COSINE_THRESHOLD } from './leidenCpmTopicRevision.js';
import { buildTopicRevision } from './topicClusterer.js';
import type { TopicVisit, VisitSimilarityEdge } from './topicClusterer.js';
import {
  TOPIC_INCREMENTAL_REVISION_KEY,
  type TopicRevision,
} from '../producers/topic-revision.js';

const fixturesDir = join(fileURLToPath(import.meta.url), '..', '__fixtures__');

const visit = (canonicalUrl: string, focusedWindowMs = 9000): TopicVisit => ({
  canonicalUrl,
  title: canonicalUrl.split('/').pop() ?? canonicalUrl,
  focusedWindowMs,
  firstObservedAt: '2026-08-16T08:00:00.000Z',
  lastObservedAt: '2026-08-16T08:05:00.000Z',
});

const edge = (from: string, to: string, cosine: number): VisitSimilarityEdge => ({
  fromVisitKey: from,
  toVisitKey: to,
  cosine,
});

// A world = the corpus a caller (Phase B, eventually) would back
// getEligibleVisit / edgesForVisit with. Deliberately index-backed (not
// a filter-the-whole-array closure) to mirror the "never scan the full
// corpus" intent of the lookup-function input contract.
const makeWorld = (
  visits: readonly TopicVisit[],
  edges: readonly VisitSimilarityEdge[],
): { getEligibleVisit: EligibleVisitLookup; edgesForVisit: SimilarityEdgesAccessor } => {
  const byCanonical = new Map(visits.map((v) => [v.canonicalUrl, v] as const));
  const byNode = new Map<string, VisitSimilarityEdge[]>();
  for (const e of edges) {
    (byNode.get(e.fromVisitKey) ?? byNode.set(e.fromVisitKey, []).get(e.fromVisitKey)!).push(e);
    (byNode.get(e.toVisitKey) ?? byNode.set(e.toVisitKey, []).get(e.toVisitKey)!).push(e);
  }
  return {
    getEligibleVisit: (canonicalUrl) => {
      const v = byCanonical.get(canonicalUrl);
      return v !== undefined && v.focusedWindowMs > 0 ? v : null;
    },
    edgesForVisit: (canonicalUrl) => byNode.get(canonicalUrl) ?? [],
  };
};

const baseInput = (
  overrides: Partial<BuildIncrementalTopicRevisionInput> &
    Pick<BuildIncrementalTopicRevisionInput, 'previousRevision' | 'getEligibleVisit' | 'edgesForVisit'>,
): BuildIncrementalTopicRevisionInput => ({
  visitSimilarityRevisionId: 'sim-rev-1',
  dirtyVisitKeys: new Set(),
  addedEdges: [],
  removedEdges: [],
  hnswStore: null,
  cosineThreshold: LEIDEN_CPM_COSINE_THRESHOLD,
  producedAt: 1_755_000_000_000,
  ...overrides,
});

const topicByMembers = (
  revision: TopicRevision,
  members: readonly string[],
): TopicRevision['topics'][number] | undefined => {
  const set = new Set(members);
  return revision.topics.find(
    (t) => t.memberCanonicalUrls.length === set.size && t.memberCanonicalUrls.every((m) => set.has(m)),
  );
};

describe('buildIncrementalTopicRevision — equivalence with full rebuild', () => {
  it('matches a full leiden-cpm rebuild for the affected region and carries unaffected topics byte-identical', async () => {
    const A = ['https://x/a1', 'https://x/a2', 'https://x/a3'];
    const B = ['https://x/b1', 'https://x/b2', 'https://x/b3'];
    const clique = (ns: readonly string[]): VisitSimilarityEdge[] => {
      const out: VisitSimilarityEdge[] = [];
      for (let i = 0; i < ns.length; i += 1) {
        for (let j = i + 1; j < ns.length; j += 1) {
          out.push(edge(ns[i]!, ns[j]!, 0.95));
        }
      }
      return out;
    };
    const baseEdges = [...clique(A), ...clique(B)];
    const baseVisits = [...A, ...B].map((u) => visit(u));

    const previousRevision = await buildLeidenCpmTopicRevision({
      visits: baseVisits,
      visitSimilarity: { revisionId: 'sim-base', edges: baseEdges },
      options: { producedAt: 1_755_000_000_000 - 1000 },
    });
    expect(previousRevision.topics).toHaveLength(2);

    // A new visit c1 shows up this drain, strongly similar to a1 only.
    const c1 = 'https://x/c1';
    const newEdge = edge(c1, 'https://x/a1', 0.95);
    const currentEdges = [...baseEdges, newEdge];
    const currentVisits = [...baseVisits, visit(c1)];
    const world = makeWorld(currentVisits, currentEdges);

    const result = await buildIncrementalTopicRevision(
      baseInput({
        previousRevision,
        visitSimilarityRevisionId: 'sim-current',
        dirtyVisitKeys: new Set([c1]),
        addedEdges: [newEdge],
        getEligibleVisit: world.getEligibleVisit,
        edgesForVisit: world.edgesForVisit,
      }),
    );

    expect(result.overflow).toBeNull();
    expect(result.promotedCount).toBe(1); // score 0.95 >= 0.9 + 0.03 margin

    const fullRebuild = await buildLeidenCpmTopicRevision({
      visits: currentVisits,
      visitSimilarity: { revisionId: 'sim-current', edges: currentEdges },
      options: { producedAt: 1_755_000_000_000 },
    });

    // Affected region: incremental's {a1,a2,a3,c1} topic has the SAME
    // content-hash id and metadata as the full rebuild's.
    const incrementalAffected = topicByMembers(result.revision, [...A, c1]);
    const fullAffected = topicByMembers(fullRebuild, [...A, c1]);
    expect(incrementalAffected).toBeDefined();
    expect(incrementalAffected).toEqual(fullAffected);

    // Unaffected region: B's topic is carried forward byte-identical —
    // same object reference, not just structurally equal.
    const previousB = topicByMembers(previousRevision, B);
    const incrementalB = topicByMembers(result.revision, B);
    expect(incrementalB).toBe(previousB);
    const fullB = topicByMembers(fullRebuild, B);
    expect(incrementalB).toEqual(fullB);
  });
});

describe('buildIncrementalTopicRevision — split', () => {
  it('reproduces the documented topic-lineage split fixture (dense triangle survives, weak edge drops)', async () => {
    const fixture = JSON.parse(
      await readFile(join(fixturesDir, 'topic-lineage-split.json'), 'utf8'),
    ) as {
      visits: readonly TopicVisit[];
      previousVisitSimilarity: { revisionId: string; edges: readonly VisitSimilarityEdge[] };
      currentVisitSimilarity: { revisionId: string; edges: readonly VisitSimilarityEdge[] };
      expectedCurrentTopicCount: number;
      expectedLineageKinds: readonly string[];
    };

    // Fixture cosines (0.91/0.84) were tuned for the 0.85 default
    // threshold (topicClusterer.test.ts), not leiden's 0.90 — the
    // triangle-survives/weak-edge-drops topology this test exercises
    // is threshold-relative, so we reuse the fixture at 0.85. leiden-cpm
    // strongly prefers a fully-connected triangle intact (no incentive
    // to fragment it further), so this scenario is algorithm-agnostic —
    // "applicable" per the task's reuse instruction.
    const cosineThreshold = 0.85;
    const previousRevision = await buildTopicRevision({
      visits: fixture.visits,
      visitSimilarity: fixture.previousVisitSimilarity,
      options: { cosineThreshold, producedAt: 1_755_000_000_000 - 1000 },
    });
    expect(previousRevision.topics).toHaveLength(1);

    const world = makeWorld(fixture.visits, fixture.currentVisitSimilarity.edges);
    const removedEdge = fixture.previousVisitSimilarity.edges.find(
      (e) => e.fromVisitKey.endsWith('/c') && e.toVisitKey.endsWith('/d'),
    )!;

    const result = await buildIncrementalTopicRevision(
      baseInput({
        previousRevision,
        visitSimilarityRevisionId: fixture.currentVisitSimilarity.revisionId,
        addedEdges: fixture.currentVisitSimilarity.edges.filter(
          (e) => e.fromVisitKey.endsWith('/a') && e.toVisitKey.endsWith('/c'),
        ),
        removedEdges: [removedEdge],
        getEligibleVisit: world.getEligibleVisit,
        edgesForVisit: world.edgesForVisit,
        cosineThreshold,
      }),
    );

    expect(result.overflow).toBeNull();
    expect(result.revision.topics).toHaveLength(fixture.expectedCurrentTopicCount);
    expect([...result.revision.lineage.map((l) => l.kind)].sort()).toEqual(
      [...fixture.expectedLineageKinds].sort(),
    );
  });
});

describe('buildIncrementalTopicRevision — merge', () => {
  it('merges two triangles into one community once fully cross-bridged', async () => {
    // NOTE (deviation from the literal topic-lineage-merge.json fixture):
    // that fixture is a sparse 5-edge chain bridged at one node — under
    // union-find (any edge connects) that chain is one component, but
    // leiden-cpm's CPM objective (gamma=0.18) actually prefers splitting
    // a sparse 6-node chain into two dense 3-node halves over one big
    // sparse community (verified by hand: net objective 2.56 for two
    // triangles vs 1.85 for one chain) — so that fixture is not
    // "applicable" to a CPM-based merge test. This scenario instead
    // uses the SAME two-dense-triangles shape leidenCpmTopicRevision.test.ts
    // already relies on, bridged densely enough (full cross-connect)
    // that ONE merged community is unambiguously CPM-optimal — the
    // leiden-cpm analogue of the union-find merge fixture.
    const A = ['https://y/a1', 'https://y/a2', 'https://y/a3'];
    const B = ['https://y/b1', 'https://y/b2', 'https://y/b3'];
    const triangle = (ns: readonly string[]): VisitSimilarityEdge[] => [
      edge(ns[0]!, ns[1]!, 0.95),
      edge(ns[1]!, ns[2]!, 0.95),
      edge(ns[0]!, ns[2]!, 0.95),
    ];
    const previousEdges = [...triangle(A), ...triangle(B)];
    const visits = [...A, ...B].map((u) => visit(u));

    const previousRevision = await buildLeidenCpmTopicRevision({
      visits,
      visitSimilarity: { revisionId: 'sim-merge-prev', edges: previousEdges },
      options: { producedAt: 1_755_000_000_000 - 1000 },
    });
    expect(previousRevision.topics).toHaveLength(2);

    const bridgeEdges: VisitSimilarityEdge[] = [];
    for (const a of A) for (const b of B) bridgeEdges.push(edge(a, b, 0.95));
    const currentEdges = [...previousEdges, ...bridgeEdges];
    const world = makeWorld(visits, currentEdges);

    const result = await buildIncrementalTopicRevision(
      baseInput({
        previousRevision,
        visitSimilarityRevisionId: 'sim-merge-current',
        addedEdges: bridgeEdges,
        getEligibleVisit: world.getEligibleVisit,
        edgesForVisit: world.edgesForVisit,
      }),
    );

    expect(result.overflow).toBeNull();
    expect(result.revision.topics).toHaveLength(1);
    expect(result.revision.topics[0]?.memberCanonicalUrls).toEqual([...A, ...B].sort());
    expect([...result.revision.lineage.map((l) => l.kind)].sort()).toEqual(['merge', 'merge']);
  });
});

describe('buildIncrementalTopicRevision — overflow', () => {
  it('returns the previous revision unchanged with a typed overflow report when the subgraph exceeds the cap', async () => {
    const A = ['https://z/a1', 'https://z/a2', 'https://z/a3', 'https://z/a4'];
    const edges: VisitSimilarityEdge[] = [];
    for (let i = 0; i < A.length; i += 1) {
      for (let j = i + 1; j < A.length; j += 1) {
        edges.push(edge(A[i]!, A[j]!, 0.95));
      }
    }
    const visits = A.map((u) => visit(u));
    const previousRevision = await buildLeidenCpmTopicRevision({
      visits,
      visitSimilarity: { revisionId: 'sim-of-prev', edges },
      options: { producedAt: 1_755_000_000_000 - 1000 },
    });
    expect(previousRevision.topics).toHaveLength(1);

    const world = makeWorld(visits, edges);
    const result = await buildIncrementalTopicRevision(
      baseInput({
        previousRevision,
        visitSimilarityRevisionId: 'sim-of-current',
        dirtyVisitKeys: new Set([A[0]!]),
        getEligibleVisit: world.getEligibleVisit,
        edgesForVisit: world.edgesForVisit,
        subgraphCap: 2, // the topic has 4 members — guaranteed overflow
      }),
    );

    expect(result.revision).toBe(previousRevision);
    expect(result.overflow).not.toBeNull();
    expect(result.overflow?.reason).toBe('subgraph-cap-exceeded');
    expect(result.overflow?.cap).toBe(2);
    expect(result.overflow?.subgraphSize).toBeGreaterThan(2);
    expect(result.topicSizeHistogram).toHaveLength(1);
    expect(result.topicSizeHistogram[0]?.memberCount).toBe(result.overflow?.subgraphSize);
  });
});

describe('buildIncrementalTopicRevision — promotion rule', () => {
  const setup = () => {
    const existing = 'https://p/existing';
    const previousRevision: TopicRevision = {
      revisionId: 'rev-promote-base',
      visitSimilarityRevisionId: 'sim-promote-base',
      cosineThreshold: 0.9,
      algorithmVersion: TOPIC_INCREMENTAL_REVISION_KEY,
      topics: [
        {
          topicId: 'topic:promote-base',
          memberCanonicalUrls: [existing, 'https://p/existing2'],
          metadata: {
            memberCount: 2,
            representativeTitles: [],
            firstObservedAt: '2026-08-16T00:00:00.000Z',
            lastObservedAt: '2026-08-16T00:00:00.000Z',
            cohesion: 0.9,
          },
        },
      ],
      lineage: [],
      producedAt: 1,
    };
    return { existing, previousRevision };
  };

  it('promotes via score >= threshold + margin even with a single supporting edge', async () => {
    const { existing, previousRevision } = setup();
    const candidate = 'https://p/strong';
    const strongEdge = edge(candidate, existing, 0.95); // 0.95 >= 0.9 + 0.03
    const visits = [
      visit(existing),
      visit('https://p/existing2'),
      visit(candidate),
    ];
    const world = makeWorld(visits, [strongEdge]);

    const result = await buildIncrementalTopicRevision(
      baseInput({
        previousRevision,
        dirtyVisitKeys: new Set([candidate]),
        addedEdges: [strongEdge],
        getEligibleVisit: world.getEligibleVisit,
        edgesForVisit: world.edgesForVisit,
      }),
    );

    expect(result.promotedCount).toBe(1);
    expect(result.secondaryCount).toBe(0);
    const topic = result.revision.topics.find((t) => t.memberCanonicalUrls.includes(candidate));
    expect(topic?.memberCanonicalUrls).toContain(candidate);
  });

  it('promotes via supportCount >= 2 even when each edge is below the margin', async () => {
    const { previousRevision } = setup();
    const candidate = 'https://p/support2';
    // Two edges at exactly the threshold (0.90 < 0.93 margin bar) but
    // supportCount=2 clears the OR'd support-count rule.
    const e1 = edge(candidate, 'https://p/existing', 0.9);
    const e2 = edge(candidate, 'https://p/existing2', 0.9);
    const visits = [
      visit('https://p/existing'),
      visit('https://p/existing2'),
      visit(candidate),
    ];
    const world = makeWorld(visits, [e1, e2]);

    const result = await buildIncrementalTopicRevision(
      baseInput({
        previousRevision,
        dirtyVisitKeys: new Set([candidate]),
        addedEdges: [e1, e2],
        getEligibleVisit: world.getEligibleVisit,
        edgesForVisit: world.edgesForVisit,
      }),
    );

    expect(result.promotedCount).toBe(1);
    const topic = result.revision.topics.find((t) => t.memberCanonicalUrls.includes(candidate));
    expect(topic?.memberCanonicalUrls).toContain(candidate);
  });

  it('keeps a below-bar candidate as a SECONDARY affiliation, not a primary member', async () => {
    const { existing, previousRevision } = setup();
    const candidate = 'https://p/weak';
    // Single edge exactly at threshold, well under threshold+margin,
    // supportCount=1 < 2 — neither promotion clause fires.
    const weakEdge = edge(candidate, existing, 0.9);
    const visits = [
      visit(existing),
      visit('https://p/existing2'),
      visit(candidate),
    ];
    const world = makeWorld(visits, [weakEdge]);

    const result = await buildIncrementalTopicRevision(
      baseInput({
        previousRevision,
        dirtyVisitKeys: new Set([candidate]),
        addedEdges: [weakEdge],
        getEligibleVisit: world.getEligibleVisit,
        edgesForVisit: world.edgesForVisit,
      }),
    );

    expect(result.promotedCount).toBe(0);
    expect(result.secondaryCount).toBe(1);
    const topic = result.revision.topics.find((t) => t.topicId === previousRevision.topics[0]?.topicId);
    expect(topic?.memberCanonicalUrls).toEqual(previousRevision.topics[0]?.memberCanonicalUrls);
    expect(topic?.secondaryAffiliations?.map((a) => a.canonicalUrl)).toEqual([candidate]);
  });

  it('resolves default and env-overridden promotion constants', () => {
    expect(resolveTopicPromoteSupport()).toBe(DEFAULT_TOPIC_PROMOTE_SUPPORT);
    expect(resolveTopicPromoteMargin()).toBe(DEFAULT_TOPIC_PROMOTE_MARGIN);
    expect(resolveTopicPromoteSupport(5)).toBe(5);
    expect(resolveTopicPromoteMargin(0.1)).toBe(0.1);
    expect(resolveTopicSubgraphCap(10)).toBe(10);
  });
});

describe('buildIncrementalTopicRevision — determinism', () => {
  it('produces byte-identical output across 50 repeated runs', async () => {
    const A = ['https://d/a1', 'https://d/a2', 'https://d/a3'];
    const B = ['https://d/b1', 'https://d/b2', 'https://d/b3'];
    const triangle = (ns: readonly string[]): VisitSimilarityEdge[] => [
      edge(ns[0]!, ns[1]!, 0.95),
      edge(ns[1]!, ns[2]!, 0.95),
      edge(ns[0]!, ns[2]!, 0.95),
    ];
    const previousEdges = [...triangle(A), ...triangle(B)];
    const visits = [...A, ...B].map((u) => visit(u));
    const previousRevision = await buildLeidenCpmTopicRevision({
      visits,
      visitSimilarity: { revisionId: 'sim-det-prev', edges: previousEdges },
      options: { producedAt: 1_755_000_000_000 - 1000 },
    });

    const c1 = 'https://d/c1';
    const newEdges = [edge(c1, A[0]!, 0.95), edge(c1, A[1]!, 0.9)];
    const currentEdges = [...previousEdges, ...newEdges];
    const currentVisits = [...visits, visit(c1)];
    const world = makeWorld(currentVisits, currentEdges);

    const input = baseInput({
      previousRevision,
      visitSimilarityRevisionId: 'sim-det-current',
      dirtyVisitKeys: new Set([c1]),
      addedEdges: newEdges,
      getEligibleVisit: world.getEligibleVisit,
      edgesForVisit: world.edgesForVisit,
      producedAt: 1_755_000_000_000,
    });

    const results = await Promise.all(Array.from({ length: 50 }, () => buildIncrementalTopicRevision(input)));
    const serialized = results.map((r) => JSON.stringify(r.revision));
    const first = serialized[0]!;
    for (const s of serialized) expect(s).toBe(first);
  });
});
