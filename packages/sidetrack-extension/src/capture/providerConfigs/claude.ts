import type { ProviderExtractionConfig } from './types';

export const claudeExtractionConfig: ProviderExtractionConfig = {
  provider: 'claude',
  version: '2026-04-25-claude-v2',
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
        '[data-testid*="user-message"]',
        '[data-testid*="assistant-message"]',
        '[data-testid*="chat-message"]',
        '[data-claude-message-role]',
        '[data-message-role]',
        '.font-claude-message',
      ].join(', '),
      sourceSelector: 'claude message selectors',
      role: 'infer',
      roleAttributes: [
        'data-testid',
        'data-claude-message-role',
        'data-message-role',
        'aria-label',
      ],
      alternatingRoles: ['user', 'assistant'],
      filterNestedMatches: true,
    },
  ],
  headingSources: [
    {
      selector: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
      sourceSelector: 'claude heading fallback',
      rolePatterns: [
        { pattern: '^you said\\b', role: 'user' },
        { pattern: '^claude responded\\b', role: 'assistant' },
      ],
      maxAncestorChars: 14_000,
    },
  ],
};
