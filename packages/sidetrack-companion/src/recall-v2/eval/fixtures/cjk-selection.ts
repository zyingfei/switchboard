// Synthetic — CJK boundary + bigram fan-out. Exercises analyzer.ts
// expandCjk and CJK_BOUNDARY_RE on mixed CJK + Latin titles.

import type { Fixture } from '../harness.js';

export const fixture: Fixture = {
  name: 'cjk-selection',
  description:
    'Chinese-only selection should hit pages with CJK titles via bigram fan-out and Latin+CJK boundary-split tokens.',
  selectionText: '故障注入',
  selectionEmbedding: [1, 0, 0, 0, 0, 0, 0, 0],
  docs: [
    {
      url: 'https://example.test/cjk-1',
      title: '故障注入Jepsen 测试分布式系统',
      body: '故障注入是测试分布式系统的常用方法。结合 Jepsen 框架。',
      embedding: [0.95, 0, 0, 0, 0, 0, 0, 0],
    },
    {
      url: 'https://example.test/cjk-2',
      title: '故障注入工具 - 中文文档',
      body: '故障注入工具说明书。',
      embedding: [0.9, 0, 0, 0, 0, 0, 0, 0],
    },
    {
      url: 'https://example.test/cjk-3',
      title: '分布式系统的故障模型',
      body: '故障模型 故障注入 分布式',
      embedding: [0.85, 0, 0, 0, 0, 0, 0, 0],
    },
    { url: 'https://example.test/noise-1', title: 'Tomato gardening guide' },
    { url: 'https://example.test/noise-2', title: 'Pasta primer' },
  ],
  expected: {
    mustInclude: [
      'https://example.test/cjk-1',
      'https://example.test/cjk-2',
      'https://example.test/cjk-3',
    ],
    forbidden: ['https://example.test/noise-1', 'https://example.test/noise-2'],
  },
  assertions: {
    recallAtK: 5,
    minRecall: 0.66,
    maxForbiddenRate: 0.0,
  },
};
