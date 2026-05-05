/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';

import { domToMarkdown } from '../../src/capture/domToMarkdown';

const fromHtml = (html: string): HTMLElement => {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  return wrapper;
};

describe('domToMarkdown', () => {
  it('preserves headings, paragraphs, and inline formatting', () => {
    const md = domToMarkdown(
      fromHtml('<h1>Title</h1><p>Hello <strong>world</strong> and <em>emphasis</em>.</p>'),
    );
    expect(md).toContain('# Title');
    expect(md).toContain('Hello **world**');
    expect(md).toContain('*emphasis*');
  });

  it('preserves ordered + unordered lists with nesting', () => {
    const md = domToMarkdown(
      fromHtml('<ul><li>Top<ul><li>Nested</li></ul></li><li>Sibling</li></ul>'),
    );
    expect(md).toContain('- Top');
    expect(md).toMatch(/ {2}- Nested/);
    expect(md).toContain('- Sibling');
  });

  it('preserves code blocks with language hint', () => {
    const md = domToMarkdown(fromHtml('<pre><code class="language-ts">const x = 1;</code></pre>'));
    expect(md).toContain('```ts\nconst x = 1;\n```');
  });

  it('renders links and images', () => {
    const md = domToMarkdown(
      fromHtml('<p><a href="https://example.com">site</a> with <img alt="logo" src="/l.png"></p>'),
    );
    expect(md).toContain('[site](https://example.com)');
    expect(md).toContain('![logo](/l.png)');
  });

  it('returns empty string for null root or empty body', () => {
    expect(domToMarkdown(null)).toBe('');
    expect(domToMarkdown(fromHtml(''))).toBe('');
  });

  it('renders tables in GFM form', () => {
    const md = domToMarkdown(
      fromHtml('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'),
    );
    expect(md).toContain('| A | B |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 1 | 2 |');
  });
});
