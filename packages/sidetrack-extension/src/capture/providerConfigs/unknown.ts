import type { ProviderExtractionConfig } from './types';

export const unknownExtractionConfig: ProviderExtractionConfig = {
  provider: 'unknown',
  version: '2026-04-25-unknown-v1',
  directSources: [
    {
      selector: '[data-capture-turn]',
      sourceSelector: '[data-capture-turn]',
      role: 'infer',
      roleAttributes: ['data-role', 'data-capture-role'],
      filterNestedMatches: true,
    },
  ],
};
