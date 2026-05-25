// Synthetic — freshness weighting. 20 pages, all semantically related;
// half are 1 day old, half are 2 years old. Top 5 should lean recent
// but the old pages must still appear in top 20 (not banished).

import type { Fixture } from '../harness.js';

const NOW = Date.now();
const ONE_DAY_AGO = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
const TWO_YEARS_AGO = new Date(NOW - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();

const recentDoc = (i: number): {
  url: string;
  title: string;
  body: string;
  firstSeenAt: string;
  lastSeenAt: string;
  embedding: readonly number[];
} => ({
  url: `https://example.test/recent-${String(i)}`,
  title: `recent post about distributed consensus protocols #${String(i)}`,
  body: 'Distributed consensus, Raft, Paxos, Multi-Paxos discussion.',
  firstSeenAt: ONE_DAY_AGO,
  lastSeenAt: ONE_DAY_AGO,
  embedding: [0.9, 0, 0, 0, 0, 0, 0, 0],
});

const oldDoc = (i: number): {
  url: string;
  title: string;
  body: string;
  firstSeenAt: string;
  lastSeenAt: string;
  embedding: readonly number[];
} => ({
  url: `https://example.test/old-${String(i)}`,
  title: `archived note on distributed consensus protocols #${String(i)}`,
  body: 'Distributed consensus, Raft, Paxos, Multi-Paxos archival.',
  firstSeenAt: TWO_YEARS_AGO,
  lastSeenAt: TWO_YEARS_AGO,
  embedding: [0.9, 0, 0, 0, 0, 0, 0, 0],
});

export const fixture: Fixture = {
  name: 'time-decay',
  description:
    'Top 5 should lean recent (freshness); 2-year-old pages must still appear in top 20 (not banished).',
  selectionText: 'distributed consensus protocols',
  selectionEmbedding: [1, 0, 0, 0, 0, 0, 0, 0],
  docs: [
    ...Array.from({ length: 10 }, (_, i) => recentDoc(i)),
    ...Array.from({ length: 10 }, (_, i) => oldDoc(i)),
  ],
  expected: {
    mustInclude: Array.from({ length: 4 }, (_, i) => `https://example.test/recent-${String(i)}`),
    shouldInclude: Array.from(
      { length: 5 },
      (_, i) => `https://example.test/old-${String(i)}`,
    ),
    forbidden: [],
  },
  assertions: {
    recallAtK: 5,
    minRecall: 0.5,
  },
  now: NOW,
};
