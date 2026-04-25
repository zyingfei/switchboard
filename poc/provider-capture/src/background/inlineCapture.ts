import type { CapturedArtifact, ProviderCapture } from '../capture/model';
import { providerConfigs } from '../capture/providerConfigs';
import type { ProviderConfigRegistry } from '../capture/providerConfigs';

interface InlineDiscoveredLink {
  label: string;
  url: string;
}

interface InlineFrameCaptureResult {
  capture: ProviderCapture;
  discoveredLinks: InlineDiscoveredLink[];
}

const inlineCaptureVisibleConversation = (registry: ProviderConfigRegistry): InlineFrameCaptureResult => {
  type Role = 'user' | 'assistant' | 'system' | 'unknown';
  type Provider = 'chatgpt' | 'claude' | 'gemini' | 'unknown';
  type DirectSource = ProviderConfigRegistry[Provider]['directSources'][number];
  type HeadingSource = NonNullable<ProviderConfigRegistry[Provider]['headingSources']>[number];
  type EditableSource = NonNullable<ProviderConfigRegistry[Provider]['editableSources']>[number];

  const normalizeText = (value: string): string =>
    value
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const normalizeInlineWhitespace = (value: string): string =>
    value
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\r\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const providerFromUrl = (href: string): Provider => {
    try {
      const url = new URL(href);
      const fixtureProvider = url.searchParams.get('provider');
      if (fixtureProvider === 'chatgpt' || fixtureProvider === 'claude' || fixtureProvider === 'gemini') {
        return fixtureProvider;
      }
      if (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') {
        return 'chatgpt';
      }
      if (url.hostname === 'claude.ai') {
        return 'claude';
      }
      if (url.hostname === 'gemini.google.com') {
        return 'gemini';
      }
    } catch {
      return 'unknown';
    }
    return 'unknown';
  };

  const inferRole = (rawValue: string | null | undefined): Role => {
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

  const isPrivateFormElement = (element: Element): boolean =>
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement;

  const isVisible = (element: Element): boolean => {
    if (element.closest('[aria-hidden="true"], [hidden]')) {
      return false;
    }
    if (element instanceof HTMLInputElement && element.type === 'hidden') {
      return false;
    }
    let current: Element | null = element;
    while (current) {
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
      }
      current = current.parentElement;
    }
    return true;
  };

  const visibleText = (element: Element): string => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !isVisible(parent) || isPrivateFormElement(parent)) {
          return NodeFilter.FILTER_REJECT;
        }
        return normalizeText(node.textContent ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const chunks: string[] = [];
    let node = walker.nextNode();
    while (node) {
      const text = normalizeText(node.textContent ?? '');
      if (text) {
        chunks.push(text);
      }
      node = walker.nextNode();
    }
    return normalizeText(chunks.join('\n'));
  };

  const filterNestedMatches = (elements: Element[]): Element[] => {
    const visibleElements = elements.filter(isVisible);
    const set = new Set(visibleElements);
    return visibleElements.filter((element) => {
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

  const elementsForSelector = (selector: string, opts: { filterNestedMatches?: boolean } = {}): Element[] => {
    const matches = Array.from(document.querySelectorAll(selector)).filter(isVisible);
    return opts.filterNestedMatches ? filterNestedMatches(matches) : matches;
  };

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

  const escapeMarkdownTableCell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');

  const codeLanguageFromElement = (element: Element): string => {
    const candidates = [
      element.getAttribute('data-language'),
      element.closest('[data-language]')?.getAttribute('data-language'),
      element.getAttribute('class'),
      element.querySelector('[data-language]')?.getAttribute('data-language'),
    ].filter((value): value is string => Boolean(value));

    for (const candidate of candidates) {
      const languageMatch = candidate.match(/(?:language-|lang(?:uage)?=)?([a-z0-9_+-]{2,20})/i);
      if (languageMatch) {
        return languageMatch[1].toLowerCase();
      }
    }

    return '';
  };

  const serializeInlineNode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent ?? '';
    }

    if (!(node instanceof Element) || !isVisible(node) || isPrivateFormElement(node)) {
      return '';
    }

    const tag = node.tagName.toLowerCase();
    if (tag === 'br') {
      return '\n';
    }
    if (tag === 'code' && node.closest('pre')) {
      return visibleText(node);
    }

    const content = normalizeInlineWhitespace(Array.from(node.childNodes).map((child) => serializeInlineNode(child)).join(''));
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

  const collapseParagraphs = (parts: string[]): string =>
    parts
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const labelFromHref = (href: string): string => {
    try {
      const parsed = new URL(href, location.href);
      const leaf = parsed.pathname.split('/').filter(Boolean).pop();
      return leaf ? decodeURIComponent(leaf) : parsed.hostname;
    } catch {
      return href;
    }
  };

  const extractVisibleLinks = (root: ParentNode): InlineDiscoveredLink[] => {
    const seen = new Set<string>();
    return Array.from(root.querySelectorAll('a[href]'))
      .filter((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement)
      .filter((element) => isVisible(element))
      .map((element) => {
        const href = element.href.trim();
        if (!/^(https?:|blob:)/i.test(href)) {
          return null;
        }

        const label = normalizeInlineWhitespace(
          [
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            visibleText(element),
            element.textContent ?? '',
            element.getAttribute('download'),
          ]
            .map((value) => normalizeInlineWhitespace(value ?? ''))
            .find(Boolean) ?? '',
        );

        return {
          label: label || labelFromHref(href),
          url: href,
        };
      })
      .filter((link): link is InlineDiscoveredLink => Boolean(link))
      .filter((link) => {
        if (seen.has(link.url)) {
          return false;
        }
        seen.add(link.url);
        return true;
      });
  };

  const serializeList = (element: Element, depth = 0): string => {
    const items = Array.from(element.children).filter((child): child is HTMLElement => child.tagName.toLowerCase() === 'li');
    const ordered = element.tagName.toLowerCase() === 'ol';

    return items
      .map((item, index) => {
        const prefix = ordered ? `${index + 1}. ` : '- ';
        const indent = '  '.repeat(depth);
        const segments: string[] = [];
        const nestedBlocks: string[] = [];

        Array.from(item.childNodes).forEach((child) => {
          if (child instanceof Element && isVisible(child) && blockTags.has(child.tagName.toLowerCase()) && child.tagName.toLowerCase() !== 'code') {
            const nested =
              child.tagName.toLowerCase() === 'ul' || child.tagName.toLowerCase() === 'ol'
                ? serializeList(child, depth + 1)
                : serializeElementMarkdown(child);
            if (nested) {
              nestedBlocks.push(nested);
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
        : Array.from(element.querySelectorAll('tr')).filter((row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement);
    const grid = rows
      .map((row) =>
        Array.from(row.cells).map((cell) =>
          escapeMarkdownTableCell(normalizeInlineWhitespace(Array.from(cell.childNodes).map((child) => serializeInlineNode(child)).join('')) || visibleText(cell)),
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
      if (child instanceof Element && isVisible(child) && blockTags.has(child.tagName.toLowerCase())) {
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
      return normalizeInlineWhitespace(Array.from(element.childNodes).map((child) => serializeInlineNode(child)).join(''));
    }

    return collapseParagraphs(parts);
  };

  const serializeElementMarkdown = (element: Element): string => {
    if (!isVisible(element) || isPrivateFormElement(element)) {
      return '';
    }

    const tag = element.tagName.toLowerCase();
    if (tag === 'pre') {
      const code = visibleText(element);
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
      const content = normalizeInlineWhitespace(Array.from(element.childNodes).map((child) => serializeInlineNode(child)).join(''));
      return content ? `${'#'.repeat(level)} ${content}` : '';
    }
    if (tag === 'hr') {
      return '---';
    }
    if (tag === 'p' || tag === 'summary' || tag === 'figcaption') {
      return normalizeInlineWhitespace(Array.from(element.childNodes).map((child) => serializeInlineNode(child)).join(''));
    }

    return serializeDefaultBlock(element);
  };

  const countMatchedPatterns = (value: string, patterns: string[]): number =>
    patterns.reduce((count, pattern) => count + Number(new RegExp(pattern, 'i').test(value)), 0);

  const findHeadingTurnRoot = (anchor: Element, source: HeadingSource): Element => {
    let best = anchor.parentElement ?? anchor;
    let current = best;

    while (current.parentElement && current.parentElement !== document.body) {
      const parent = current.parentElement;
      const parentText = visibleText(parent);
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

  const directRoleForElement = (element: Element, index: number, source: DirectSource): Role => {
    const tagName = element.tagName.toLowerCase();
    if (source.tagRoles?.[tagName]) {
      return source.tagRoles[tagName];
    }
    if (source.role !== 'infer') {
      return source.role;
    }
    const attrValue = source.roleAttributes
      ?.map((attribute) => element.getAttribute(attribute))
      .find((value): value is string => Boolean(value));
    if (attrValue) {
      return inferRole(attrValue);
    }
    if (source.alternatingRoles) {
      return source.alternatingRoles[index % 2];
    }
    return 'unknown';
  };

  type CandidateTurn = {
    role: Role;
    text: string;
    formattedText: string;
    sourceSelector: string;
  };

  const createCandidateTurn = (element: Element, role: Role, sourceSelector: string): CandidateTurn | null => {
    const text = visibleText(element);
    if (!text) {
      return null;
    }
    const formattedText = serializeElementMarkdown(element) || text;
    return { role, text, formattedText, sourceSelector };
  };

  const extractDirectTurns = (source: DirectSource): CandidateTurn[] =>
    elementsForSelector(source.selector, { filterNestedMatches: source.filterNestedMatches })
      .map((element, index) => createCandidateTurn(element, directRoleForElement(element, index, source), source.sourceSelector))
      .filter((turn): turn is CandidateTurn => Boolean(turn));

  type ElementCandidate = {
    element: Element;
    role: Role;
    sourceSelector: string;
  };

  const pushElementCandidate = (
    candidates: ElementCandidate[],
    element: Element | null | undefined,
    role: Role,
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

  const extractHeadingCandidates = (source: HeadingSource): ElementCandidate[] => {
    const candidates: ElementCandidate[] = [];
    elementsForSelector(source.selector).forEach((heading) => {
      const label = normalizeText(visibleText(heading) || heading.textContent || '');
      source.rolePatterns.forEach((pattern) => {
        if (!new RegExp(pattern.pattern, 'i').test(label)) {
          return;
        }
        pushElementCandidate(candidates, findHeadingTurnRoot(heading, source), pattern.role, source.sourceSelector);
      });
    });
    return candidates;
  };

  const extractEditableCandidates = (source: EditableSource): ElementCandidate[] =>
    elementsForSelector(source.selector)
      .filter((element) => {
        const text = visibleText(element);
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

  const sortElementCandidates = (candidates: ElementCandidate[]): ElementCandidate[] =>
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

  const mergeAdjacentTurns = (turns: CandidateTurn[]): CandidateTurn[] => {
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

  const dedupeAndFinalizeTurns = (turns: CandidateTurn[]): ProviderCapture['turns'] => {
    const seen = new Set<string>();
    const finalized: ProviderCapture['turns'] = [];
    for (const turn of mergeAdjacentTurns(turns)) {
      const text = turn.text.length > 18_000 ? `${turn.text.slice(0, 18_000).trimEnd()}\n[truncated]` : turn.text;
      const key = `${turn.role}:${text}`;
      if (!text || seen.has(key)) {
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

  const url = location.href;
  const title = document.title || 'Untitled page';
  const provider = providerFromUrl(url);
  const config = registry[provider] ?? registry.unknown;

  let turns: ProviderCapture['turns'] = [];
  for (const source of config.directSources) {
    const directTurns = dedupeAndFinalizeTurns(extractDirectTurns(source));
    if (directTurns.length > 0) {
      turns = directTurns;
      break;
    }
  }

  let selectorCanary: ProviderCapture['selectorCanary'] = turns.length > 0 ? 'passed' : 'failed';

  if (turns.length === 0) {
    const candidates = sortElementCandidates([
      ...(config.headingSources?.flatMap((source) => extractHeadingCandidates(source)) ?? []),
      ...(config.editableSources?.flatMap((source) => extractEditableCandidates(source)) ?? []),
    ]);
    turns = dedupeAndFinalizeTurns(
      candidates
        .map((candidate) => createCandidateTurn(candidate.element, candidate.role, candidate.sourceSelector))
        .filter((turn): turn is CandidateTurn => Boolean(turn)),
    );
    if (turns.length > 0) {
      selectorCanary = 'passed';
    }
  }

  if (turns.length === 0) {
    const root = document.querySelector('main') ?? document.body;
    const text = root ? visibleText(root) : '';
    if (text) {
      turns.push({
        id: 'turn-1',
        role: 'unknown',
        text: text.length > 18_000 ? `${text.slice(0, 18_000).trimEnd()}\n[truncated]` : text,
        formattedText: root ? serializeElementMarkdown(root) || text : text,
        ordinal: 0,
        sourceSelector: 'visible main/body fallback',
      });
      selectorCanary = 'fallback';
    }
  }

  const combinedText = turns.map((turn) => turn.text).join('\n\n');
  const warnings: ProviderCapture['warnings'] = [];
  if (/\b(?:sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,})\b/.test(combinedText)) {
    warnings.push({
      code: 'possible_api_key',
      message: 'Visible text may contain an API key or access token.',
      severity: 'warning',
    });
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(combinedText)) {
    warnings.push({
      code: 'email',
      message: 'Visible text may contain an email address.',
      severity: 'warning',
    });
  }
  if (/\bhttps?:\/\/(?:localhost|127\.0\.0\.1|10\.|192\.168\.|172\.|[^/\s]+\.(?:local|internal|corp))\S*/i.test(`${url}\n${combinedText}`)) {
    warnings.push({
      code: 'internal_url',
      message: 'Visible text may contain an internal or private URL.',
      severity: 'warning',
    });
  }
  if (provider === 'unknown') {
    warnings.push({
      code: 'unsupported_provider',
      message: 'Provider is unknown; capture used conservative visible-text selectors.',
      severity: 'info',
    });
  }

  const capturedAt = new Date().toISOString();
  return {
    capture: {
      id: `capture-${provider}-${capturedAt.replace(/[^0-9]/g, '').slice(0, 14)}`,
      provider,
      url,
      title,
      capturedAt,
      extractionConfigVersion: config.version,
      selectorCanary,
      turns,
      artifacts: [],
      warnings,
      visibleTextCharCount: combinedText.length,
    },
    discoveredLinks: extractVisibleLinks(document.querySelector('main') ?? document.body ?? document.documentElement),
  };
};

interface FrameArtifactResult {
  frameId: number;
  result: InlineFrameCaptureResult;
}

const artifactKindForCapture = (capture: ProviderCapture): CapturedArtifact['kind'] => {
  const summary = `${capture.title}\n${capture.turns.map((turn) => turn.text).join('\n\n')}`;
  if (/research completed|citations|searches/i.test(summary)) {
    return 'report';
  }
  if (/bundle/i.test(summary)) {
    return 'bundle';
  }
  if (summary.trim()) {
    return 'document';
  }
  return 'unknown';
};

const extractLinksFromText = (value: string): InlineDiscoveredLink[] => {
  const matches = value.match(/https?:\/\/[^\s<>()]+/g) ?? [];
  const unique = new Set<string>();
  return matches
    .map((entry) => entry.replace(/[),.;]+$/, ''))
    .filter((entry) => {
      if (unique.has(entry)) {
        return false;
      }
      unique.add(entry);
      return true;
    })
    .map((entry, index) => ({
      label: `Link ${index + 1}`,
      url: entry,
    }));
};

const mergeArtifactLinks = (
  discoveredLinks: InlineDiscoveredLink[],
  textLinks: InlineDiscoveredLink[],
): InlineDiscoveredLink[] => {
  const merged = new Map<string, InlineDiscoveredLink>();
  [...discoveredLinks, ...textLinks].forEach((link) => {
    const existing = merged.get(link.url);
    if (!existing) {
      merged.set(link.url, link);
      return;
    }

    if (/^Link \d+$/.test(existing.label) && !/^Link \d+$/.test(link.label)) {
      merged.set(link.url, link);
    }
  });
  return Array.from(merged.values());
};

const artifactTitleForCapture = (capture: ProviderCapture): string => {
  const firstTurn = capture.turns[0];
  const firstHeading = firstTurn?.formattedText?.match(/^#+\s+(.+)$/m)?.[1]?.trim();
  return firstHeading || capture.title || 'Captured artifact';
};

const buildArtifactsFromFrameResults = (frameResults: FrameArtifactResult[]): CapturedArtifact[] =>
  frameResults
    .filter(({ frameId, result }) => frameId !== 0 && result.capture.visibleTextCharCount >= 200 && result.capture.turns.length > 0)
    .map(({ frameId, result }, index) => {
      const capture = result.capture;
      const combinedText = capture.turns.map((turn) => turn.text).join('\n\n');
      const combinedFormattedText = capture.turns
        .map((turn) => turn.formattedText?.trim() || turn.text)
        .join('\n\n')
        .trim();
      const links = mergeArtifactLinks(
        result.discoveredLinks,
        extractLinksFromText(`${combinedFormattedText}\n${combinedText}`),
      ).map((link, linkIndex) => ({
        id: `artifact-${frameId}-link-${linkIndex + 1}`,
        label: link.label,
        url: link.url,
      }));

      return {
        id: `artifact-${frameId}-${index + 1}`,
        kind: artifactKindForCapture(capture),
        title: artifactTitleForCapture(capture),
        text: combinedText,
        formattedText: combinedFormattedText || combinedText,
        sourceSelector: 'frame document',
        sourceUrl: capture.url,
        links,
      };
    });

export const executeInlineCapture = async (tabId: number): Promise<ProviderCapture> => {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: inlineCaptureVisibleConversation,
    args: [providerConfigs],
  });

  const frameResults = results
    .filter((entry): entry is typeof entry & { result: InlineFrameCaptureResult } => Boolean(entry.result))
    .map((entry) => ({
      frameId: entry.frameId,
      result: entry.result as InlineFrameCaptureResult,
    }));

  const topFrame = frameResults.find((entry) => entry.frameId === 0)?.result.capture ?? frameResults[0]?.result.capture;
  if (!topFrame) {
    throw new Error('Inline capture returned no result.');
  }

  const artifacts = buildArtifactsFromFrameResults(frameResults);
  return {
    ...topFrame,
    artifacts,
    visibleTextCharCount:
      topFrame.visibleTextCharCount + artifacts.reduce((sum, artifact) => sum + artifact.text.length, 0),
  };
};
