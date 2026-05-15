import type {
  PageContentExtractedPayload,
  PageContentExtractionStrategy,
  PageContentQuality,
  PageContentQualitySignals,
} from '../companion/pageContentClient';
import { canonicalThreadUrl } from '../capture/providerDetection';

export const PAGE_INDEX_SETTLE_DEBOUNCE_MS = 800;
export const PAGE_INDEX_SETTLE_TIMEOUT_MS = 8_000;

export type PageContentExtractionMode = 'page' | 'selection';

export interface PageContentExtractRequest {
  readonly mode: PageContentExtractionMode;
  readonly trigger: 'manual' | 'bulk-open-tabs';
}

export type PageContentExtractResponse =
  | { readonly ok: true; readonly payload: PageContentExtractedPayload }
  | { readonly ok: false; readonly error: string };

const normalizeWhitespace = (input: string): string =>
  input
    .replace(/\u00a0/gu, ' ')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();

const visibleText = (element: Element): string => {
  const style = window.getComputedStyle(element);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0' ||
    element.getAttribute('aria-hidden') === 'true'
  ) {
    return '';
  }
  return (element as HTMLElement).innerText ?? element.textContent ?? '';
};

const candidateMainElements = (): readonly HTMLElement[] =>
  [
    ...Array.from(document.querySelectorAll<HTMLElement>('article, main, [role="main"]')),
    ...Array.from(document.querySelectorAll<HTMLElement>('section, .content, #content')),
  ].filter((element) => visibleText(element).trim().length > 0);

const pickReaderElement = (): HTMLElement | null => {
  const candidates = candidateMainElements();
  if (candidates.length === 0) return null;
  return (
    candidates
      .map((element) => {
        const text = normalizeWhitespace(visibleText(element));
        const linkText = Array.from(element.querySelectorAll('a'))
          .map((a) => a.textContent ?? '')
          .join(' ');
        const linkRatio = text.length === 0 ? 1 : linkText.length / text.length;
        const headingCount = element.querySelectorAll('h1,h2,h3').length;
        const score = text.length * (1 - Math.min(0.8, linkRatio)) + headingCount * 500;
        return { element, score };
      })
      .sort((left, right) => right.score - left.score)[0]?.element ?? null
  );
};

const repeatedLineFraction = (text: string): number => {
  const lines = text
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length >= 3);
  if (lines.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const repeated = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  return repeated / lines.length;
};

const headingSignature = async (): Promise<string | undefined> => {
  const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
    .map((node) => normalizeWhitespace(node.textContent ?? '').toLowerCase())
    .filter((text) => text.length > 0)
    .slice(0, 16)
    .join('\n');
  if (headings.length === 0) return undefined;
  return await sha256Hex(headings);
};

const wordCount = (text: string): number =>
  text.split(/\s+/u).filter((token) => token.trim().length > 0).length;

const classifyQuality = (signals: PageContentQualitySignals): PageContentQuality => {
  if (
    signals.extractedWordCount >= 300 &&
    signals.contentToDomRatio >= 0.4 &&
    (signals.extractionStrategy === 'reader-mode' ||
      signals.extractionStrategy === 'manual-selection')
  ) {
    return 'high';
  }
  if (
    signals.extractedWordCount >= 100 &&
    (signals.contentToDomRatio >= 0.2 || signals.boilerplateFraction <= 0.35)
  ) {
    return 'medium';
  }
  return 'low';
};

const hasSensitiveEditableState = (): boolean => {
  const password = document.querySelector('input[type="password"]');
  if (password !== null) return true;
  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLElement && active.isContentEditable)
  ) {
    const value =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? active.value
        : (active.textContent ?? '');
    return value.trim().length > 0;
  }
  return false;
};

export const sha256Hex = async (input: string): Promise<string> => {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const extractTextNow = async (
  mode: PageContentExtractionMode,
): Promise<{
  readonly text: string;
  readonly strategy: PageContentExtractionStrategy;
  readonly contentToDomRatio: number;
  readonly boilerplateFraction: number;
  readonly headingSignatureHash?: string;
}> => {
  const domText = normalizeWhitespace(
    document.body?.innerText ?? document.documentElement.innerText ?? '',
  );
  if (mode === 'selection') {
    const selection = normalizeWhitespace(window.getSelection()?.toString() ?? '');
    return {
      text: selection,
      strategy: 'manual-selection',
      contentToDomRatio: domText.length === 0 ? 1 : selection.length / domText.length,
      boilerplateFraction: 0,
      ...(await headingSignature().then((hash) =>
        hash === undefined ? {} : { headingSignatureHash: hash },
      )),
    };
  }
  const reader = pickReaderElement();
  if (reader !== null) {
    const text = normalizeWhitespace(visibleText(reader));
    return {
      text,
      strategy: 'reader-mode',
      contentToDomRatio: domText.length === 0 ? 1 : text.length / domText.length,
      boilerplateFraction: repeatedLineFraction(text),
      ...(await headingSignature().then((hash) =>
        hash === undefined ? {} : { headingSignatureHash: hash },
      )),
    };
  }
  return {
    text: domText,
    strategy: 'visible-dom',
    contentToDomRatio: 1,
    boilerplateFraction: repeatedLineFraction(domText),
    ...(await headingSignature().then((hash) =>
      hash === undefined ? {} : { headingSignatureHash: hash },
    )),
  };
};

export const settleAndExtractPageContent = async (
  request: PageContentExtractRequest,
): Promise<PageContentExtractResponse> => {
  if (hasSensitiveEditableState()) {
    return {
      ok: false,
      error: 'Page has active sensitive form state; page-content indexing skipped.',
    };
  }
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
    return { ok: false, error: 'Page-content indexing only supports HTTP(S) pages.' };
  }

  await new Promise<void>((resolve) => {
    let timer = window.setTimeout(resolve, PAGE_INDEX_SETTLE_DEBOUNCE_MS);
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        observer.disconnect();
        resolve();
      }, PAGE_INDEX_SETTLE_DEBOUNCE_MS);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.setTimeout(() => {
      observer.disconnect();
      resolve();
    }, PAGE_INDEX_SETTLE_TIMEOUT_MS);
  });

  const extracted = await extractTextNow(request.mode);
  if (extracted.text.length === 0) {
    return {
      ok: false,
      error:
        request.mode === 'selection'
          ? 'No selected text to index.'
          : 'No readable page text found.',
    };
  }
  const extractedWordCount = wordCount(extracted.text);
  const qualitySignals: PageContentQualitySignals = {
    extractedWordCount,
    contentToDomRatio: Number(extracted.contentToDomRatio.toFixed(4)),
    boilerplateFraction: Number(extracted.boilerplateFraction.toFixed(4)),
    extractionStrategy: extracted.strategy,
    ...(extracted.headingSignatureHash === undefined
      ? {}
      : { headingSignatureHash: extracted.headingSignatureHash }),
  };
  const contentHash = await sha256Hex(extracted.text);
  const payload: PageContentExtractedPayload = {
    payloadVersion: 1,
    canonicalUrl: canonicalThreadUrl(window.location.href),
    url: window.location.href,
    title: document.title,
    provider: 'unknown',
    extractedAt: new Date().toISOString(),
    extractionSource: extracted.strategy,
    extractionPolicy: { trigger: request.trigger },
    quality: classifyQuality(qualitySignals),
    qualitySignals,
    content: {
      text: extracted.text,
      contentHash,
      charCount: extracted.text.length,
    },
    redaction: { applied: false, rules: [] },
  };
  return { ok: true, payload };
};
