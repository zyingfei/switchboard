import { describe, expect, it, beforeEach } from 'vitest';

import { captureVisibleConversation, visibleTextFromElement } from '../../src/capture/extractors';

describe('provider capture extractors', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.title = 'Provider fixture';
  });

  it('extracts ChatGPT-like turns and keeps structured Markdown provenance', () => {
    document.body.innerHTML = `
      <main>
        <article data-message-author-role="user">Please review this product idea.</article>
        <article data-message-author-role="assistant">
          <p>ChatGPT response: keep provenance local.</p>
          <pre data-language="bash"><code>npm run build</code></pre>
          <table>
            <tr><th>Risk</th><th>Mitigation</th></tr>
            <tr><td>DOM drift</td><td>Provider configs</td></tr>
          </table>
          <span style="display:none">HIDDEN_CHATGPT_SECRET</span>
        </article>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://chatgpt.com/c/test-thread',
      capturedAt: '2026-04-25T00:00:00.000Z',
    });

    expect(capture.provider).toBe('chatgpt');
    expect(capture.threadId).toBe('test-thread');
    expect(capture.selectorCanary).toBe('ok');
    expect(capture.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(capture.turns[1].text).toContain('keep provenance local');
    expect(capture.turns[1].text).not.toContain('HIDDEN_CHATGPT_SECRET');
    expect(capture.turns[1].formattedText).toContain('```bash');
    expect(capture.turns[1].formattedText).toContain('| Risk | Mitigation |');
    expect(capture.turns[1].sourceSelector).toBe('main [data-message-author-role]');
  });

  it('extracts Claude-like turns', () => {
    document.body.innerHTML = `
      <main>
        <div data-testid="user-message">Map the hardest plugin capability.</div>
        <div data-testid="assistant-message">Claude response: capture drift is the risk.</div>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://claude.ai/chat/test-thread',
      capturedAt: '2026-04-25T00:00:00.000Z',
    });

    expect(capture.provider).toBe('claude');
    expect(capture.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(capture.turns[1].text).toContain('capture drift');
  });

  it('extracts Gemini-like turns', () => {
    document.body.innerHTML = `
      <main>
        <user-query>Compare capture approaches.</user-query>
        <model-response>Gemini response: use fixture canaries.</model-response>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://gemini.google.com/app/test-thread',
      capturedAt: '2026-04-25T00:00:00.000Z',
    });

    expect(capture.provider).toBe('gemini');
    expect(capture.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(capture.turns[1].text).toContain('fixture canaries');
  });

  it('falls back to visible main text for unknown pages', () => {
    document.body.innerHTML = `
      <main>
        <h1>Research note</h1>
        <p>Visible page text only.</p>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://example.com/research',
      capturedAt: '2026-04-25T00:00:00.000Z',
    });

    expect(capture.provider).toBe('unknown');
    expect(capture.selectorCanary).toBe('warning');
    expect(capture.turns[0].text).toContain('Visible page text only');
    expect(capture.warnings?.map((warning) => warning.code)).toContain('unsupported_provider');
  });

  it('does not read form-control values as conversation text', () => {
    document.body.innerHTML = `
      <main>
        <textarea>draft value should not be captured</textarea>
        <p>Rendered assistant text.</p>
      </main>
    `;

    const text = visibleTextFromElement(document.querySelector('main') as Element);

    expect(text).toContain('Rendered assistant text');
    expect(text).not.toContain('draft value should not be captured');
  });

  // Regression: previously, two distinct assistant replies with
  // identical text (e.g. two short "OK" replies) collapsed in
  // dedupeAndFinalizeTurns into one. That moved the surviving "last"
  // turn back to a user turn, which then drove the workboard pill into
  // a "Waiting on AI" state even when the chat actually ended in an
  // assistant turn. Found by `live-status-transitions.spec.ts` after
  // sending two `please reply OK only` pings produced wedged state.
  it('preserves distinct turns at different positions even when text matches', () => {
    document.body.innerHTML = `
      <main>
        <article data-message-author-role="user">First question</article>
        <article data-message-author-role="assistant">OK</article>
        <article data-message-author-role="user">Second question</article>
        <article data-message-author-role="assistant">OK</article>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://chatgpt.com/c/dedup-regression',
      capturedAt: '2026-04-29T00:00:00.000Z',
    });

    expect(capture.turns.map((turn) => turn.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(capture.turns.at(-1)?.role).toBe('assistant');
  });

  // Regression: on a fresh nav to a Gemini chat URL, the Angular
  // shell renders the sidebar (Search for chats, New chat, Notebooks,
  // recent thread titles) before mounting `<user-query>` /
  // `<model-response>`. The visible-main fallback would slurp that
  // sidebar text and store it as an "unknown" role turn, surfacing
  // nav text in the side panel's captured-turns view. For known
  // providers we now produce zero turns instead of falling back, and
  // the auto-capture gate drops the empty event so nothing pollutes
  // the vault.
  it('returns zero turns for a known-provider page with no message selectors yet', () => {
    document.body.innerHTML = `
      <main>
        <bard-sidenav>
          <search-nav-button>Search for chats</search-nav-button>
          <side-nav-action-button>New chat</side-nav-action-button>
          <conversations-list>
            <side-nav-entry-button>TrenchBoot Installation Guide</side-nav-entry-button>
            <side-nav-entry-button>Hyatt Early Check-In Options</side-nav-entry-button>
          </conversations-list>
        </bard-sidenav>
        <chat-window></chat-window>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://gemini.google.com/app/test-thread',
      capturedAt: '2026-05-04T00:00:00.000Z',
    });

    expect(capture.provider).toBe('gemini');
    expect(capture.turns).toEqual([]);
    expect(capture.selectorCanary).toBe('failed');
    expect(capture.visibleTextCharCount).toBe(0);
  });

  it('captures the active Gemini mode from bard-mode-switcher', () => {
    document.body.innerHTML = `
      <main>
        <bard-mode-switcher>
          <button>Thinking</button>
        </bard-mode-switcher>
        <user-query>Plan tomorrow.</user-query>
        <model-response>Sure, here's a plan.</model-response>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://gemini.google.com/app/abc',
      capturedAt: '2026-05-04T00:00:00.000Z',
    });

    expect(capture.selectedModel).toBe('Thinking');
  });

  it('falls back to undefined when no model picker is in the DOM', () => {
    document.body.innerHTML = `
      <main>
        <user-query>Plan tomorrow.</user-query>
        <model-response>Sure.</model-response>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://gemini.google.com/app/abc',
      capturedAt: '2026-05-04T00:00:00.000Z',
    });

    expect(capture.selectedModel).toBeUndefined();
  });

  it('detects a Claude composer model button', () => {
    document.body.innerHTML = `
      <main>
        <div data-testid="user-message">Hi</div>
        <div data-testid="assistant-message">Hello back.</div>
        <button>Sonnet 4.6</button>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://claude.ai/chat/abc',
      capturedAt: '2026-05-04T00:00:00.000Z',
    });

    expect(capture.selectedModel).toBe('Sonnet 4.6');
  });

  // The dedup fix above must NOT break the legitimate merge-adjacent
  // pathway (ChatGPT has `mergeAdjacentSameRoleTurns: true` in its
  // config). Two consecutive assistant chunks should still collapse
  // into one merged turn.
  it('merges adjacent same-role chunks for ChatGPT-like configs', () => {
    document.body.innerHTML = `
      <main>
        <article data-message-author-role="user">Plan tomorrow</article>
        <article data-message-author-role="assistant">Step one: outline</article>
        <article data-message-author-role="assistant">Step two: draft</article>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://chatgpt.com/c/merge-adjacent',
      capturedAt: '2026-04-29T00:00:00.000Z',
    });

    expect(capture.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(capture.turns[1].text).toContain('Step one: outline');
    expect(capture.turns[1].text).toContain('Step two: draft');
  });
});
