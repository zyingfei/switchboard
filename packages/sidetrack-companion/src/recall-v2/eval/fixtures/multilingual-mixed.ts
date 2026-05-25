// Synthetic — mixed Latin + CJK selection. Both English and Chinese
// pages on the same topic should be reachable from one selection.

import type { Fixture } from '../harness.js';

export const fixture: Fixture = {
  name: 'multilingual-mixed',
  description:
    'Selection mixes Latin + CJK; both English and Chinese pages on the topic must surface (cross-script tokenization + dense retrieval).',
  selectionText: 'Claude Code 编程助手',
  selectionEmbedding: [1, 0, 0, 0, 0, 0.4, 0, 0],
  docs: [
    {
      url: 'https://example.test/cn-1',
      title: 'Claude Code 中文教程',
      body: 'Claude Code 是 Anthropic 的编程助手 CLI 工具。',
      embedding: [0.93, 0, 0, 0, 0, 0.4, 0, 0],
    },
    {
      url: 'https://example.test/cn-2',
      title: 'AI 编程助手对比',
      body: 'Claude Code vs Codex vs Cursor 编程助手对比评测。',
      embedding: [0.9, 0, 0, 0, 0, 0.35, 0, 0],
    },
    {
      url: 'https://example.test/cn-3',
      title: '编程助手的未来',
      body: '编程助手 AI agent 未来发展',
      embedding: [0.85, 0, 0, 0, 0, 0.3, 0, 0],
    },
    {
      url: 'https://example.test/en-1',
      title: 'Claude Code: The new CLI coding assistant',
      body: 'Claude Code is the new CLI tool from Anthropic for coding assistance.',
      embedding: [0.92, 0, 0, 0, 0, 0.4, 0, 0],
    },
    {
      url: 'https://example.test/en-2',
      title: 'Coding assistants in 2026',
      body: 'A review of coding assistants: Claude Code, Codex, Cursor, Copilot.',
      embedding: [0.88, 0, 0, 0, 0, 0.4, 0, 0],
    },
    {
      url: 'https://example.test/en-3',
      title: 'Building with Claude Code',
      body: 'A developer guide to building software with Claude Code.',
      embedding: [0.85, 0, 0, 0, 0, 0.35, 0, 0],
    },
    {
      url: 'https://example.test/noise-1',
      title: 'Gardening for beginners',
      embedding: [0, 0, 0, 0, 0, 0, 0, 1],
    },
    {
      url: 'https://example.test/noise-2',
      title: 'Pasta primer',
      embedding: [0, 0, 0, 0, 0, 0, 0, 1],
    },
  ],
  expected: {
    mustInclude: [
      'https://example.test/cn-1',
      'https://example.test/en-1',
      'https://example.test/cn-2',
      'https://example.test/en-2',
    ],
    shouldInclude: ['https://example.test/cn-3', 'https://example.test/en-3'],
    forbidden: ['https://example.test/noise-1', 'https://example.test/noise-2'],
  },
  assertions: {
    recallAtK: 6,
    minRecall: 0.5,
    maxForbiddenRate: 0.0,
  },
};
