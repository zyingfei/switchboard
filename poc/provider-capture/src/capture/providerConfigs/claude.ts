import type { ProviderExtractionConfig } from './types';

export const claudeExtractionConfig: ProviderExtractionConfig = {
  provider: 'claude',
  version: '2026-04-25-claude-v1',
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
      roleAttributes: ['data-testid', 'data-claude-message-role', 'data-message-role', 'aria-label'],
      alternatingRoles: ['user', 'assistant'],
      filterNestedMatches: true,
    },
  ],
};
