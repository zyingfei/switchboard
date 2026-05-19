import { describe, expect, it } from 'vitest';

import { TOPIC_LEIDEN_CPM_REVISION_KEY } from '../producers/topic-revision.js';
import { leidenCpmPartition } from './leidenCpm.js';
import {
  buildLeidenCpmTopicRevision,
  LEIDEN_CPM_COSINE_THRESHOLD,
} from './leidenCpmTopicRevision.js';
import type { TopicVisit, VisitSimilarityEdge } from './topicClusterer.js';

const visit = (canonicalUrl: string): TopicVisit => ({
  canonicalUrl,
  title: canonicalUrl.split('/').pop() ?? canonicalUrl,
  focusedWindowMs: 9000,
  firstObservedAt: '2026-05-13T08:00:00.000Z',
  lastObservedAt: '2026-05-13T08:05:00.000Z',
});

// Two dense cliques bridged by ONE weak edge — CPM should cut the
// bridge and recover the two communities.
const A = ['https://x/a1', 'https://x/a2', 'https://x/a3'];
const B = ['https://x/b1', 'https://x/b2', 'https://x/b3'];
const clique = (ns: readonly string[], w: number): VisitSimilarityEdge[] => {
  const e: VisitSimilarityEdge[] = [];
  for (let i = 0; i < ns.length; i += 1)
    for (let j = i + 1; j < ns.length; j += 1)
      e.push({ fromVisitKey: ns[i]!, toVisitKey: ns[j]!, cosine: w });
  return e;
};
const edges: VisitSimilarityEdge[] = [
  ...clique(A, 0.95),
  ...clique(B, 0.95),
  { fromVisitKey: 'https://x/a1', toVisitKey: 'https://x/b1', cosine: 0.9 },
];
const visits = [...A, ...B].map(visit);
const visitSimilarity = { revisionId: 'sim-leiden-test', edges };

describe('leidenCpmPartition', () => {
  it('cuts the weak bridge and recovers the two cliques', () => {
    const groups = leidenCpmPartition(
      [...A, ...B].sort(),
      edges.filter((e) => e.cosine >= LEIDEN_CPM_COSINE_THRESHOLD),
    );
    const sized = groups.filter((g) => g.length >= 2).map((g) => [...g].sort());
    expect(sized).toHaveLength(2);
    expect(sized).toEqual(expect.arrayContaining([[...A].sort(), [...B].sort()]));
  });
});

describe('buildLeidenCpmTopicRevision', () => {
  it('produces a leiden-cpm revision at the 0.90 default with two topics', async () => {
    const rev = await buildLeidenCpmTopicRevision({ visits, visitSimilarity });
    expect(rev.algorithmVersion).toBe(TOPIC_LEIDEN_CPM_REVISION_KEY);
    expect(rev.cosineThreshold).toBe(LEIDEN_CPM_COSINE_THRESHOLD);
    expect(rev.topics).toHaveLength(2);
    expect(rev.topics.every((t) => t.memberCanonicalUrls.length === 3)).toBe(true);
    expect(rev.lineage).toEqual([]); // no previousRevision ⇒ no lineage edges
  });

  it('drops visits with focusedWindowMs <= 0 (validated G eligibility)', async () => {
    const withDead = [...visits, { ...visit('https://x/dead'), focusedWindowMs: 0 }];
    const rev = await buildLeidenCpmTopicRevision({
      visits: withDead,
      visitSimilarity: {
        revisionId: 'sim-leiden-dead',
        edges: [...edges, { fromVisitKey: 'https://x/dead', toVisitKey: 'https://x/a1', cosine: 0.95 }],
      },
    });
    const members = rev.topics.flatMap((t) => t.memberCanonicalUrls);
    expect(members).not.toContain('https://x/dead');
  });

  it('preserves topic-id lineage continuity via previousRevision', async () => {
    const first = await buildLeidenCpmTopicRevision({ visits, visitSimilarity });
    // Identical inputs + previousRevision ⇒ same topicIds, 'continue' lineage.
    const second = await buildLeidenCpmTopicRevision({
      visits,
      visitSimilarity,
      previousRevision: first,
    });
    expect(new Set(second.topics.map((t) => t.topicId))).toEqual(
      new Set(first.topics.map((t) => t.topicId)),
    );
    expect(second.lineage.length).toBeGreaterThan(0);
    expect(second.lineage.every((l) => l.kind === 'continue')).toBe(true);
  });
});
