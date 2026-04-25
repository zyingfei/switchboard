const inlineWhitespacePattern = /[ \t\r\f\v]+/g;

export const normalizeText = (value: string): string =>
  value
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const normalizeInlineWhitespace = (value: string): string =>
  value
    .replace(/\u00a0/g, ' ')
    .replace(inlineWhitespacePattern, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const isPrivateFormElement = (element: Element): boolean =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLTextAreaElement ||
  element instanceof HTMLSelectElement;

export const isElementVisible = (element: Element): boolean => {
  if (element.closest('[aria-hidden="true"], [hidden]')) {
    return false;
  }

  if (element instanceof HTMLInputElement && element.type === 'hidden') {
    return false;
  }

  const win = element.ownerDocument.defaultView;
  if (!win) {
    return true;
  }

  let current: Element | null = element;
  while (current) {
    const style = win.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    current = current.parentElement;
  }
  return true;
};

export const visibleTextFromElement = (element: Element): string => {
  if (!isElementVisible(element)) {
    return '';
  }

  const doc = element.ownerDocument;
  const win = doc.defaultView;
  const nodeFilter = win?.NodeFilter;
  const walker = doc.createTreeWalker(
    element,
    nodeFilter?.SHOW_TEXT ?? 4,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !isElementVisible(parent) || isPrivateFormElement(parent)) {
          return nodeFilter?.FILTER_REJECT ?? 2;
        }
        return normalizeText(node.textContent ?? '')
          ? nodeFilter?.FILTER_ACCEPT ?? 1
          : nodeFilter?.FILTER_REJECT ?? 2;
      },
    },
  );

  const chunks: string[] = [];
  let current = walker.nextNode();
  while (current) {
    const text = normalizeText(current.textContent ?? '');
    if (text) {
      chunks.push(text);
    }
    current = walker.nextNode();
  }

  return normalizeText(chunks.join('\n'));
};

export const filterNestedMatches = (elements: Element[]): Element[] => {
  const candidates = elements.filter(isElementVisible);
  const set = new Set(candidates);

  return candidates.filter((element) => {
    let current = element.parentElement;
    while (current) {
      if (set.has(current)) {
        return false;
      }
      current = current.parentElement;
    }
    return true;
  });
};

export const elementsForSelector = (
  doc: Document,
  selector: string,
  opts: { filterNestedMatches?: boolean } = {},
): Element[] => {
  const matches = Array.from(doc.querySelectorAll(selector)).filter(isElementVisible);
  return opts.filterNestedMatches ? filterNestedMatches(matches) : matches;
};

export const sortElementsInDocumentOrder = <T extends { element: Element }>(candidates: T[]): T[] =>
  [...candidates].sort((left, right) => {
    if (left.element === right.element) {
      return 0;
    }

    const position = left.element.compareDocumentPosition(right.element);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }
    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }
    return 0;
  });
