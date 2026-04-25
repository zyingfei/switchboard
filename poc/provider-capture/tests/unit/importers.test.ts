import { describe, expect, it } from 'vitest';
import { createGeminiChromeImportCapture } from '../../src/capture/importers';

describe('Gemini in Chrome importer', () => {
  it('creates a local Gemini capture from copied response text', () => {
    const capture = createGeminiChromeImportCapture({
      sharedTabTitle: 'Switchboard - Claude to Codex Workflow',
      promptText: 'what is this about?',
      responseText: `Core Workflow\n\n- Export artifacts\n- Initialize repo\n- Use Codex for implementation`,
      capturedAt: '2026-04-25T00:00:00.000Z',
    });

    expect(capture.provider).toBe('gemini');
    expect(capture.url).toBe('chrome://glic/imported');
    expect(capture.title).toContain('Switchboard - Claude to Codex Workflow');
    expect(capture.extractionConfigVersion).toBe('2026-04-25-gemini-chrome-import-v1');
    expect(capture.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(capture.turns[1].text).toContain('Core Workflow');
    expect(capture.visibleTextCharCount).toBeGreaterThan(20);
  });
});
