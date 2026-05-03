import { describe, expect, it } from 'vitest';

import { captureVisibleConversation } from '../../src/capture/extractors';
import { detectProviderFromUrl, isProviderThreadUrl } from '../../src/capture/providerDetection';

describe('Codex web provider', () => {
  it('detects chatgpt.com/codex sessions as provider threads', () => {
    const url = 'https://chatgpt.com/codex/session-123';

    expect(detectProviderFromUrl(url)).toBe('codex');
    expect(isProviderThreadUrl('codex', url)).toBe(true);
  });

  it('extracts synthetic Codex DOM turns with role attribution and formatted code', () => {
    document.body.innerHTML = `
      <main>
        <article data-testid="codex-turn-user" data-message-author-role="user">
          <p>Implement the installer</p>
          <p>Image attachment: diagram attachment</p>
          <img src="attachment.png" alt="diagram attachment">
        </article>
        <article data-testid="codex-turn-assistant" data-message-author-role="assistant">
          <p>Working on it</p>
          <pre><code>pnpm test</code></pre>
        </article>
        <article data-testid="codex-turn-assistant-streaming" data-message-author-role="assistant">
          <p>Still checking edge cases</p>
        </article>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://chatgpt.com/codex/session-123',
      title: 'Codex session',
      capturedAt: '2026-05-03T23:00:00.000Z',
    });

    expect(capture.provider).toBe('codex');
    expect(capture.threadId).toBe('session-123');
    expect(capture.selectorCanary).toBe('ok');
    expect(capture.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(capture.turns[0]?.text).toContain('diagram attachment');
    expect(capture.turns[1]?.text).toContain('Still checking edge cases');
    expect(capture.turns[1]?.formattedText).toContain('pnpm test');
  });

  it('falls back cleanly for an empty Codex thread', () => {
    document.body.innerHTML = '<main></main>';

    const capture = captureVisibleConversation(document, {
      url: 'https://chatgpt.com/codex/session-empty',
      title: 'Empty Codex session',
      capturedAt: '2026-05-03T23:00:00.000Z',
    });

    expect(capture.provider).toBe('codex');
    expect(capture.selectorCanary).toBe('failed');
    expect(capture.turns).toEqual([]);
  });
});
