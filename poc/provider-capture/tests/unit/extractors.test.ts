import { beforeEach, describe, expect, it } from 'vitest';
import { captureVisibleConversation, visibleTextFromElement } from '../../src/capture/extractors';

describe('visible provider extraction', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.title = 'Provider fixture';
  });

  it('extracts ChatGPT-like turns and skips hidden text', () => {
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
          <div data-message-author-role="assistant">nested duplicate selector</div>
        </article>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://chatgpt.com/c/test',
      capturedAt: '2026-04-25T00:00:00.000Z',
    });

    expect(capture.provider).toBe('chatgpt');
    expect(capture.selectorCanary).toBe('passed');
    expect(capture.turns).toHaveLength(2);
    expect(capture.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(capture.turns[1].text).toContain('keep provenance local');
    expect(capture.turns[1].text).not.toContain('HIDDEN_CHATGPT_SECRET');
    expect(capture.turns[1].formattedText).toContain('```bash');
    expect(capture.turns[1].formattedText).toContain('| Risk | Mitigation |');
  });

  it('ignores ChatGPT sidebar history text outside the main conversation area', () => {
    document.body.innerHTML = `
      <aside>
        <div data-message-author-role="assistant">Unrelated project history should not be captured.</div>
      </aside>
      <main>
        <article data-message-author-role="user">Current conversation only.</article>
        <article data-message-author-role="assistant">Answer for the current conversation.</article>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://chatgpt.com/g/test-project/c/thread',
      capturedAt: '2026-04-25T00:00:00.000Z',
    });

    expect(capture.turns).toHaveLength(2);
    expect(capture.turns.map((turn) => turn.text).join('\n')).not.toContain('Unrelated project history');
    expect(capture.turns[1].text).toContain('Answer for the current conversation');
  });

  it('extracts Claude-like turns', () => {
    document.body.innerHTML = `
      <main>
        <div data-testid="user-message">Map the hardest plugin capability.</div>
        <div data-testid="assistant-message">Claude response: capture drift is the risk.</div>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://claude.ai/chat/test',
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
      url: 'https://gemini.google.com/app/test',
      capturedAt: '2026-04-25T00:00:00.000Z',
    });

    expect(capture.provider).toBe('gemini');
    expect(capture.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(capture.turns[1].text).toContain('fixture canaries');
  });

  it('merges adjacent ChatGPT assistant segments into one formatted turn', () => {
    document.body.innerHTML = `
      <main>
        <article data-message-author-role="user">How should the extension save structured output?</article>
        <article data-message-author-role="assistant">
          <p>First segment with context.</p>
        </article>
        <article data-message-author-role="assistant">
          <table>
            <tr><th>Format</th><th>Reason</th></tr>
            <tr><td>Markdown</td><td>Portable and local</td></tr>
          </table>
        </article>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://chatgpt.com/c/test-merge',
      capturedAt: '2026-04-25T00:00:00.000Z',
    });

    expect(capture.turns).toHaveLength(2);
    expect(capture.turns[1].role).toBe('assistant');
    expect(capture.turns[1].formattedText).toContain('First segment with context.');
    expect(capture.turns[1].formattedText).toContain('| Format | Reason |');
  });

  it('extracts Gemini live-like heading blocks', () => {
    document.body.innerHTML = `
      <main>
        <section>
          <div>
            <button>Copy prompt</button>
            <h2>You said</h2>
            <p>Can you also put the video leads, datasets usage into the canvas?</p>
          </div>
          <div>
            <button>Listen</button>
            <h2>Gemini said</h2>
            <div>
              <p>I updated the Project OmniStream plan to include the video leads.</p>
            </div>
          </div>
        </section>
        <div contenteditable="true">
          <h1>Project OmniStream: High-Scale Discovery & Insight Engine</h1>
          <p>This visible canvas content should also be capturable.</p>
          <p>It is long enough to clear the editor threshold for the POC.</p>
          <p>Additional visible detail keeps the panel realistic.</p>
          <p>This should not be mistaken for the Ask Gemini prompt box.</p>
          <p>The canvas includes architecture sections, dataset mappings, concurrency notes, and observability details.</p>
          <p>The extractor should keep this local, visible document text because it is part of the provider output.</p>
          <p>That lets the POC prove the harder case where Gemini opens a rich side-by-side document, not only plain chat bubbles.</p>
        </div>
      </main>
    `;

    const capture = captureVisibleConversation(document, {
      url: 'https://gemini.google.com/app/live-like',
      capturedAt: '2026-04-25T00:00:00.000Z',
    });

    expect(capture.provider).toBe('gemini');
    expect(capture.selectorCanary).toBe('passed');
    expect(capture.turns.some((turn) => turn.role === 'assistant' && turn.text.includes('Project OmniStream plan'))).toBe(
      true,
    );
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
    expect(capture.selectorCanary).toBe('fallback');
    expect(capture.turns[0].text).toContain('Visible page text only');
    expect(capture.warnings.map((warning) => warning.code)).toContain('unsupported_provider');
  });

  it('does not read visible form control values as conversation text', () => {
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
});
