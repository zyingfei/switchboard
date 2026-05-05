/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';

import { enrichTurn } from '../../src/capture/turnEnricher';

const seedDoc = (bodyHtml: string): { doc: Document; body: HTMLElement } => {
  document.body.innerHTML = bodyHtml;
  return { doc: document, body: document.body };
};

describe('turnEnricher', () => {
  it('extracts ChatGPT model name + markdown for an assistant turn', () => {
    seedDoc(
      `<button aria-label="Switch model">GPT-5.1 Pro</button>
       <div data-message-author-role="assistant" id="t">
         <div class="markdown prose"><h2>Heading</h2><p>Body <strong>bold</strong>.</p></div>
       </div>`,
    );
    const turnNode = document.getElementById('t');
    if (turnNode === null) throw new Error('expected #t to mount');
    const out = enrichTurn({
      provider: 'chatgpt',
      turnNode,
      role: 'assistant',
      doc: document,
    });
    expect(out.modelName).toBe('GPT-5.1 Pro');
    expect(out.markdown).toContain('## Heading');
    expect(out.markdown).toContain('**bold**');
  });

  it('flags ChatGPT deep-research mode + collects citations', () => {
    seedDoc(
      `<button aria-label="Deep research, click to remove">Deep research</button>
       <div data-message-author-role="assistant" id="t">
         <div class="markdown prose">
           Body
           <span data-testid="webpage-citation-pill"><a href="https://a.com/x">a.com</a></span>
           <span data-testid="webpage-citation-pill"><a href="https://b.com/y">b.com</a></span>
         </div>
       </div>`,
    );
    const turnNode = document.getElementById('t');
    if (turnNode === null) throw new Error('expected #t to mount');
    const out = enrichTurn({
      provider: 'chatgpt',
      turnNode,
      role: 'assistant',
      doc: document,
    });
    expect(out.researchReport?.mode).toBe('deep-research');
    expect(out.researchReport?.citations?.length).toBe(2);
    expect(out.researchReport?.citations?.[0]?.url).toBe('https://a.com/x');
  });

  it('extracts Claude model name from the dropdown aria-label', () => {
    seedDoc(
      `<button data-testid="model-selector-dropdown" aria-label="Model: Sonnet 4.5">Sonnet 4.5</button>
       <div id="t"><div class="font-claude-response"><p>hi</p></div></div>`,
    );
    const turnNode = document.getElementById('t');
    if (turnNode === null) throw new Error('expected #t to mount');
    const out = enrichTurn({
      provider: 'claude',
      turnNode,
      role: 'assistant',
      doc: document,
    });
    expect(out.modelName).toBe('Sonnet 4.5');
    expect(out.markdown).toContain('hi');
  });

  it('separates Gemini "Show thinking" reasoning from the visible answer', () => {
    seedDoc(
      `<div id="t">
         <div class="response-content">Show thinking I considered options X and Y. Gemini said Final answer is X.</div>
       </div>`,
    );
    const turnNode = document.getElementById('t');
    if (turnNode === null) throw new Error('expected #t to mount');
    const out = enrichTurn({
      provider: 'gemini',
      turnNode,
      role: 'assistant',
      doc: document,
    });
    expect(out.reasoning).toContain('I considered');
    expect(out.markdown).toContain('Final answer');
    expect(out.markdown).not.toContain('Show thinking');
  });

  it('returns no enrichment for unknown providers', () => {
    seedDoc(`<div id="t">body</div>`);
    const turnNode = document.getElementById('t');
    if (turnNode === null) throw new Error('expected #t to mount');
    const out = enrichTurn({
      provider: 'codex',
      turnNode,
      role: 'assistant',
      doc: document,
    });
    expect(out).toEqual({});
  });
});
