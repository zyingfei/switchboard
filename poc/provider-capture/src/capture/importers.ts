import type { ProviderCapture } from './model';
import { buildCaptureWarnings } from './redaction';
import { createCaptureId } from '../shared/ids';
import { nowIso } from '../shared/time';

export interface GeminiChromeImportInput {
  sharedTabTitle?: string;
  promptText?: string;
  responseText: string;
  capturedAt?: string;
}

const normalizeText = (value: string): string =>
  value
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const createGeminiChromeImportCapture = ({
  sharedTabTitle,
  promptText,
  responseText,
  capturedAt = nowIso(),
}: GeminiChromeImportInput): ProviderCapture => {
  const normalizedSharedTabTitle = normalizeText(sharedTabTitle ?? '');
  const normalizedPromptText = normalizeText(promptText ?? '');
  const normalizedResponseText = normalizeText(responseText);
  const titleSuffix =
    normalizedSharedTabTitle || normalizedPromptText.split('\n')[0] || 'Imported conversation';
  const title = `Gemini in Chrome - ${titleSuffix}`.slice(0, 140);
  const url = 'chrome://glic/imported';

  const turns: ProviderCapture['turns'] = [];
  if (normalizedPromptText) {
    turns.push({
      id: 'turn-1',
      role: 'user',
      text: normalizedPromptText,
      formattedText: normalizedPromptText,
      ordinal: 0,
      sourceSelector: 'gemini chrome import prompt',
    });
  }

  turns.push({
    id: `turn-${turns.length + 1}`,
    role: 'assistant',
    text: normalizedResponseText,
    formattedText: normalizedResponseText,
    ordinal: turns.length,
    sourceSelector: 'gemini chrome import response',
  });

  const combinedText = turns.map((turn) => turn.text).join('\n\n');
  return {
    id: createCaptureId('gemini', capturedAt, `${title}\n${combinedText}`),
    provider: 'gemini',
    url,
    title,
    capturedAt,
    extractionConfigVersion: '2026-04-25-gemini-chrome-import-v1',
    selectorCanary: 'passed',
    turns,
    artifacts: [],
    warnings: buildCaptureWarnings(combinedText, url),
    visibleTextCharCount: combinedText.length,
  };
};
