import type { CaptureEvent, CapturedTurn, ProviderId, SelectorCanary } from '../companion/model';
import {
  elementsForSelector,
  normalizeText,
  sortElementsInDocumentOrder,
  visibleTextFromElement,
} from './domUtils';
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
  readonly url?: string;
  readonly title?: string;
  readonly capturedAt?: string;
  readonly maxChars?: number;
}

type CaptureRole = CapturedTurn['role'];

interface CandidateTurn {
  role: CaptureRole;
  text: string;
  formattedText: string;
  sourceSelector: string;
}

interface ElementCandidate {
  readonly element: Element;
  readonly role: CaptureRole;
  readonly sourceSelector: string;
}

interface CandidateTurnSet {
  readonly sourceKind: 'direct' | 'structural';
  readonly turns: readonly CandidateTurn[];
}

const maxDefaultChars = 18_000;

const capText = (value: string, maxChars: number): string => {
  const normalized = normalizeText(value);
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars).trimEnd()}\n[truncated]`
    : normalized;
};

const inferRole = (rawValue: string | null | undefined): CaptureRole => {
  const value = (rawValue ?? '').toLowerCase();
  if (
    value.includes('assistant') ||
    value.includes('model') ||
    value.includes('claude') ||
    value.includes('gemini')
  ) {
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

const countMatchedPatterns = (value: string, patterns: readonly string[]): number =>
  patterns.reduce((count, pattern) => count + Number(new RegExp(pattern, 'i').test(value)), 0);

const countMatchedHeadingAnchors = (root: Element, source: HeadingTurnSourceConfig): number =>
  Array.from(root.querySelectorAll(source.selector)).reduce((count, heading) => {
    const label = normalizeText(visibleTextFromElement(heading) || heading.textContent || '');
    const matches = source.rolePatterns.some((pattern) =>
      new RegExp(pattern.pattern, 'i').test(label),
    );
    return count + Number(matches);
  }, 0);

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
    if (
      countMatchedPatterns(parentText, patterns) > 1 ||
      countMatchedHeadingAnchors(parent, source) > 1 ||
      parentText.length > maxAncestorChars
    ) {
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
  const tagRole = source.tagRoles?.[tagName];
  if (tagRole !== undefined) {
    return tagRole;
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
    .map((element, index) =>
      createCandidateTurn(
        element,
        directRoleForElement(element, index, source),
        source.sourceSelector,
      ),
    )
    .filter((turn): turn is CandidateTurn => turn !== null);

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

const extractHeadingCandidates = (
  doc: Document,
  source: HeadingTurnSourceConfig,
): ElementCandidate[] => {
  const candidates: ElementCandidate[] = [];

  elementsForSelector(doc, source.selector).forEach((heading) => {
    const label = normalizeText(visibleTextFromElement(heading) || heading.textContent || '');
    source.rolePatterns.forEach((pattern) => {
      if (!new RegExp(pattern.pattern, 'i').test(label)) {
        return;
      }
      pushElementCandidate(
        candidates,
        findHeadingTurnRoot(heading, source),
        pattern.role,
        source.sourceSelector,
      );
    });
  });

  return candidates;
};

const extractEditableCandidates = (
  doc: Document,
  source: EditableTurnSourceConfig,
): ElementCandidate[] =>
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

const compareCandidateTurnSets = (left: CandidateTurnSet, right: CandidateTurnSet): number => {
  const leftKnownRoles = new Set(
    left.turns.filter((turn) => turn.role !== 'unknown').map((turn) => turn.role),
  );
  const rightKnownRoles = new Set(
    right.turns.filter((turn) => turn.role !== 'unknown').map((turn) => turn.role),
  );

  const leftScore = [
    Number(leftKnownRoles.has('user') && leftKnownRoles.has('assistant')),
    leftKnownRoles.size,
    left.turns.filter((turn) => turn.role !== 'unknown').length,
    left.turns.length,
    Number(left.sourceKind === 'direct'),
    left.turns.reduce((sum, turn) => sum + turn.text.length, 0),
  ];
  const rightScore = [
    Number(rightKnownRoles.has('user') && rightKnownRoles.has('assistant')),
    rightKnownRoles.size,
    right.turns.filter((turn) => turn.role !== 'unknown').length,
    right.turns.length,
    Number(right.sourceKind === 'direct'),
    right.turns.reduce((sum, turn) => sum + turn.text.length, 0),
  ];

  for (let index = 0; index < leftScore.length; index += 1) {
    const delta = leftScore[index] - rightScore[index];
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
};

const extractConfiguredTurns = (
  doc: Document,
  config: ProviderExtractionConfig,
): CandidateTurn[] => {
  const turnSets: CandidateTurnSet[] = config.directSources
    .map((source) => ({
      sourceKind: 'direct' as const,
      turns: extractDirectTurns(doc, source),
    }))
    .filter((candidate) => candidate.turns.length > 0);

  const structuralCandidates = sortElementsInDocumentOrder([
    ...(config.headingSources?.flatMap((source) => extractHeadingCandidates(doc, source)) ?? []),
    ...(config.editableSources?.flatMap((source) => extractEditableCandidates(doc, source)) ?? []),
  ]);
  const structuralTurns = structuralCandidates
    .map((candidate) =>
      createCandidateTurn(candidate.element, candidate.role, candidate.sourceSelector),
    )
    .filter((turn): turn is CandidateTurn => turn !== null);

  if (structuralTurns.length > 0) {
    turnSets.push({
      sourceKind: 'structural',
      turns: structuralTurns,
    });
  }

  const bestTurns =
    turnSets.reduce<CandidateTurnSet | null>((best, candidate) => {
      if (!best || compareCandidateTurnSets(candidate, best) > 0) {
        return candidate;
      }
      return best;
    }, null)?.turns ?? [];

  return [...bestTurns];
};

const mergeAdjacentTurns = (
  turns: readonly CandidateTurn[],
  config: ProviderExtractionConfig,
): CandidateTurn[] => {
  if (!config.mergeAdjacentSameRoleTurns) {
    return [...turns];
  }

  const merged: CandidateTurn[] = [];
  for (const turn of turns) {
    const previous = merged.at(-1);
    if (previous?.role === turn.role && previous.sourceSelector === turn.sourceSelector) {
      previous.text = `${previous.text}\n\n${turn.text}`.trim();
      previous.formattedText = `${previous.formattedText}\n\n${turn.formattedText}`.trim();
      continue;
    }
    merged.push({ ...turn });
  }
  return merged;
};

const finalizeTurns = (
  turns: readonly CandidateTurn[],
  maxChars: number,
  config: ProviderExtractionConfig,
  capturedAt: string,
): CapturedTurn[] => {
  // Adjacent same-role merging is enough — never dedupe by text
  // globally. Two distinct assistant turns that happen to share text
  // (e.g. two short "OK" replies) are NOT duplicates; collapsing them
  // moves the surviving "last" turn to the wrong role and corrupts
  // the workboard pill. See extractors.test.ts regression case.
  const finalized: CapturedTurn[] = [];
  for (const turn of mergeAdjacentTurns(turns, config)) {
    const text = capText(turn.text, maxChars);
    if (!text) {
      continue;
    }
    finalized.push({
      role: turn.role,
      text,
      formattedText: turn.formattedText.trim() || text,
      ordinal: finalized.length,
      capturedAt,
      sourceSelector: turn.sourceSelector,
    });
  }
  return finalized;
};

const fallbackTurns = (doc: Document, maxChars: number, capturedAt: string): CapturedTurn[] => {
  const root = doc.querySelector('main') ?? doc.body;

  return finalizeTurns(
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
    capturedAt,
  );
};

const selectorState = (turns: readonly CapturedTurn[], usedFallback: boolean): SelectorCanary => {
  if (turns.length === 0) {
    return 'failed';
  }
  return usedFallback ? 'warning' : 'ok';
};

const threadIdFromUrl = (provider: ProviderId, rawUrl: string): string | undefined => {
  try {
    const url = new URL(rawUrl);
    if (provider === 'chatgpt') {
      const match = /\/(?:c|g\/[^/]+\/c)\/([^/?#]+)/.exec(url.pathname);
      return match?.[1];
    }
    if (provider === 'codex') {
      const match = /\/codex\/([^/?#]+)/.exec(url.pathname);
      return match?.[1];
    }
    if (provider === 'claude') {
      const match = /\/chat\/([^/?#]+)/.exec(url.pathname);
      return match?.[1];
    }
    if (provider === 'gemini') {
      const segments = url.pathname.split('/').filter(Boolean);
      return segments.at(-1);
    }
  } catch {
    return undefined;
  }
  return undefined;
};

// Look for a "Branched from <Title>" / "Forked from <Title>" indicator
// near the top of the conversation. We try a narrow selector list first
// (Claude renders it as a small chip/button); fall back to scanning the
// first ~32 elements of body text for the literal phrase.
//
// Returns the matched parent title, plus the parent URL when an anchor
// is co-located with the indicator (preferred for resolution).
const detectForkSource = (
  doc: Document,
): { readonly forkedFromTitle?: string; readonly forkedFromUrl?: string } => {
  const candidates = Array.from(
    doc.querySelectorAll(
      'a, button, [role="link"], [role="button"], header *, [class*="branch" i], [data-testid*="branch" i]',
    ),
  ).slice(0, 200);
  for (const node of candidates) {
    const text = node.textContent.trim();
    if (text.length === 0 || text.length > 200) continue;
    const match = /^(?:branched|forked)\s+from[:\s]+(.+)$/i.exec(text);
    if (match === null) continue;
    const title = match[1].trim().replace(/^["“]|["”]$/g, '');
    const anchor =
      node instanceof HTMLAnchorElement ? node : (node.closest('a') ?? node.querySelector('a'));
    const href =
      anchor instanceof HTMLAnchorElement && anchor.href.length > 0 ? anchor.href : undefined;
    return {
      ...(title.length === 0 ? {} : { forkedFromTitle: title }),
      ...(href === undefined ? {} : { forkedFromUrl: href }),
    };
  }
  return {};
};

export const captureVisibleConversation = (
  doc: Document,
  options: CaptureOptions = {},
): CaptureEvent => {
  const url = options.url ?? doc.location.href;
  const title = options.title ?? doc.title;
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const maxChars = options.maxChars ?? maxDefaultChars;
  const provider = detectProviderFromUrl(url);
  const config = providerConfigs[provider];

  let usedFallback = false;
  let turns = finalizeTurns(
    extractConfiguredTurns(doc, config),
    maxChars,
    config,
    capturedAt,
  );
  if (turns.length === 0) {
    usedFallback = true;
    turns = fallbackTurns(doc, maxChars, capturedAt);
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
  const forkSource = detectForkSource(doc);

  return {
    provider,
    threadId: threadIdFromUrl(provider, url),
    threadUrl: url,
    title,
    capturedAt,
    selectorCanary: selectorState(turns, usedFallback),
    extractionConfigVersion: config.version,
    visibleTextCharCount: visibleText.length,
    warnings,
    turns,
    ...forkSource,
  };
};

export { visibleTextFromElement } from './domUtils';
