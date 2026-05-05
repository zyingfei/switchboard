import type {
  CapturedAttachment,
  CapturedCitation,
  CapturedResearchReport,
  ProviderId,
} from '../companion/model';

import { domToMarkdown } from './domToMarkdown';

// Per-provider enrichment of a captured turn — fills in markdown,
// modelName, reasoning, attachments, researchReport from the live
// DOM at the moment of capture. Each provider has its own selector
// quirks; the registry below isolates them so the main extractor
// can stay generic.
//
// Outputs are all OPTIONAL — a provider that doesn't expose a given
// signal simply returns nothing for that field. The downstream
// schemas accept undefined for every enrichment, so a partial
// implementation never breaks the capture pipeline.

export interface TurnEnrichment {
  readonly modelName?: string;
  readonly markdown?: string;
  readonly reasoning?: string;
  readonly attachments?: readonly CapturedAttachment[];
  readonly researchReport?: CapturedResearchReport;
}

export interface EnrichmentContext {
  readonly provider: ProviderId;
  readonly turnNode: Element;
  readonly role: 'user' | 'assistant' | 'system' | 'unknown';
  // Document we're scraping — passed through so cross-turn signals
  // (model picker outside the turn DOM, deep-research mode pill in
  // the composer) can be read in the same pass.
  readonly doc: Document;
}

const text = (el: Element | null): string => {
  if (el === null) return '';
  const t = el.textContent;
  return typeof t === 'string' ? t.trim() : '';
};

const attr = (el: Element | null, name: string): string => {
  if (el === null) return '';
  const v = el.getAttribute(name);
  return typeof v === 'string' ? v : '';
};

// ────────────────── ChatGPT ──────────────────

const chatgptModelName = (doc: Document): string | undefined => {
  // The model picker is a button at the top-right with the model
  // name as its text content. It's outside the per-turn subtree, so
  // we read it from `doc` once per capture.
  const button =
    doc.querySelector('[aria-label="Switch model"]') ??
    doc.querySelector('button[data-testid="model-switcher-dropdown-button"]');
  const t = text(button);
  return t.length > 0 ? t : undefined;
};

const chatgptDeepResearchActive = (doc: Document): boolean =>
  doc.querySelector('[aria-label*="Deep research"]') !== null;

const chatgptCitations = (turnNode: Element): readonly CapturedCitation[] => {
  const pills = Array.from(turnNode.querySelectorAll('[data-testid="webpage-citation-pill"]'));
  if (pills.length === 0) return [];
  return pills.map((pill) => {
    const label = text(pill);
    // The anchor is sometimes the pill's parent (when ChatGPT wraps
    // the whole pill as a link) and sometimes a descendant (when the
    // pill itself is the inline span and the link is one of its
    // children). Cover both.
    const anchor = pill.querySelector('a') ?? pill.closest('a');
    const url = attr(anchor, 'href');
    return url.length > 0 ? { source: label, url } : { source: label };
  });
};

const chatgptAttachments = (turnNode: Element): readonly CapturedAttachment[] => {
  const imgs = Array.from(turnNode.querySelectorAll('img')).filter((img) => {
    const src = attr(img, 'src');
    return src.length > 0 && !/avatars|favicon|sprite/.test(src);
  });
  return imgs.map((img) => {
    const url = attr(img, 'src');
    const alt = attr(img, 'alt');
    return {
      kind: 'image' as const,
      ...(url.length > 0 ? { url } : {}),
      ...(alt.length > 0 ? { alt } : {}),
    };
  });
};

const enrichChatgpt = (ctx: EnrichmentContext): TurnEnrichment => {
  const markdownRoot = ctx.turnNode.querySelector('.markdown.prose, .prose, .markdown');
  const markdown = markdownRoot !== null ? domToMarkdown(markdownRoot) : undefined;
  const modelName = chatgptModelName(ctx.doc);
  const attachments = chatgptAttachments(ctx.turnNode);
  const citations = chatgptCitations(ctx.turnNode);
  const isDeepResearch = chatgptDeepResearchActive(ctx.doc) || citations.length >= 3;
  const researchReport: CapturedResearchReport | undefined =
    ctx.role === 'assistant' && isDeepResearch
      ? {
          mode: 'deep-research',
          ...(citations.length > 0 ? { citations } : {}),
        }
      : undefined;
  return {
    ...(modelName === undefined ? {} : { modelName }),
    ...(markdown === undefined || markdown.length === 0 ? {} : { markdown }),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(researchReport === undefined ? {} : { researchReport }),
  };
};

// ────────────────── Claude ──────────────────

const claudeModelName = (doc: Document): string | undefined => {
  const dropdown = doc.querySelector('[data-testid="model-selector-dropdown"]');
  if (dropdown === null) return undefined;
  const aria = attr(dropdown, 'aria-label');
  const fromAria = /Model:\s*(.+)/i.exec(aria)?.[1];
  if (typeof fromAria === 'string' && fromAria.length > 0) return fromAria.trim();
  const t = text(dropdown);
  return t.length > 0 ? t : undefined;
};

const claudeAttachments = (turnNode: Element): readonly CapturedAttachment[] => {
  const out: CapturedAttachment[] = [];
  for (const img of Array.from(turnNode.querySelectorAll('img'))) {
    const src = attr(img, 'src');
    if (src.length > 0 && !/avatars|favicon/.test(src)) {
      const alt = attr(img, 'alt');
      out.push({
        kind: 'image',
        url: src,
        ...(alt.length > 0 ? { alt } : {}),
      });
    }
  }
  for (const node of Array.from(
    turnNode.querySelectorAll('[data-testid*="artifact"], [class*="artifact"]'),
  )) {
    const alt = text(node).slice(0, 80);
    out.push({
      kind: 'artifact',
      ...(alt.length > 0 ? { alt } : {}),
    });
  }
  return out;
};

const enrichClaude = (ctx: EnrichmentContext): TurnEnrichment => {
  const markdownRoot = ctx.turnNode.querySelector(
    '.font-claude-response, .prose, [class*="markdown"]',
  );
  const markdown = markdownRoot !== null ? domToMarkdown(markdownRoot) : undefined;
  const modelName = claudeModelName(ctx.doc);
  const attachments = claudeAttachments(ctx.turnNode);
  return {
    ...(modelName === undefined ? {} : { modelName }),
    ...(markdown === undefined || markdown.length === 0 ? {} : { markdown }),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
};

// ────────────────── Gemini ──────────────────

const geminiModelName = (doc: Document): string | undefined => {
  const candidate =
    doc.querySelector('[data-test-id="bard-mode-menu-button"]') ??
    doc.querySelector('.side-nav-menu-button.with-pill-ui') ??
    doc.querySelector('[aria-label*="Gemini"][aria-label*="model"]');
  const t = text(candidate);
  if (t.length > 0 && t.length < 60) return t;
  return undefined;
};

const stripGeminiThinkingPrefix = (
  body: string,
): { readonly visible: string; readonly thinking?: string } => {
  // Gemini's response container can contain the collapsed reasoning
  // block as plain text "Show thinking ..." prefix when the
  // collapsible is closed. Split on the marker so the visible
  // answer doesn't get polluted.
  const marker = /^\s*Show thinking[\s\S]+?Gemini said\s{0,2}/i;
  const match = marker.exec(body);
  if (match === null) return { visible: body };
  const thinking = body
    .slice(0, match[0].length)
    .replace(/^\s*Show thinking\s*/i, '')
    .replace(/\s*Gemini said\s*$/i, '')
    .trim();
  const visible = body.slice(match[0].length).trim();
  return thinking.length > 0 ? { visible, thinking } : { visible };
};

const enrichGemini = (ctx: EnrichmentContext): TurnEnrichment => {
  const root = ctx.turnNode.querySelector('.response-content, .model-response-text, .markdown');
  if (root === null) return {};
  let markdown = domToMarkdown(root);
  let reasoning: string | undefined;
  const thinkingNode = ctx.turnNode.querySelector(
    '[data-test-id="thoughts-content"], .thoughts-section, [class*="thinking"]',
  );
  if (thinkingNode !== null) {
    const t = text(thinkingNode);
    if (t.length > 0) reasoning = t;
  } else {
    const split = stripGeminiThinkingPrefix(markdown);
    markdown = split.visible;
    if (split.thinking !== undefined && split.thinking.length > 0) reasoning = split.thinking;
  }
  const modelName = geminiModelName(ctx.doc);
  const isResearchReport =
    /Research|Deep dive|Sources/i.test(markdown.slice(0, 200)) && markdown.length > 2000;
  const researchReport: CapturedResearchReport | undefined =
    ctx.role === 'assistant' && isResearchReport
      ? { mode: 'gemini-deep-research' }
      : undefined;
  return {
    ...(modelName === undefined ? {} : { modelName }),
    ...(markdown.length === 0 ? {} : { markdown }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(researchReport === undefined ? {} : { researchReport }),
  };
};

// ────────────────── Dispatch ──────────────────

export const enrichTurn = (ctx: EnrichmentContext): TurnEnrichment => {
  if (ctx.provider === 'chatgpt') return enrichChatgpt(ctx);
  if (ctx.provider === 'claude') return enrichClaude(ctx);
  if (ctx.provider === 'gemini') return enrichGemini(ctx);
  return {};
};
