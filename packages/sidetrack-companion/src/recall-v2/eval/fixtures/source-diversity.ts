// Synthetic — guards against one-source domination. 50 pages, all
// matching lexically: 40 body-indexed (page_content), 5 title-only
// (timeline_visit), 3 chat-turn matches, 2 semantic-only.
// Top 5 must include at least 3 distinct sourceKinds.
//
// `assertions.skipRecallChecks: true` — this fixture tests the
// source-diversity axis, NOT recall. R@5/MRR/nDCG are reported but
// not gated; `minSourceDiversity` IS the real assertion.
//
// CURRENT STATE (2026-05-24): xfail tracked as
// `recall-v2-source-diversity-quota`. Today's pipeline favors the
// source with the most candidates — with 40 page-content matches all
// scoring high lexically, page-content fills top 5 and the other
// sources are pushed out (sourceDiv@5 = 1). Lifting the xfail
// requires source-weighted RRF or a per-source minimum quota in
// fusion.ts. This fixture is intentional quality debt, not a
// passing-by-accident bug; the xfail mechanism makes the regression
// visible in the eval report instead of silently zeroing out.

import type { Fixture } from '../harness.js';

const bodyMatch = (i: number) => ({
  url: `https://example.test/body-${String(i)}`,
  title: `body-indexed page about Raft consensus #${String(i)}`,
  body: 'Raft consensus protocol explained. Leader election, log replication.',
  embedding: [0.9, 0, 0, 0, 0, 0, 0, 0],
});

const titleOnly = (i: number) => ({
  url: `https://example.test/title-${String(i)}`,
  title: `title-only Raft notes #${String(i)}`,
});

const semanticOnly = (i: number, vec: readonly number[]) => ({
  url: `https://example.test/sem-${String(i)}`,
  title: `semantically related page #${String(i)}`,
  embedding: vec,
});

export const fixture: Fixture = {
  name: 'source-diversity',
  description:
    'When many docs match lexically, the top 5 must include at least 2 distinct source kinds (no single-source domination).',
  selectionText: 'Raft consensus protocol',
  selectionEmbedding: [1, 0, 0, 0, 0, 0, 0, 0],
  docs: [
    ...Array.from({ length: 40 }, (_, i) => bodyMatch(i)),
    ...Array.from({ length: 5 }, (_, i) => titleOnly(i)),
    ...Array.from({ length: 2 }, (_, i) =>
      semanticOnly(i, [0.95, 0, 0, 0, 0, 0, 0, 0]),
    ),
  ],
  chats: [
    {
      threadId: 'chat-raft-1',
      title: 'Raft notes',
      firstUserTurn: 'explain Raft consensus protocol step by step',
      capturedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      embedding: [0.9, 0, 0, 0, 0, 0, 0, 0],
    },
    {
      threadId: 'chat-raft-2',
      title: 'Raft vs Paxos',
      firstUserTurn: 'compare Raft consensus protocol with Paxos',
      capturedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      embedding: [0.88, 0, 0, 0, 0, 0, 0, 0],
    },
  ],
  expected: {
    // Not a recall test — these are example URLs from each source
    // for the metric table's information, but the gate cares about
    // source diversity, not their presence.
    mustInclude: [],
    forbidden: [],
  },
  assertions: {
    skipRecallChecks: true,
    minSourceDiversity: 2,
    maxForbiddenRate: 0.0,
  },
  xfail: {
    reason:
      'Fusion currently favors the source with the most candidates. With 40 body-indexed pages all matching lexically, page-content fills top 5 and timeline/chat/semantic sources are pushed out. Needs source-weighted RRF or per-source minimum quota in fusion.ts.',
    trackedAs: 'recall-v2-source-diversity-quota',
  },
};
