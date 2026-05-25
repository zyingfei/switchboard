// Grounded fixture from the 2026-05-24 dogfood case study.
// URLs are real (verified against ~/.sidetrack-vault-test on that
// date). Bodies are synthetic placeholders that exercise the lexical
// matchers without needing to seed full page extractions.
//
// Embedding axes (8-D):
//   0 = AI / Claude / agent role
//   1 = Network / data-center / fabric
//   4 = software architecture (metaphor; the drift axis)
//   5 = kanban / coding-assistant
//   6 = education / learning (common-word drift)
//
// Selection lives on axis 0; must-include docs are axis 0+5; forbidden
// docs are axis 1+4. Semantic-query MUST land must-include in top 5
// and keep forbidden out.

import type { Fixture } from '../harness.js';

const SELECTION = 'Claude is not your architect. Stop letting it pretend (hollandtech.net)';

export const fixture: Fixture = {
  name: 'hn-claude-architect',
  description:
    'Grounded — case-study. Selection on HN about Claude-as-architect. Must surface the article, the HN discussion, KanBots; must NOT surface software-architecture metaphors or data-center pages.',
  selectionText: SELECTION,
  selectionEmbedding: [1, 0, 0, 0, 0.1, 0.3, 0, 0],
  currentUrl: 'https://news.ycombinator.com/',
  activeChatBacIds: ['chat-just-created-ai-architect'],
  docs: [
    // must_include
    {
      url: 'https://www.hollandtech.net/claude-is-not-your-architect/',
      title: 'Claude Is Not Your Architect. Stop Letting It Pretend.',
      body:
        'Claude and other AI agents are excellent collaborators but they are not architects. ' +
        'Treating Claude as your software architect leads to drift and surface-level decisions.',
      embedding: [0.95, 0, 0, 0, 0.05, 0.1, 0, 0],
    },
    {
      url: 'https://news.ycombinator.com/item?id=48259784',
      title: 'Claude is not your architect. Stop letting it pretend | Hacker News',
      body: 'Discussion of the hollandtech.net article. Many comments about Claude and AI agents.',
      embedding: [0.9, 0, 0, 0, 0.1, 0.05, 0, 0],
    },
    {
      url: 'https://www.kanbots.dev/',
      title: 'KanBots — a kanban that runs parallel agents',
      body:
        'Local collaboration interface where each kanban task is either a Claude Code or Codex agent. ' +
        'Coordinates AI agents through a kanban board UI.',
      embedding: [0.7, 0, 0, 0, 0, 0.7, 0, 0],
    },
    {
      url: 'https://github.com/leodavinci1/kanbots',
      title: 'GitHub - leodavinci1/kanbots: Local collaboration interface...',
      body: 'Source code for the kanbots project. Runs AI agents (Claude, Codex) as kanban tasks.',
      embedding: [0.6, 0, 0, 0, 0, 0.7, 0, 0],
    },
    // should_include
    {
      url: 'https://github.com/KayhanB21/riskratchet',
      title: 'GitHub - KayhanB21/riskratchet: maintainability ratchet for AI-assisted Python',
      body: 'A maintainability ratchet for AI-assisted Python. Monitors AI agent output.',
      embedding: [0.5, 0, 0, 0, 0, 0.4, 0, 0],
    },
    {
      url: 'https://red.anthropic.com/2026/cvd/',
      title: 'Anthropic coordinated vulnerability disclosure',
      body: 'Anthropic policy on coordinated disclosure for Claude. AI safety and responsibility.',
      embedding: [0.6, 0, 0, 0, 0, 0.2, 0, 0],
    },
    // forbidden — common-word drift via "architect" → "architecture"
    {
      url: 'https://codeutopia.net/metaphors/',
      title: 'Applying metaphors from other fields into software development',
      body:
        'Software architecture metaphors from biology, mechanical engineering, and city planning. ' +
        'How architects of buildings inspire architects of software.',
      embedding: [0, 0, 0, 0, 0.95, 0, 0, 0.05],
    },
    {
      url: 'https://engineering.fb.com/2019/03/14/data-center-engineering/f16-minipack/',
      title: 'Reinventing our data center network with F16, Minipack',
      body:
        "Facebook's new data center network architecture uses F16 and Minipack to scale. " +
        'A new fabric architecture for hyperscale.',
      embedding: [0, 0.9, 0, 0, 0.1, 0, 0, 0],
    },
    {
      url: 'https://www.reddit.com/r/networking/comments/2mbmys/',
      title: "Facebook's new data center network architecture : r/networking",
      body: 'Reddit thread on Facebook data center network architecture. Networking discussion.',
      embedding: [0, 0.95, 0, 0, 0.05, 0, 0, 0],
    },
  ],
  chats: [
    {
      threadId: 'chat-just-created-ai-architect',
      title: 'AI 不应做架构师',
      firstUserTurn:
        '请把 hollandtech.net 上 Charlie Holland 关于 Claude 作为架构师的文章翻译成中文。',
      capturedAt: new Date(Date.now() - 60_000).toISOString(),
      embedding: [0.9, 0, 0, 0, 0.05, 0.15, 0, 0],
    },
  ],
  expected: {
    mustInclude: [
      'https://www.hollandtech.net/claude-is-not-your-architect/',
      'https://news.ycombinator.com/item?id=48259784',
      'https://www.kanbots.dev/',
      'https://github.com/leodavinci1/kanbots',
    ],
    shouldInclude: [
      'https://github.com/KayhanB21/riskratchet',
      'https://red.anthropic.com/2026/cvd/',
    ],
    forbidden: [
      'https://codeutopia.net/metaphors/',
      'https://engineering.fb.com/2019/03/14/data-center-engineering/f16-minipack/',
      'https://www.reddit.com/r/networking/comments/2mbmys/',
    ],
  },
  assertions: {
    recallAtK: 5,
    minRecall: 0.5,
    minNdcg: 0.5,
    minMrr: 0.5,
    maxForbiddenRate: 0.0,
    maxSelfRate: 0.0,
    minSourceDiversity: 1,
  },
};
