import type { ProviderExtractionConfig } from './types';

export const chatGptExtractionConfig: ProviderExtractionConfig = {
  provider: 'chatgpt',
  version: '2026-04-25-chatgpt-v3',
  mergeAdjacentSameRoleTurns: true,
  directSources: [
    {
      selector: '[data-capture-turn]',
      sourceSelector: '[data-capture-turn]',
      role: 'infer',
      roleAttributes: ['data-role', 'data-capture-role'],
      filterNestedMatches: true,
    },
    {
      selector: 'main [data-message-author-role], article[data-message-author-role]',
      sourceSelector: 'main [data-message-author-role]',
      role: 'infer',
      roleAttributes: ['data-message-author-role'],
      filterNestedMatches: true,
    },
    {
      selector: 'main article, main [data-testid*="conversation-turn"], main [data-testid*="message"]',
      sourceSelector: 'chatgpt fallback message selectors',
      role: 'infer',
      roleAttributes: ['data-testid', 'aria-label', 'data-role'],
      alternatingRoles: ['user', 'assistant'],
      filterNestedMatches: true,
    },
  ],
  headingSources: [
    {
      selector: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
      sourceSelector: 'chatgpt heading fallback',
      rolePatterns: [
        { pattern: '^you said\\b', role: 'user' },
        { pattern: '^chatgpt said\\b', role: 'assistant' },
      ],
      maxAncestorChars: 12_000,
    },
  ],
};
