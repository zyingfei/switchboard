// Minimal DOM → GFM-markdown converter for captured chat turns.
//
// We deliberately don't pull a Turndown-class dependency: chat
// providers render a small subset of HTML (paragraphs, lists, code
// blocks, headers, links, blockquotes, hr, em/strong, inline code,
// images). Hand-rolling stays transparent — when a provider tweaks
// its DOM and the markdown drifts, the fix is one block in this
// file rather than a full library upgrade.
//
// Behavior is "lossless on the structural layer, plain-text on the
// body". Inline formatting that doesn't carry semantic meaning
// (color, font sizes, custom spans) is unwrapped to text. Anything
// that LOOKS like a code block, list, header, or table preserves
// shape.

const isElement = (node: Node): node is HTMLElement => node.nodeType === 1;
const isText = (node: Node): node is Text => node.nodeType === 3;

const inlineWrap = (markup: string, body: string): string =>
  body.length > 0 ? `${markup}${body}${markup}` : '';

const textOf = (node: Node): string => {
  // textContent is `string | null` on Node but `string` on Text and
  // Element. We coalesce defensively because some test fixtures
  // pass partial nodes and the strict type would force throws.
  const t = node.textContent;
  return typeof t === 'string' ? t : '';
};

const attr = (el: HTMLElement, name: string): string => {
  const v = el.getAttribute(name);
  return typeof v === 'string' ? v : '';
};

const renderInline = (node: Node): string => {
  if (isText(node)) {
    return textOf(node).replace(/\s+/g, ' ');
  }
  if (!isElement(node)) return '';
  const tag = node.tagName.toLowerCase();
  const inner = Array.from(node.childNodes).map(renderInline).join('');
  if (tag === 'br') return '\n';
  if (tag === 'strong' || tag === 'b') return inlineWrap('**', inner.trim());
  if (tag === 'em' || tag === 'i') return inlineWrap('*', inner.trim());
  if (tag === 'code') return inlineWrap('`', inner);
  if (tag === 's' || tag === 'del') return inlineWrap('~~', inner);
  if (tag === 'a') {
    const href = attr(node, 'href');
    return href.length > 0 ? `[${inner.trim()}](${href})` : inner;
  }
  if (tag === 'img') {
    const alt = attr(node, 'alt');
    const src = attr(node, 'src');
    return `![${alt}](${src})`;
  }
  return inner;
};

const renderBlock = (node: Node, depth: number): string => {
  if (isText(node)) {
    const text = textOf(node).replace(/\s+/g, ' ');
    return text.trim().length > 0 ? text : '';
  }
  if (!isElement(node)) return '';
  const tag = node.tagName.toLowerCase();

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const inner = renderInline(node).trim();
    return `${'#'.repeat(level)} ${inner}\n\n`;
  }

  if (tag === 'p') {
    const inner = renderInline(node).trim();
    return inner.length > 0 ? `${inner}\n\n` : '';
  }

  if (tag === 'pre') {
    const codeNode = node.querySelector('code') ?? node;
    const cls = isElement(codeNode) ? attr(codeNode, 'class') : '';
    const langMatch = /language-([\w-]+)/.exec(cls);
    const language = langMatch !== null && typeof langMatch[1] === 'string' ? langMatch[1] : '';
    const body = textOf(codeNode).replace(/\n$/, '');
    return `\`\`\`${language}\n${body}\n\`\`\`\n\n`;
  }

  if (tag === 'blockquote') {
    const inner = Array.from(node.childNodes)
      .map((child) => renderBlock(child, depth))
      .join('')
      .trim();
    return `${inner
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n\n`;
  }

  if (tag === 'hr') return `---\n\n`;

  if (tag === 'ul' || tag === 'ol') {
    const ordered = tag === 'ol';
    const startAttr = attr(node, 'start');
    const startN = startAttr.length > 0 ? Number(startAttr) : 1;
    const items = Array.from(node.children).filter(
      (child) => child.tagName.toLowerCase() === 'li',
    );
    const lines = items.map((li, index) => {
      const marker = ordered ? `${String(startN + index)}.` : '-';
      const inner = Array.from(li.childNodes)
        .map((child) => {
          if (isElement(child) && (child.tagName.toLowerCase() === 'ul' || child.tagName.toLowerCase() === 'ol')) {
            return `\n${renderBlock(child, depth + 1).trimEnd()}`;
          }
          return renderInline(child);
        })
        .join('')
        .trim();
      const indent = '  '.repeat(depth);
      return `${indent}${marker} ${inner.replace(/\n/g, `\n${indent}  `)}`;
    });
    return `${lines.join('\n')}\n\n`;
  }

  if (tag === 'table') {
    const rows = Array.from(node.querySelectorAll('tr'));
    if (rows.length === 0) return '';
    const cellsOf = (row: Element): readonly string[] =>
      Array.from(row.children).map((cell) => renderInline(cell).trim().replace(/\|/g, '\\|'));
    // We've already early-returned on rows.length === 0 above, so
    // rows[0] is non-null at runtime, but the runtime guard quiets
    // strictNullChecks in callers that pipe this through utility
    // helpers expecting Element | undefined.
    const header = cellsOf(rows[0]);
    const sep = header.map(() => '---');
    const body = rows.slice(1).map((r) => `| ${cellsOf(r).join(' | ')} |`);
    return `| ${header.join(' | ')} |\n| ${sep.join(' | ')} |\n${body.join('\n')}\n\n`;
  }

  return Array.from(node.childNodes)
    .map((child) => renderBlock(child, depth))
    .join('');
};

// Convert a DOM subtree to markdown. Returns "" when the subtree
// has no rendered content. Trims trailing whitespace.
export const domToMarkdown = (root: Node | null): string => {
  if (root === null) return '';
  const md = renderBlock(root, 0).replace(/\n{3,}/g, '\n\n').trim();
  return md;
};
