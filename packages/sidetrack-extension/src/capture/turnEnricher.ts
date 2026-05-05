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

// Slug → display name. ChatGPT's data-message-model-slug is
// precise but not user-facing ("gpt-5-5-thinking" instead of
// "GPT-5.5 Thinking"); these rules turn the slug into something
// humans recognize. Unknown slugs pass through capitalized so a
// new variant degrades gracefully.
//
// Examples:
//   gpt-5-5-thinking → GPT-5.5 Thinking
//   gpt-4o          → GPT-4o
//   o3-mini         → o3 Mini
//   gpt-5           → GPT-5
const formatModelSlug = (slug: string): string => {
  const trimmed = slug.trim();
  if (trimmed.length === 0) return slug;
  // Use a placeholder to protect the dash inside the model number
  // (e.g. "GPT-5" or "GPT-5.5") from the split-on-dash pass below.
  const HYPHEN_PLACEHOLDER = '§';
  let out = trimmed
    .replace(/^gpt-(\d)-(\d)\b/i, `GPT${HYPHEN_PLACEHOLDER}$1.$2`)
    .replace(/^gpt-(\d+)\b/i, `GPT${HYPHEN_PLACEHOLDER}$1`)
    .replace(/^o(\d+)\b/i, `o${HYPHEN_PLACEHOLDER}$1`);
  out = out
    .split('-')
    .map((part, idx) => (idx === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
  return out.replace(new RegExp(HYPHEN_PLACEHOLDER, 'g'), '-');
};

const chatgptModelName = (turnNode: Element, doc: Document): string | undefined => {
  // ChatGPT exposes the actual model on each assistant turn via
  // `data-message-model-slug`. That's MUCH more reliable than the
  // top-of-page model picker (which is icon-only with no text in
  // the current UI) and gives per-turn accuracy when a thread
  // switches models mid-conversation.
  const slug = turnNode.getAttribute('data-message-model-slug');
  if (typeof slug === 'string' && slug.length > 0) {
    return formatModelSlug(slug);
  }
  // Fallback to the picker button text (older UIs / non-message
  // contexts). Most callers won't reach this.
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
  // Dedup by URL (preferred) or source label. ChatGPT renders a
  // citation pill at every reference site within a long answer, so
  // the same source can appear 5+ times — collapsing keeps the
  // metadata signal-bearing without flooding the consumer.
  const seen = new Set<string>();
  const out: CapturedCitation[] = [];
  for (const pill of pills) {
    const label = text(pill);
    const anchor = pill.querySelector('a') ?? pill.closest('a');
    const url = attr(anchor, 'href');
    const key = url.length > 0 ? url : label;
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(url.length > 0 ? { source: label, url } : { source: label });
  }
  return out;
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
  const modelName = chatgptModelName(ctx.turnNode, ctx.doc);
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
  const marker = /^\s{0,4}Show thinking[\s\S]+?Gemini said\s{0,4}/i;
  const match = marker.exec(body);
  if (match === null) return { visible: body };
  const thinking = body
    .slice(0, match[0].length)
    .replace(/^\s*Show thinking\s*/i, '')
    .replace(/\s*Gemini said\s*$/i, '')
    .trim();
  const visible = body.slice(match[0].length).trim();
  // Reasoning is only meaningful when the collapsible was OPEN at
  // capture time (yielding actual thinking text). A closed
  // collapsible just shows "Show thinking" + "Gemini said" with
  // nothing between, which strips to empty / a stray markdown
  // marker. Require a sentence-worth of content (>= 30 chars) to
  // avoid surfacing junk like "##" or "—".
  const meaningful = thinking.length >= 30 && /[\p{L}\p{N}]/u.test(thinking);
  return meaningful ? { visible, thinking } : { visible };
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
