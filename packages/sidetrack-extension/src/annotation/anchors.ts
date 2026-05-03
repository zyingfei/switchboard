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

export const findAnchor = (root: HTMLElement, anchor: SerializedAnchor): Range | null => {
  try {
    const fullText = root.textContent;
    const exact = anchor.textQuote.exact;
    if (exact.length > 0) {
      let from = 0;
      while (from <= fullText.length) {
        const index = fullText.indexOf(exact, from);
        if (index < 0) {
          break;
        }
        const prefix = fullText.slice(Math.max(0, index - CONTEXT_CHARS), index);
        const suffix = fullText.slice(index + exact.length, index + exact.length + CONTEXT_CHARS);
        const prefixOk =
          anchor.textQuote.prefix.length === 0 || prefix.endsWith(anchor.textQuote.prefix);
        const suffixOk =
          anchor.textQuote.suffix.length === 0 || suffix.startsWith(anchor.textQuote.suffix);
        if (prefixOk && suffixOk) {
          return rangeAtTextOffsets(root, index, index + exact.length);
        }
        from = index + 1;
      }
    }

    const positionRange = rangeAtTextOffsets(
      root,
      anchor.textPosition.start,
      anchor.textPosition.end,
    );
    if (positionRange !== null) {
      return positionRange;
    }

    const element = root.querySelector(anchor.cssSelector);
    if (element !== null) {
      const fallback = rangeAtTextOffsets(element, 0, element.textContent.length);
      if (fallback !== null) {
        return fallback;
      }
    }
    return null;
  } catch {
    return null;
  }
};
