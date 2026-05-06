export interface SerializedAnchor {
  readonly textQuote: {
    readonly exact: string;
    readonly prefix: string;
    readonly suffix: string;
  };
  readonly textPosition: {
    readonly start: number;
    readonly end: number;
  };
  readonly cssSelector: string;
}

const CONTEXT_CHARS = 32;

const textNodes = (root: Node): Text[] => {
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current !== null) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  return nodes;
};

const rootForRange = (range: Range): HTMLElement => {
  const doc = range.commonAncestorContainer.ownerDocument ?? document;
  return doc.body;
};

const textOffset = (root: Node, target: Node, offset: number): number => {
  let cursor = 0;
  for (const node of textNodes(root)) {
    if (node === target) {
      return cursor + offset;
    }
    cursor += node.data.length;
  }
  return cursor;
};

const cssPath = (element: Element | null): string => {
  if (element === null) {
    return 'body';
  }
  const parts: string[] = [];
  let currentElement: Element = element;
  for (;;) {
    const tag = currentElement.tagName.toLowerCase();
    const parent: Element | null = currentElement.parentElement;
    if (parent === null) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter(
      (child): child is Element => child.tagName === currentElement.tagName,
    );
    const suffix =
      siblings.length <= 1
        ? ''
        : `:nth-of-type(${String(siblings.indexOf(currentElement) + 1)})`;
    parts.unshift(`${tag}${suffix}`);
    currentElement = parent;
  }
  return parts.join(' > ');
};

const rangeAtTextOffsets = (root: Node, start: number, end: number): Range | null => {
  const doc = root.ownerDocument ?? document;
  const range = doc.createRange();
  let cursor = 0;
  let didStart = false;
  for (const node of textNodes(root)) {
    const next = cursor + node.data.length;
    if (!didStart && start >= cursor && start <= next) {
      range.setStart(node, start - cursor);
      didStart = true;
    }
    if (didStart && end >= cursor && end <= next) {
      range.setEnd(node, end - cursor);
      return range;
    }
    cursor = next;
  }
  return null;
};

export const serializeAnchor = (range: Range): SerializedAnchor => {
  const root = rootForRange(range);
  const fullText = root.textContent;
  const start = textOffset(root, range.startContainer, range.startOffset);
  const end = textOffset(root, range.endContainer, range.endOffset);
  const exact = range.toString();
  return {
    textQuote: {
      exact,
      prefix: fullText.slice(Math.max(0, start - CONTEXT_CHARS), start),
      suffix: fullText.slice(end, Math.min(fullText.length, end + CONTEXT_CHARS)),
    },
    textPosition: { start, end },
    cssSelector:
      range.startContainer instanceof Element
        ? cssPath(range.startContainer)
        : cssPath(range.startContainer.parentElement),
  };
};

// Normalize a string for cross-source matching. Markdown bodies (e.g.
// from bac.turns) carry decorations the live DOM textContent doesn't
// have: `**bold**`, `_italic_`, ``code``, `> quote`, `# heading`, and
// — most aggressively — paragraph breaks materialize as `\n\n` in
// markdown but as nothing in textContent (because the DOM uses
// block-element boundaries, not literal newlines, and textContent
// concatenates without inserting whitespace).
//
// We strip the markdown punctuation, drop ALL whitespace (so the
// `\n\n` paragraph separators in MCP-saved anchors don't have to
// match the live DOM's zero-width block boundary), and lowercase
// everything. This makes the comparison structural rather than
// presentational. Risk: false positives like "thecat" matching
// "the cat" — acceptable for our 32-char anchor windows where
// surrounding 30+ chars provide plenty of disambiguation.
const stripMarkdownFormatting = (input: string): string =>
  input
    .replace(/[*_`~#>]/g, '')
    .replace(/\\([*_`~#>])/g, '$1')
    .replace(/\s+/g, '')
    .toLowerCase();

export const findAnchor = (root: HTMLElement, anchor: SerializedAnchor): Range | null => {
  try {
    const fullText = root.textContent;
    const exact = anchor.textQuote.exact;
    if (exact.length > 0) {
      const expectedPrefixRaw = anchor.textQuote.prefix;
      const expectedSuffixRaw = anchor.textQuote.suffix;
      const expectedPrefixNorm = stripMarkdownFormatting(expectedPrefixRaw);
      const expectedSuffixNorm = stripMarkdownFormatting(expectedSuffixRaw);
      let from = 0;
      while (from <= fullText.length) {
        const index = fullText.indexOf(exact, from);
        if (index < 0) {
          break;
        }
        const prefix = fullText.slice(Math.max(0, index - CONTEXT_CHARS), index);
        const suffix = fullText.slice(index + exact.length, index + exact.length + CONTEXT_CHARS);
        // Try raw match first (fast path for browser-created anchors
        // where prefix/suffix already came from textContent). Fall
        // back to a markdown-normalized comparison so MCP-created
        // anchors from rendered markdown bodies still re-anchor.
        const prefixOk =
          expectedPrefixRaw.length === 0 ||
          prefix.endsWith(expectedPrefixRaw) ||
          stripMarkdownFormatting(prefix).endsWith(expectedPrefixNorm);
        const suffixOk =
          expectedSuffixRaw.length === 0 ||
          suffix.startsWith(expectedSuffixRaw) ||
          stripMarkdownFormatting(suffix).startsWith(expectedSuffixNorm);
        if (prefixOk && suffixOk) {
          return rangeAtTextOffsets(root, index, index + exact.length);
        }
        from = index + 1;
      }
    }

    if (anchor.textPosition.start >= 0 && anchor.textPosition.end >= 0) {
      const positionRange = rangeAtTextOffsets(
        root,
        anchor.textPosition.start,
        anchor.textPosition.end,
      );
      if (positionRange !== null) {
        return positionRange;
      }
    }

    if (anchor.cssSelector.length > 0) {
      const element = root.querySelector(anchor.cssSelector);
      if (element !== null) {
        const fallback = rangeAtTextOffsets(element, 0, element.textContent.length);
        if (fallback !== null) {
          return fallback;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
};
