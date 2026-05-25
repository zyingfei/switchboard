// Synthetic — current-session leakage. A chat the user just created
// (< 60s ago) whose first user turn semantically matches the selection.
// Suppression policy MUST drop it.

import type { Fixture } from '../harness.js';

const FRESH_THREAD = 'chat-self-loop-just-created';

export const fixture: Fixture = {
  name: 'chat-self-loop',
  description:
    'A just-created chat whose content matches the selection MUST be suppressed via activeChatBacIds. Older topical pages still surface.',
  selectionText: 'why is asynchronous I/O hard to model',
  selectionEmbedding: [1, 0, 0, 0, 0, 0, 0, 0],
  activeChatBacIds: [FRESH_THREAD],
  docs: [
    {
      url: 'https://example.test/async-io-1',
      title: 'Asynchronous I/O patterns in modern runtimes',
      body: 'async I/O patterns. Event loops, completion ports, io_uring.',
      embedding: [0.9, 0, 0, 0, 0, 0, 0, 0],
      firstSeenAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      url: 'https://example.test/async-io-2',
      title: 'The async-io complexity tax',
      body: 'Modeling async io is hard. The complexity tax of distributed runtimes.',
      embedding: [0.88, 0, 0, 0, 0, 0, 0, 0],
      firstSeenAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      url: 'https://example.test/async-io-3',
      title: 'Why io_uring changes everything',
      body: 'io_uring as a new model for async io on Linux.',
      embedding: [0.85, 0, 0, 0, 0, 0, 0, 0],
      firstSeenAt: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString(),
    },
    {
      url: 'https://example.test/noise-1',
      title: 'How to grow tomatoes',
      embedding: [0, 0, 0, 0, 0, 0, 0, 1],
    },
    {
      url: 'https://example.test/noise-2',
      title: 'Boiling pasta correctly',
      embedding: [0, 0, 0, 0, 0, 0, 0, 1],
    },
  ],
  chats: [
    {
      threadId: FRESH_THREAD,
      title: 'Async IO discussion (just now)',
      firstUserTurn: 'help me understand why asynchronous IO is hard to model in this codebase',
      capturedAt: new Date(Date.now() - 30_000).toISOString(),
      embedding: [0.95, 0, 0, 0, 0, 0, 0, 0],
    },
  ],
  expected: {
    mustInclude: [
      'https://example.test/async-io-1',
      'https://example.test/async-io-2',
      'https://example.test/async-io-3',
    ],
    forbidden: [],
  },
  assertions: {
    recallAtK: 5,
    minRecall: 0.66,
    maxSelfRate: 0.0,
  },
};
