import { Readability } from '@mozilla/readability';

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
  readonly trigger:
    | 'manual'
    | 'workstream-policy'
    | 'save-suggestion'
    | 'allowlist'
    | 'attention-gate'
    | 'bulk-open-tabs';
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

/**
 * Internal candidate produced by a single extraction strategy. `strategy`
 * stays within the existing {@link PageContentExtractionStrategy} union so the
 * companion's quality classifier and coverage projection are unchanged — the
 * Readability strategy reports itself as `reader-mode` (it is a higher-fidelity
 * reader-mode extractor of the same conceptual strategy).
 */
interface ExtractionCandidate {
  readonly text: string;
  readonly strategy: PageContentExtractionStrategy;
  readonly contentToDomRatio: number;
  readonly boilerplateFraction: number;
}

const QUALITY_TIER_RANK: Readonly<Record<PageContentQuality, number>> = {
  high: 2,
  medium: 1,
  low: 0,
};

// Deterministic tiebreak when two candidates land in the same quality tier.
const STRATEGY_PRIORITY: Readonly<Record<PageContentExtractionStrategy, number>> = {
  'manual-selection': 3,
  'reader-mode': 2,
  'visible-dom': 1,
};

const candidateSignals = (candidate: ExtractionCandidate): PageContentQualitySignals => ({
  extractedWordCount: wordCount(candidate.text),
  contentToDomRatio: Number(candidate.contentToDomRatio.toFixed(4)),
  boilerplateFraction: Number(candidate.boilerplateFraction.toFixed(4)),
  extractionStrategy: candidate.strategy,
});

/**
 * Ensemble selector: pick the candidate that maximizes the quality tier the
 * companion would assign (mirrors `classifyPageContentQuality` thresholds via
 * the local {@link classifyQuality}). Deterministic tiebreak inside a tier:
 * higher word count, then strategy priority, then longer text, then earlier
 * insertion order. Returns `null` when no candidate has any text so callers
 * fall back to the prior single-strategy behavior with zero regression.
 */
const selectBestCandidate = (
  candidates: readonly ExtractionCandidate[],
): ExtractionCandidate | null => {
  const usable = candidates.filter((candidate) => candidate.text.length > 0);
  if (usable.length === 0) return null;
  return usable.reduce((best, candidate) => {
    const bestTier = QUALITY_TIER_RANK[classifyQuality(candidateSignals(best))];
    const candidateTier = QUALITY_TIER_RANK[classifyQuality(candidateSignals(candidate))];
    if (candidateTier !== bestTier) return candidateTier > bestTier ? candidate : best;
    const bestWords = wordCount(best.text);
    const candidateWords = wordCount(candidate.text);
    if (candidateWords !== bestWords) return candidateWords > bestWords ? candidate : best;
    const bestStrategy = STRATEGY_PRIORITY[best.strategy];
    const candidateStrategy = STRATEGY_PRIORITY[candidate.strategy];
    if (candidateStrategy !== bestStrategy) {
      return candidateStrategy > bestStrategy ? candidate : best;
    }
    if (candidate.text.length !== best.text.length) {
      return candidate.text.length > best.text.length ? candidate : best;
    }
    return best;
  });
};

/**
 * Run Mozilla Readability over a clone of the live document. Readability
 * mutates the document it parses, so we always clone first. Returns `null`
 * when Readability declines or throws — the ensemble then degrades to the
 * existing heuristic + visible-dom candidates (zero regression).
 */
const readabilityCandidate = (domTextLength: number): ExtractionCandidate | null => {
  try {
    const cloned = document.cloneNode(true) as Document;
    const article = new Readability(cloned).parse();
    const text = normalizeWhitespace(article?.textContent ?? '');
    if (text.length === 0) return null;
    return {
      text,
      strategy: 'reader-mode',
      contentToDomRatio: domTextLength === 0 ? 1 : text.length / domTextLength,
      boilerplateFraction: repeatedLineFraction(text),
    };
  } catch {
    return null;
  }
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
  const headingHash = await headingSignature();
  const headingHashPart = headingHash === undefined ? {} : { headingSignatureHash: headingHash };

  // Ensemble: gather every strategy that yields output, then pick the
  // candidate that maximizes the quality tier the companion would assign.
  const candidates: ExtractionCandidate[] = [];
  const reader = pickReaderElement();
  if (reader !== null) {
    const readerText = normalizeWhitespace(visibleText(reader));
    if (readerText.length > 0) {
      candidates.push({
        text: readerText,
        strategy: 'reader-mode',
        contentToDomRatio: domText.length === 0 ? 1 : readerText.length / domText.length,
        boilerplateFraction: repeatedLineFraction(readerText),
      });
    }
  }
  const readability = readabilityCandidate(domText.length);
  if (readability !== null) candidates.push(readability);
  if (domText.length > 0) {
    candidates.push({
      text: domText,
      strategy: 'visible-dom',
      contentToDomRatio: 1,
      boilerplateFraction: repeatedLineFraction(domText),
    });
  }

  const best = selectBestCandidate(candidates);
  if (best !== null) {
    return {
      text: best.text,
      strategy: best.strategy,
      contentToDomRatio: best.contentToDomRatio,
      boilerplateFraction: best.boilerplateFraction,
      ...headingHashPart,
    };
  }

  // Zero-regression fallback: no strategy produced text — preserve the prior
  // visible-dom shape (empty text triggers the existing "no readable text"
  // error path downstream).
  return {
    text: domText,
    strategy: 'visible-dom',
    contentToDomRatio: 1,
    boilerplateFraction: repeatedLineFraction(domText),
    ...headingHashPart,
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
