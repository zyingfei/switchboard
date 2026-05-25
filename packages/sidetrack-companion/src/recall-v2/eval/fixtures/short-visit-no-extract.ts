// Synthetic — timeline-only recall. 10 pages with title+URL only; no
// body extracted, no semantic pool entry. Three of them have titles
// that match the selection. They MUST surface via the timeline-visit
// candidate generator.

import type { Fixture } from '../harness.js';

export const fixture: Fixture = {
  name: 'short-visit-no-extract',
  description:
    'Visited URLs with title+URL only (Readability bailed) must still be reachable via the timeline-visit candidate source.',
  selectionText: 'BGP routing table convergence',
  selectionEmbedding: [0, 1, 0, 0, 0, 0, 0, 0],
  docs: [
    { url: 'https://example.test/bgp-1', title: 'BGP routing convergence in practice' },
    { url: 'https://example.test/bgp-2', title: 'Hot reload of BGP routing tables' },
    { url: 'https://example.test/bgp-3', title: 'Convergence problems with BGP at scale' },
    { url: 'https://example.test/noise-1', title: 'Tomato gardening guide' },
    { url: 'https://example.test/noise-2', title: 'Pasta primer' },
    { url: 'https://example.test/noise-3', title: 'Watercolor techniques' },
    { url: 'https://example.test/noise-4', title: 'Coffee brewing methods' },
    { url: 'https://example.test/noise-5', title: 'Beginner yoga sequences' },
    { url: 'https://example.test/noise-6', title: 'Photography for beginners' },
    { url: 'https://example.test/noise-7', title: 'Best hiking trails of 2026' },
  ],
  expected: {
    mustInclude: [
      'https://example.test/bgp-1',
      'https://example.test/bgp-2',
      'https://example.test/bgp-3',
    ],
    forbidden: [
      'https://example.test/noise-1',
      'https://example.test/noise-2',
      'https://example.test/noise-3',
    ],
  },
  assertions: {
    recallAtK: 5,
    minRecall: 0.66,
    maxForbiddenRate: 0.0,
  },
};
