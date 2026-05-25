// Synthetic — IDF must beat title-boost on rare terms. Selection has
// ONE rare term ("hollandtech") + many stopwords. 30 pages: 1 with
// "hollandtech" in title; 25 with "the/is/your" in title; 4 noise.
// The rare-term doc MUST land top 1.

import type { Fixture } from '../harness.js';

const noisePages = (start: number, count: number): { url: string; title: string }[] =>
  Array.from({ length: count }, (_, i) => ({
    url: `https://example.test/noise-${String(start + i)}`,
    title: `the is your guide to topic ${String(start + i)}`,
  }));

export const fixture: Fixture = {
  name: 'rare-term-rescue',
  description:
    'Selection with one rare term ("hollandtech") + stopwords. Rare-term doc MUST land top 1; stopword-matching docs MUST stay out of top 5.',
  selectionText: 'the is your hollandtech',
  selectionEmbedding: [0.5, 0, 0, 0, 0, 0, 0, 0],
  docs: [
    {
      url: 'https://hollandtech.net/about',
      title: 'About hollandtech',
      body: 'hollandtech is a publication. Charlie Holland is the author.',
      embedding: [0.95, 0, 0, 0, 0, 0, 0, 0],
    },
    ...noisePages(1, 25),
    {
      url: 'https://example.test/noise-26',
      title: 'random noise page A',
    },
    {
      url: 'https://example.test/noise-27',
      title: 'random noise page B',
    },
    {
      url: 'https://example.test/noise-28',
      title: 'random noise page C',
    },
    {
      url: 'https://example.test/noise-29',
      title: 'random noise page D',
    },
  ],
  expected: {
    mustInclude: ['https://hollandtech.net/about'],
    forbidden: [
      'https://example.test/noise-1',
      'https://example.test/noise-2',
      'https://example.test/noise-3',
      'https://example.test/noise-4',
      'https://example.test/noise-5',
    ],
  },
  assertions: {
    recallAtK: 1,
    minRecall: 1.0,
    minMrr: 1.0,
    maxForbiddenRate: 0.0,
  },
};
