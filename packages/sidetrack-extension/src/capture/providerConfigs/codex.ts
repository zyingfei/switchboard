import type { ProviderExtractionConfig } from './types';

export const codexExtractionConfig: ProviderExtractionConfig = {
  provider: 'codex',
  version: '2026-05-03-codex-web-v1',
  mergeAdjacentSameRoleTurns: true,
  directSources: [
    {
      // Preferred synthetic/live-friendly contract: Codex surfaces turns
      // in article-like nodes with role metadata, mirroring ChatGPT.
      selector:
        'main [data-testid*="codex-turn"], main [data-message-author-role], article[data-message-author-role]',
      sourceSelector: 'codex role-attributed turn selectors',
      role: 'infer',
      roleAttributes: ['data-message-author-role', 'data-role', 'aria-label', 'data-testid'],
      filterNestedMatches: true,
    },
    {
      // Fallback for streamed assistant steps that are not yet wrapped in
      // an article but carry Codex task/log markers.
      selector: 'main [data-testid*="codex"], main [class*="codex" i], main [class*="message" i]',
      sourceSelector: 'codex task/message fallback selectors',
      role: 'infer',
      roleAttributes: ['data-testid', 'aria-label', 'data-role'],
      alternatingRoles: ['user', 'assistant'],
      filterNestedMatches: true,
    },
  ],
  headingSources: [
    {
      selector: 'h1, h2, h3, h4, [role="heading"]',
      sourceSelector: 'codex heading fallback',
      rolePatterns: [
        { pattern: '^you\\b', role: 'user' },
        { pattern: '^(?:codex|assistant)\\b', role: 'assistant' },
      ],
      maxAncestorChars: 12_000,
    },
  ],
};
