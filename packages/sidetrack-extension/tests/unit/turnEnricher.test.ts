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
  it('extracts ChatGPT model name from data-message-model-slug + markdown', () => {
    // Per-turn slug is the canonical signal — works even when the
    // model picker is icon-only (no text) in the live DOM.
    seedDoc(
      `<div data-message-author-role="assistant" data-message-model-slug="gpt-5-5-thinking" id="t">
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
    expect(out.modelName).toBe('GPT-5.5 Thinking');
    expect(out.markdown).toContain('## Heading');
    expect(out.markdown).toContain('**bold**');
  });

  it('formats various ChatGPT slugs into human display names', () => {
    const cases: readonly { readonly slug: string; readonly display: string }[] = [
      { slug: 'gpt-5', display: 'GPT-5' },
      { slug: 'gpt-4o', display: 'GPT-4o' },
      { slug: 'gpt-5-5-thinking', display: 'GPT-5.5 Thinking' },
      { slug: 'o3-mini', display: 'o3 Mini' },
    ];
    for (const c of cases) {
      seedDoc(
        `<div data-message-author-role="assistant" data-message-model-slug="${c.slug}" id="t">
           <div class="markdown prose"><p>x</p></div>
         </div>`,
      );
      const turnNode = document.getElementById('t');
      if (turnNode === null) throw new Error('expected #t');
      const out = enrichTurn({
        provider: 'chatgpt',
        turnNode,
        role: 'assistant',
        doc: document,
      });
      expect(out.modelName, `slug=${c.slug}`).toBe(c.display);
    }
  });

  it('falls back to the picker button text when slug is missing', () => {
    seedDoc(
      `<button aria-label="Switch model">GPT-4o</button>
       <div data-message-author-role="assistant" id="t">
         <div class="markdown prose"><p>Body</p></div>
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
    expect(out.modelName).toBe('GPT-4o');
  });

  it('dedups ChatGPT citations by URL', () => {
    seedDoc(
      `<div data-message-author-role="assistant" id="t">
         <div class="markdown prose">
           Body
           <span data-testid="webpage-citation-pill"><a href="https://a.com">a.com</a></span>
           <span data-testid="webpage-citation-pill"><a href="https://a.com">a.com+1</a></span>
           <span data-testid="webpage-citation-pill"><a href="https://b.com">b.com</a></span>
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
    expect(out.researchReport?.citations?.length).toBe(2);
    expect(out.researchReport?.citations?.map((c) => c.url)).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
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

  it('extracts ChatGPT deep-research section headings (H1-H4) into researchReport.sections', () => {
    seedDoc(
      `<button aria-label="Deep research, click to remove">Deep research</button>
       <div data-message-author-role="assistant" id="t">
         <div class="markdown prose">
           <p>Preamble.</p>
           <h2>1. Plugin / extension behavior</h2>
           <p>…</p>
           <h2>2. Companion behavior</h2>
           <p>…</p>
           <h3>Sub-detail</h3>
           <h2>1. Plugin / extension behavior</h2>
           <h2>What this means for sync design</h2>
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
    // Dedup keeps each unique heading once, in document order.
    expect(out.researchReport?.sections).toEqual([
      '1. Plugin / extension behavior',
      '2. Companion behavior',
      'Sub-detail',
      'What this means for sync design',
    ]);
  });

  it('omits researchReport.sections for an ordinary (non-deep-research) chatgpt turn', () => {
    seedDoc(
      `<div data-message-author-role="assistant" id="t">
         <div class="markdown prose">
           <h2>Some heading</h2>
           <p>Plain answer.</p>
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
    expect(out.researchReport).toBeUndefined();
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

  it('separates Gemini "Show thinking" reasoning from the visible answer when content present', () => {
    seedDoc(
      `<div id="t">
         <div class="response-content">Show thinking I considered options X, Y, Z and weighed pros and cons of each carefully. Gemini said Final answer is X.</div>
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

  it('does NOT surface reasoning when Gemini "Show thinking" collapsible is closed (no content)', () => {
    // Closed collapsible: only the "Show thinking" + "Gemini said"
    // bookends are in the DOM. Don't return a reasoning field with
    // junk like "##" or ".".
    seedDoc(
      `<div id="t">
         <div class="response-content">Show thinking Gemini said Real answer goes here and elsewhere.</div>
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
    expect(out.reasoning).toBeUndefined();
    expect(out.markdown).toContain('Real answer');
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
