import {
  isElementVisible,
  isPrivateFormElement,
  normalizeInlineWhitespace,
  visibleTextFromElement,
} from './domUtils';

const blockTags = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'tr',
  'td',
  'th',
  'ul',
]);

const escapeMarkdownTableCell = (value: string): string =>
  value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');

const collapseParagraphs = (parts: readonly string[]): string =>
  parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const codeLanguageFromElement = (element: Element): string => {
  const candidates = [
    element.getAttribute('data-language'),
    element.closest('[data-language]')?.getAttribute('data-language'),
    element.getAttribute('class'),
    element.querySelector('[data-language]')?.getAttribute('data-language'),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const languageMatch = /(?:language-|lang(?:uage)?=)?([a-z0-9_+-]{2,20})/i.exec(candidate);
    if (languageMatch) {
      return languageMatch[1].toLowerCase();
    }
  }

  return '';
};

const serializeInlineChildren = (element: Element): string =>
  normalizeInlineWhitespace(
    Array.from(element.childNodes)
      .map((node) => serializeInlineNode(node))
      .join(''),
  );

const serializeInlineNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }

  if (!(node instanceof Element) || !isElementVisible(node) || isPrivateFormElement(node)) {
    return '';
  }

  const tag = node.tagName.toLowerCase();

  if (tag === 'br') {
    return '\n';
  }

  if (tag === 'code' && node.closest('pre')) {
    return visibleTextFromElement(node);
  }

  const content = serializeInlineChildren(node);
  if (!content) {
    if (tag === 'img') {
      return normalizeInlineWhitespace(node.getAttribute('alt') ?? '');
    }
    return '';
  }

  if (tag === 'a') {
    const href = node.getAttribute('href');
    return href && /^https?:\/\//i.test(href) ? `[${content}](${href})` : content;
  }

  if (tag === 'strong' || tag === 'b') {
    return `**${content}**`;
  }

  if (tag === 'em' || tag === 'i') {
    return `*${content}*`;
  }

  if (tag === 's' || tag === 'del') {
    return `~~${content}~~`;
  }

  if (tag === 'code') {
    return `\`${content}\``;
  }

  return content;
};

const serializeList = (element: Element, depth = 0): string => {
  const items = Array.from(element.children).filter(
    (child): child is HTMLElement => child.tagName.toLowerCase() === 'li',
  );
  const ordered = element.tagName.toLowerCase() === 'ol';

  return items
    .map((item, index) => {
      const prefix = ordered ? `${String(index + 1)}. ` : '- ';
      const indent = '  '.repeat(depth);
      const segments: string[] = [];
      const nestedBlocks: string[] = [];

      Array.from(item.childNodes).forEach((child) => {
        if (
          child instanceof Element &&
          blockTags.has(child.tagName.toLowerCase()) &&
          child.tagName.toLowerCase() !== 'code'
        ) {
          const serialized =
            child.tagName.toLowerCase() === 'ul' || child.tagName.toLowerCase() === 'ol'
              ? serializeList(child, depth + 1)
              : serializeElementMarkdown(child);
          if (serialized) {
            nestedBlocks.push(serialized);
          }
          return;
        }

        const inline = serializeInlineNode(child);
        if (inline) {
          segments.push(inline);
        }
      });

      const head = normalizeInlineWhitespace(segments.join(''));
      const lines = [`${indent}${prefix}${head}`.trimEnd()];
      nestedBlocks.forEach((block) => {
        const nestedIndent = `${indent}  `;
        lines.push(
          block
            .split('\n')
            .map((line) => (line ? `${nestedIndent}${line}` : nestedIndent))
            .join('\n'),
        );
      });

      return lines.join('\n');
    })
    .filter(Boolean)
    .join('\n');
};

const serializeTable = (element: Element): string => {
  const rows =
    element instanceof HTMLTableElement
      ? Array.from(element.rows)
      : Array.from(element.querySelectorAll('tr')).filter(
          (row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement,
        );

  const grid = rows
    .map((row) =>
      Array.from(row.cells).map((cell) =>
        escapeMarkdownTableCell(serializeInlineChildren(cell) || visibleTextFromElement(cell)),
      ),
    )
    .filter((row) => row.some(Boolean));

  if (grid.length === 0) {
    return '';
  }

  const header = grid[0];
  const body = grid.slice(1);
  const separator = header.map(() => '---');
  return [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
};

const serializeDefaultBlock = (element: Element): string => {
  const parts: string[] = [];
  let inlineBuffer = '';

  const flushInline = () => {
    const normalized = normalizeInlineWhitespace(inlineBuffer);
    if (normalized) {
      parts.push(normalized);
    }
    inlineBuffer = '';
  };

  Array.from(element.childNodes).forEach((child) => {
    if (
      child instanceof Element &&
      isElementVisible(child) &&
      blockTags.has(child.tagName.toLowerCase())
    ) {
      flushInline();
      const block = serializeElementMarkdown(child);
      if (block) {
        parts.push(block);
      }
      return;
    }

    inlineBuffer += serializeInlineNode(child);
  });

  flushInline();

  if (parts.length === 0) {
    return normalizeInlineWhitespace(serializeInlineChildren(element));
  }

  return collapseParagraphs(parts);
};

export const serializeElementMarkdown = (element: Element): string => {
  if (!isElementVisible(element) || isPrivateFormElement(element)) {
    return '';
  }

  const tag = element.tagName.toLowerCase();

  if (tag === 'pre') {
    const code = visibleTextFromElement(element);
    if (!code) {
      return '';
    }
    const language = codeLanguageFromElement(element);
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }

  if (tag === 'table') {
    return serializeTable(element);
  }

  if (tag === 'ul' || tag === 'ol') {
    return serializeList(element);
  }

  if (tag === 'blockquote') {
    const content = serializeDefaultBlock(element);
    return content
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');
  }

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const content = serializeInlineChildren(element);
    return content ? `${'#'.repeat(level)} ${content}` : '';
  }

  if (tag === 'hr') {
    return '---';
  }

  if (tag === 'p' || tag === 'summary' || tag === 'figcaption') {
    return serializeInlineChildren(element);
  }

  return serializeDefaultBlock(element);
};
