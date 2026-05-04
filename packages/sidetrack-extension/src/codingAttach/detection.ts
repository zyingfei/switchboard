export interface CodingSurface {
  readonly id: 'claude_code' | 'codex' | 'cursor';
  readonly signals: { readonly urlMatch: boolean; readonly domHint: boolean };
  readonly confidence: 'high' | 'medium' | 'low';
}

const confidenceFor = (urlMatch: boolean, domHint: boolean): CodingSurface['confidence'] =>
  urlMatch && domHint ? 'high' : urlMatch ? 'medium' : 'low';

const hasText = (document: Document, pattern: RegExp): boolean =>
  pattern.test(document.body.textContent);

export const detectCodingSurface = (url: string, document: Document): CodingSurface | null => {
  const codexUrl = /^https:\/\/chatgpt\.com\/codex(?:\/|$)/u.test(url);
  const codexDom = hasText(document, /\b(Codex|workspace|diff|branch)\b/iu);
  if (codexUrl || codexDom) {
    return {
      id: 'codex',
      signals: { urlMatch: codexUrl, domHint: codexDom },
      confidence: confidenceFor(codexUrl, codexDom),
    };
  }

  const claudeUrl = /^https:\/\/claude\.ai\/code(?:\/|$)/u.test(url);
  const claudeDom = hasText(document, /\b(Claude Code|repository|terminal)\b/iu);
  if (claudeUrl || claudeDom) {
    return {
      id: 'claude_code',
      signals: { urlMatch: claudeUrl, domHint: claudeDom },
      confidence: confidenceFor(claudeUrl, claudeDom),
    };
  }

  // Cursor's cloud agent URL is still settling; keep DOM-only detection low
  // confidence until a stable production URL pattern exists.
  const cursorUrl = /^https:\/\/(?:www\.)?cursor\.com\//u.test(url);
  const cursorDom = hasText(document, /\b(Cursor|agent|workspace)\b/iu);
  if (cursorUrl || cursorDom) {
    return {
      id: 'cursor',
      signals: { urlMatch: cursorUrl, domHint: cursorDom },
      confidence: confidenceFor(cursorUrl, cursorDom),
    };
  }
  return null;
};
