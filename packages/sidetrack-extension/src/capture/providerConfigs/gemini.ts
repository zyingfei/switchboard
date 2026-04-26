import type { ProviderExtractionConfig } from './types';

export const geminiExtractionConfig: ProviderExtractionConfig = {
  provider: 'gemini',
  version: '2026-04-25-gemini-v2',
  directSources: [
    {
      selector: '[data-capture-turn]',
      sourceSelector: '[data-capture-turn]',
      role: 'infer',
      roleAttributes: ['data-role', 'data-capture-role'],
      filterNestedMatches: true,
    },
    {
      selector: [
        'user-query',
        'model-response',
        '[data-testid*="user-query"]',
        '[data-testid*="model-response"]',
        '[data-response-index]',
        '[data-role="user"]',
        '[data-role="assistant"]',
      ].join(', '),
      sourceSelector: 'gemini message selectors',
      role: 'infer',
      roleAttributes: ['data-testid', 'data-role', 'aria-label'],
      tagRoles: {
        'user-query': 'user',
        'model-response': 'assistant',
      },
      alternatingRoles: ['user', 'assistant'],
      filterNestedMatches: true,
    },
  ],
  headingSources: [
    {
      selector: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
      sourceSelector: 'gemini heading fallback',
      rolePatterns: [
        { pattern: '^you said\\b', role: 'user' },
        { pattern: '^gemini said\\b', role: 'assistant' },
      ],
      maxAncestorChars: 12_000,
    },
  ],
  editableSources: [
    {
      selector: '[contenteditable="true"], [contenteditable="plaintext-only"]',
      sourceSelector: 'gemini editable panel',
      role: 'assistant',
      minTextLength: 200,
      excludePattern: "ask gemini|let'?s write or build together",
    },
  ],
};
