// Synthetic — P0 active-chat suppression contract.
//
// Tests the case the dogfood case-study exposed: a chat the user just
// fired via Ask-AI from a popover lands in the recall index almost
// immediately (the dispatch flow auto-captures the new chat). Without
// explicit suppression, recall happily returns it as "déjà-vu" —
// surfacing the user's own just-created artifact as a "prior match".
//
// Suppression contract: `session.activeChatBacIds` carries the IDs of
// active session artifacts; the server's SuppressionPolicy filters
// them out. Background SW injects these from recentDispatches; the
// content script need not know.
//
// This fixture verifies the SERVER behavior in isolation by passing
// activeChatBacIds explicitly in the harness's Fixture spec
// (chats[].threadId becomes the suppression key).

import type { Fixture } from '../harness.js';

const FRESH_ARTIFACT = 'chat-artifact-just-created';

export const fixture: Fixture = {
  name: 'ask-ai-artifact-suppression',
  description:
    'Just-created Ask-AI chat must NOT surface as déjà-vu when its bac_id is in activeChatBacIds; older topical pages still surface.',
  selectionText: 'how do consistent hashing algorithms handle resharding',
  selectionEmbedding: [1, 0, 0, 0, 0, 0, 0, 0],
  activeChatBacIds: [FRESH_ARTIFACT],
  docs: [
    {
      url: 'https://example.test/chash-1',
      title: 'Consistent hashing: a primer',
      body: 'Consistent hashing distributes keys across a ring of nodes; resharding rebalances.',
      embedding: [0.92, 0, 0, 0, 0, 0, 0, 0],
      firstSeenAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      url: 'https://example.test/chash-2',
      title: 'Resharding consistent-hash rings at scale',
      body: 'Resharding strategies for production consistent-hash deployments.',
      embedding: [0.9, 0, 0, 0, 0, 0, 0, 0],
      firstSeenAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      url: 'https://example.test/chash-3',
      title: 'Resharding without downtime',
      body: 'Live resharding patterns. Consistent hashing, virtual nodes.',
      embedding: [0.88, 0, 0, 0, 0, 0, 0, 0],
      firstSeenAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      url: 'https://example.test/noise-1',
      title: 'Bread baking for beginners',
      embedding: [0, 0, 0, 0, 0, 0, 0, 1],
    },
    {
      url: 'https://example.test/noise-2',
      title: 'Pottery wheel basics',
      embedding: [0, 0, 0, 0, 0, 0, 0, 1],
    },
  ],
  chats: [
    {
      threadId: FRESH_ARTIFACT,
      title: 'Ask GPT — consistent hashing',
      // The fresh chat's first turn is the SAME selection text — so
      // without suppression it would score top via both lexical AND
      // dense matchers (effectively a self-loop).
      firstUserTurn:
        'how do consistent hashing algorithms handle resharding when adding new nodes?',
      capturedAt: new Date(Date.now() - 90_000).toISOString(),
      embedding: [0.99, 0, 0, 0, 0, 0, 0, 0],
    },
  ],
  expected: {
    mustInclude: [
      'https://example.test/chash-1',
      'https://example.test/chash-2',
      'https://example.test/chash-3',
    ],
    forbidden: ['https://example.test/noise-1', 'https://example.test/noise-2'],
  },
  assertions: {
    recallAtK: 5,
    minRecall: 0.66,
    maxSelfRate: 0.0,
    maxForbiddenRate: 0.0,
  },
};
