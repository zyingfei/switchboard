import { chatGptExtractionConfig } from './chatgpt';
import { claudeExtractionConfig } from './claude';
import { codexExtractionConfig } from './codex';
import { geminiExtractionConfig } from './gemini';
import type { ProviderConfigRegistry } from './types';
import { unknownExtractionConfig } from './unknown';

export const providerConfigs: ProviderConfigRegistry = {
  chatgpt: chatGptExtractionConfig,
  claude: claudeExtractionConfig,
  gemini: geminiExtractionConfig,
  codex: codexExtractionConfig,
  unknown: unknownExtractionConfig,
};

export type { ProviderConfigRegistry } from './types';
