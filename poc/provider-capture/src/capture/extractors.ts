import { createCaptureId } from '../shared/ids';
import { nowIso } from '../shared/time';
import {
  elementsForSelector,
  normalizeText,
  sortElementsInDocumentOrder,
  visibleTextFromElement,
} from './domUtils';
import type { CapturedTurn, CaptureRole, ProviderCapture, ProviderId, SelectorCanary } from './model';
import { detectProviderFromUrl } from './providerDetection';
import { providerConfigs } from './providerConfigs';
import type {
  DirectTurnSourceConfig,
  EditableTurnSourceConfig,
  HeadingTurnSourceConfig,
  ProviderExtractionConfig,
} from './providerConfigs/types';
import { buildCaptureWarnings } from './redaction';
import { serializeElementMarkdown } from './structuredMarkdown';

export interface CaptureOptions {
  url?: string;
  title?: string;
  capturedAt?: string;
  maxChars?: number;
}

interface CandidateTurn {
  role: CaptureRole;
  text: string;
  formattedText: string;
  sourceSelector: string;
}

interface ElementCandidate {
  element: Element;
  role: CaptureRole;
  sourceSelector: string;
}

const maxDefaultChars = 18_000;

const capText = (value: string, maxChars: number): string => {
  const normalized = normalizeText(value);
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars).trimEnd()}\n[truncated]` : normalized;
};

const inferRole = (rawValue: string | null | undefined): CaptureRole => {
  const value = (rawValue ?? '').toLowerCase();
  if (value.includes('assistant') || value.includes('model') || value.includes('claude') || value.includes('gemini')) {
    return 'assistant';
  }
  if (value.includes('user') || value.includes('human') || value.includes('you')) {
    return 'user';
  }
  if (value.includes('system')) {
    return 'system';
  }
  return 'unknown';
};

const countMatchedPatterns = (value: string, patterns: string[]): number =>
  patterns.reduce((count, pattern) => count + Number(new RegExp(pattern, 'i').test(value)), 0);

const findHeadingTurnRoot = (anchor: Element, source: HeadingTurnSourceConfig): Element => {
  let best = anchor.parentElement ?? anchor;
  let current = best;

  while (current.parentElement && current.parentElement !== current.ownerDocument.body) {
    const parent = current.parentElement;
    const parentText = visibleTextFromElement(parent);
    if (!parentText) {
      break;
    }

    const patterns = source.rolePatterns.map((pattern) => pattern.pattern);
    const maxAncestorChars = source.maxAncestorChars ?? 12_000;
    if (countMatchedPatterns(parentText, patterns) > 1 || parentText.length > maxAncestorChars) {
      break;
    }

    best = parent;
    current = parent;
  }

  return best;
};

const directRoleForElement = (
  element: Element,
  index: number,
  source: DirectTurnSourceConfig,
): CaptureRole => {
  const tagName = element.tagName.toLowerCase();
  if (source.tagRoles?.[tagName]) {
    return source.tagRoles[tagName];
  }

  if (source.role !== 'infer') {
    return source.role;
  }

  const attrValue = source.roleAttributes
    ?.map((attribute) => element.getAttribute(attribute))
    .find((value) => typeof value === 'string' && value.length > 0);
  if (attrValue) {
    return inferRole(attrValue);
  }

  if (source.alternatingRoles) {
    return source.alternatingRoles[index % 2];
  }

  return 'unknown';
};

const createCandidateTurn = (
  element: Element,
  role: CaptureRole,
  sourceSelector: string,
): CandidateTurn | null => {
  const text = visibleTextFromElement(element);
  if (!text) {
    return null;
  }

  const formattedText = serializeElementMarkdown(element) || text;
  return {
    role,
    text,
    formattedText,
    sourceSelector,
  };
};

const extractDirectTurns = (doc: Document, source: DirectTurnSourceConfig): CandidateTurn[] =>
  elementsForSelector(doc, source.selector, { filterNestedMatches: source.filterNestedMatches })
    .map((element, index) => createCandidateTurn(element, directRoleForElement(element, index, source), source.sourceSelector))
    .filter((turn): turn is CandidateTurn => Boolean(turn));

const pushElementCandidate = (
  candidates: ElementCandidate[],
  element: Element | null | undefined,
  role: CaptureRole,
  sourceSelector: string,
) => {
  if (!element) {
    return;
  }

  if (candidates.some((candidate) => candidate.element === element && candidate.role === role)) {
    return;
  }

  candidates.push({ element, role, sourceSelector });
};

const extractHeadingCandidates = (doc: Document, source: HeadingTurnSourceConfig): ElementCandidate[] => {
  const candidates: ElementCandidate[] = [];

  elementsForSelector(doc, source.selector).forEach((heading) => {
    const label = normalizeText(visibleTextFromElement(heading) || heading.textContent || '');
    source.rolePatterns.forEach((pattern) => {
      if (!new RegExp(pattern.pattern, 'i').test(label)) {
        return;
      }
      pushElementCandidate(candidates, findHeadingTurnRoot(heading, source), pattern.role, source.sourceSelector);
    });
  });

  return candidates;
};

const extractEditableCandidates = (doc: Document, source: EditableTurnSourceConfig): ElementCandidate[] =>
  elementsForSelector(doc, source.selector)
    .filter((element) => {
      const text = visibleTextFromElement(element);
      if (text.length < source.minTextLength) {
        return false;
      }
      return source.excludePattern ? !new RegExp(source.excludePattern, 'i').test(text) : true;
    })
    .map((element) => ({
      element,
      role: source.role,
      sourceSelector: source.sourceSelector,
    }));

const extractConfiguredTurns = (doc: Document, config: ProviderExtractionConfig): CandidateTurn[] => {
  for (const source of config.directSources) {
    const directTurns = extractDirectTurns(doc, source);
    if (directTurns.length > 0) {
      return directTurns;
    }
  }

  const candidates = sortElementsInDocumentOrder([
    ...(config.headingSources?.flatMap((source) => extractHeadingCandidates(doc, source)) ?? []),
    ...(config.editableSources?.flatMap((source) => extractEditableCandidates(doc, source)) ?? []),
  ]);

  return candidates
    .map((candidate) => createCandidateTurn(candidate.element, candidate.role, candidate.sourceSelector))
    .filter((turn): turn is CandidateTurn => Boolean(turn));
};

const mergeAdjacentTurns = (turns: CandidateTurn[], config: ProviderExtractionConfig): CandidateTurn[] => {
  if (!config.mergeAdjacentSameRoleTurns) {
    return turns;
  }

  const merged: CandidateTurn[] = [];
  for (const turn of turns) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.role === turn.role &&
      previous.sourceSelector === turn.sourceSelector
    ) {
      previous.text = `${previous.text}\n\n${turn.text}`.trim();
      previous.formattedText = `${previous.formattedText}\n\n${turn.formattedText}`.trim();
      continue;
    }
    merged.push({ ...turn });
  }
  return merged;
};

const dedupeAndFinalizeTurns = (
  turns: CandidateTurn[],
  maxChars: number,
  config: ProviderExtractionConfig,
): CapturedTurn[] => {
  const seen = new Set<string>();
  const finalized: CapturedTurn[] = [];

  for (const turn of mergeAdjacentTurns(turns, config)) {
    const text = capText(turn.text, maxChars);
    if (!text) {
      continue;
    }
    const key = `${turn.role}:${text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    finalized.push({
      id: `turn-${finalized.length + 1}`,
      role: turn.role,
      text,
      formattedText: turn.formattedText.trim() || text,
      ordinal: finalized.length,
      sourceSelector: turn.sourceSelector,
    });
  }

  return finalized;
};

const fallbackTurns = (doc: Document, maxChars: number): CapturedTurn[] => {
  const root = doc.querySelector('main') ?? doc.body;
  if (!root) {
    return [];
  }

  return dedupeAndFinalizeTurns(
    [
      {
        role: 'unknown',
        text: capText(visibleTextFromElement(root), maxChars),
        formattedText: serializeElementMarkdown(root) || visibleTextFromElement(root),
        sourceSelector: 'visible main/body fallback',
      },
    ],
    maxChars,
    providerConfigs.unknown,
  );
};

export const captureVisibleConversation = (
  doc: Document,
  options: CaptureOptions = {},
): ProviderCapture => {
  const url = options.url ?? doc.location?.href ?? '';
  const title = options.title ?? doc.title ?? 'Untitled page';
  const capturedAt = options.capturedAt ?? nowIso();
  const maxChars = options.maxChars ?? maxDefaultChars;
  const provider = detectProviderFromUrl(url);
  const config = providerConfigs[provider];

  let selectorCanary: SelectorCanary = 'failed';
  let turns = dedupeAndFinalizeTurns(extractConfiguredTurns(doc, config), maxChars, config);
  if (turns.length > 0) {
    selectorCanary = 'passed';
  }

  if (turns.length === 0) {
    turns = fallbackTurns(doc, maxChars);
    selectorCanary = turns.length > 0 ? 'fallback' : 'failed';
  }

  const visibleText = turns.map((turn) => turn.text).join('\n\n');
  const warnings = buildCaptureWarnings(visibleText, url);
  if (provider === 'unknown') {
    warnings.push({
      code: 'unsupported_provider',
      message: 'Provider is unknown; capture used conservative visible-text selectors.',
      severity: 'info',
    });
  }

  return {
    id: createCaptureId(provider, capturedAt, `${url}\n${title}\n${visibleText}`),
    provider,
    url,
    title,
    capturedAt,
    extractionConfigVersion: config.version,
    selectorCanary,
    turns,
    artifacts: [],
    warnings,
    visibleTextCharCount: visibleText.length,
  };
};

export { visibleTextFromElement } from './domUtils';
