// Side-by-side: run the new turnEnricher against each provider's
// live DOM via CDP, compare to the plain-text baseline. No extension
// reload required — we inject the extractor logic directly.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const TURN_ENRICHER = readFileSync('/Users/yingfei/Documents/playground/browser-ai-companion/.claude/worktrees/m1+foundation/packages/sidetrack-extension/src/capture/turnEnricher.ts', 'utf8');
const DOM_TO_MD = readFileSync('/Users/yingfei/Documents/playground/browser-ai-companion/.claude/worktrees/m1+foundation/packages/sidetrack-extension/src/capture/domToMarkdown.ts', 'utf8');

// Strip TS imports + types so the file is runnable in a browser
// context. Each module re-defines types inline so we just need the
// runtime functions.
const stripTs = (src) =>
  src
    .replace(/^import[^;]*;\n?/gm, '')
    .replace(/^export\s+(?:type|interface)\s+[\s\S]*?^\}\s*$/gm, '')
    .replace(/^export\s+type\s+\S[^;]*;\n?/gm, '')
    .replace(/^export\s+/gm, '')
    .replace(/:\s*Element\s*\|\s*null/g, '')
    .replace(/:\s*Element/g, '')
    .replace(/:\s*HTMLElement/g, '')
    .replace(/:\s*Document/g, '')
    .replace(/:\s*Node\s*\|\s*null/g, '')
    .replace(/:\s*Node/g, '')
    .replace(/:\s*string\s*\|\s*undefined/g, '')
    .replace(/:\s*string/g, '')
    .replace(/:\s*number/g, '')
    .replace(/:\s*boolean/g, '')
    .replace(/:\s*readonly[^=,)\n]+/g, '')
    .replace(/:\s*\{[^=]*?\}\s*(?=[,)=\n])/g, '')
    .replace(/:\s*ReadonlyArray<[^>]+>/g, '')
    .replace(/:\s*Array<[^>]+>/g, '')
    .replace(/<[A-Z][a-zA-Z]*>/g, '')
    .replace(/\bas\s+const\b/g, '')
    .replace(/\bas\s+\S[^,)\n]+/g, '');

// Easier path: build a small standalone JS bundle inline.
const ENRICHER_BUNDLE = `
const isElement = (n) => n && n.nodeType === 1;
const isText = (n) => n && n.nodeType === 3;
const inlineWrap = (m, b) => b.length > 0 ? m + b + m : '';
const textOf = (n) => { const t = n && n.textContent; return typeof t === 'string' ? t : ''; };
const attr = (e, name) => { if (!e) return ''; const v = e.getAttribute(name); return typeof v === 'string' ? v : ''; };

const renderInline = (n) => {
  if (isText(n)) return textOf(n).replace(/\\s+/g, ' ');
  if (!isElement(n)) return '';
  const tag = n.tagName.toLowerCase();
  const inner = Array.from(n.childNodes).map(renderInline).join('');
  if (tag === 'br') return '\\n';
  if (tag === 'strong' || tag === 'b') return inlineWrap('**', inner.trim());
  if (tag === 'em' || tag === 'i') return inlineWrap('*', inner.trim());
  if (tag === 'code') return inlineWrap('\`', inner);
  if (tag === 's' || tag === 'del') return inlineWrap('~~', inner);
  if (tag === 'a') { const h = attr(n, 'href'); return h.length > 0 ? '['+inner.trim()+']('+h+')' : inner; }
  if (tag === 'img') { return '!['+attr(n, 'alt')+']('+attr(n, 'src')+')'; }
  return inner;
};

const renderBlock = (n, depth) => {
  if (isText(n)) { const t = textOf(n).replace(/\\s+/g, ' '); return t.trim().length > 0 ? t : ''; }
  if (!isElement(n)) return '';
  const tag = n.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) { const lvl = Number(tag.slice(1)); return '#'.repeat(lvl) + ' ' + renderInline(n).trim() + '\\n\\n'; }
  if (tag === 'p') { const i = renderInline(n).trim(); return i.length > 0 ? i + '\\n\\n' : ''; }
  if (tag === 'pre') {
    const cn = n.querySelector('code') || n;
    const cls = isElement(cn) ? attr(cn, 'class') : '';
    const lm = /language-([\\w-]+)/.exec(cls);
    const lang = lm && lm[1] || '';
    const body = textOf(cn).replace(/\\n$/, '');
    return '\`\`\`' + lang + '\\n' + body + '\\n\`\`\`\\n\\n';
  }
  if (tag === 'blockquote') {
    const i = Array.from(n.childNodes).map(c => renderBlock(c, depth)).join('').trim();
    return i.split('\\n').map(l => '> ' + l).join('\\n') + '\\n\\n';
  }
  if (tag === 'hr') return '---\\n\\n';
  if (tag === 'ul' || tag === 'ol') {
    const ordered = tag === 'ol';
    const startN = Number(attr(n, 'start')) || 1;
    const items = Array.from(n.children).filter(c => c.tagName.toLowerCase() === 'li');
    const lines = items.map((li, idx) => {
      const marker = ordered ? (startN+idx)+'.' : '-';
      const inner = Array.from(li.childNodes).map(c => {
        if (isElement(c) && (c.tagName.toLowerCase() === 'ul' || c.tagName.toLowerCase() === 'ol')) {
          return '\\n' + renderBlock(c, depth+1).trimEnd();
        }
        return renderInline(c);
      }).join('').trim();
      const indent = '  '.repeat(depth);
      return indent + marker + ' ' + inner.replace(/\\n/g, '\\n' + indent + '  ');
    });
    return lines.join('\\n') + '\\n\\n';
  }
  return Array.from(n.childNodes).map(c => renderBlock(c, depth)).join('');
};

const domToMarkdown = (root) => {
  if (!root) return '';
  return renderBlock(root, 0).replace(/\\n{3,}/g, '\\n\\n').trim();
};

const text = textOf;

const formatModelSlug = (slug) => {
  const H = '\\u00A7';
  let out = slug.trim()
    .replace(/^gpt-(\\d)-(\\d)\\b/i, 'GPT' + H + '$1.$2')
    .replace(/^gpt-(\\d+)\\b/i, 'GPT' + H + '$1')
    .replace(/^o(\\d+)\\b/i, 'o' + H + '$1');
  out = out.split('-').map((p, i) => i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  return out.replace(new RegExp(H, 'g'), '-');
};
const enrichChatgpt = (turnNode, doc, role) => {
  const slug = turnNode.getAttribute('data-message-model-slug');
  const modelName = (slug && slug.length > 0)
    ? formatModelSlug(slug)
    : (text(doc.querySelector('[aria-label="Switch model"]')).trim() || undefined);
  const md = turnNode.querySelector('.markdown.prose, .prose, .markdown');
  const markdown = md ? domToMarkdown(md) : undefined;
  const isDeep = !!doc.querySelector('[aria-label*="Deep research"]');
  const pills = Array.from(turnNode.querySelectorAll('[data-testid="webpage-citation-pill"]'));
  const seen = new Set();
  const citations = [];
  for (const p of pills) {
    const a = p.querySelector('a') || p.closest('a');
    const url = attr(a, 'href');
    const label = text(p).trim();
    const key = url || label;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    citations.push(url ? { source: label, url } : { source: label });
  }
  const imgs = Array.from(turnNode.querySelectorAll('img')).filter(i => { const s = attr(i, 'src'); return s.length > 0 && !/avatars|favicon|sprite/.test(s); }).map(i => ({ kind: 'image', url: attr(i, 'src'), alt: attr(i, 'alt') || undefined }));
  const research = (role === 'assistant' && (isDeep || citations.length >= 3)) ? { mode: 'deep-research', citations: citations.length ? citations : undefined } : undefined;
  return { modelName, markdown: markdown && markdown.length ? markdown : undefined, attachments: imgs.length ? imgs : undefined, researchReport: research };
};

const enrichClaude = (turnNode, doc) => {
  const dd = doc.querySelector('[data-testid="model-selector-dropdown"]');
  let modelName;
  if (dd) {
    const aria = attr(dd, 'aria-label');
    const m = /Model:\\s*(.+)/i.exec(aria);
    modelName = m && m[1] ? m[1].trim() : text(dd).trim();
  }
  const md = turnNode.querySelector('.font-claude-response, .prose, [class*="markdown"]');
  const markdown = md ? domToMarkdown(md) : undefined;
  const imgs = Array.from(turnNode.querySelectorAll('img')).filter(i => { const s = attr(i, 'src'); return s.length > 0 && !/avatars|favicon/.test(s); }).map(i => ({ kind: 'image', url: attr(i, 'src'), alt: attr(i, 'alt') || undefined }));
  const arts = Array.from(turnNode.querySelectorAll('[data-testid*="artifact"], [class*="artifact"]')).map(n => ({ kind: 'artifact', alt: text(n).slice(0, 80) }));
  const atts = [...imgs, ...arts];
  return { modelName, markdown: markdown && markdown.length ? markdown : undefined, attachments: atts.length ? atts : undefined };
};

const enrichGemini = (turnNode, doc, role) => {
  const cand = doc.querySelector('[data-test-id="bard-mode-menu-button"]') || doc.querySelector('.side-nav-menu-button.with-pill-ui') || doc.querySelector('[aria-label*="Gemini"][aria-label*="model"]');
  const t = text(cand).trim();
  const modelName = (t.length > 0 && t.length < 60) ? t : undefined;
  const root = turnNode.querySelector('.response-content, .model-response-text, .markdown');
  if (!root) return { modelName };
  let markdown = domToMarkdown(root);
  let reasoning;
  const tn = turnNode.querySelector('[data-test-id="thoughts-content"], .thoughts-section, [class*="thinking"]');
  if (tn) {
    const tt = text(tn).trim();
    if (tt.length > 0) reasoning = tt;
  } else {
    const m = /^\\s{0,4}Show thinking[\\s\\S]+?Gemini said\\s{0,4}/i.exec(markdown);
    if (m) {
      const candidate = markdown.slice(0, m[0].length).replace(/^\\s*Show thinking\\s*/i, '').replace(/\\s*Gemini said\\s*$/i, '').trim();
      const meaningful = candidate.length >= 30 && /[\\p{L}\\p{N}]/u.test(candidate);
      if (meaningful) reasoning = candidate;
      markdown = markdown.slice(m[0].length).trim();
    }
  }
  const isResearch = role === 'assistant' && /Research|Deep dive|Sources/i.test(markdown.slice(0, 200)) && markdown.length > 2000;
  return { modelName, markdown: markdown.length ? markdown : undefined, reasoning, researchReport: isResearch ? { mode: 'gemini-deep-research' } : undefined };
};

window.__sidetrackEnrich = { enrichChatgpt, enrichClaude, enrichGemini, domToMarkdown };
`;

const probe = async (page, provider) => {
  await page.evaluate(ENRICHER_BUNDLE);
  return await page.evaluate((provider) => {
    const E = window.__sidetrackEnrich;
    let turnSelector = '';
    if (provider === 'chatgpt') turnSelector = '[data-message-author-role]';
    else if (provider === 'claude') turnSelector = 'div[class*="font-claude-response"], .font-user-message, [data-test-render-count]';
    else if (provider === 'gemini') turnSelector = 'user-query, model-response, .conversation-turn';
    const candidates = Array.from(document.querySelectorAll(turnSelector));
    if (candidates.length === 0) return { error: 'no turns', selector: turnSelector };
    const lastAssistant = candidates.reverse().find(el => {
      if (provider === 'chatgpt') return el.getAttribute('data-message-author-role') === 'assistant';
      if (provider === 'claude') return /font-claude-response/.test(el.className || '');
      if (provider === 'gemini') return el.tagName.toLowerCase() === 'model-response' || /response/i.test(el.className || '');
      return false;
    }) || candidates[0];
    const role = (provider === 'chatgpt' && lastAssistant.getAttribute('data-message-author-role') === 'assistant') ||
                 (provider === 'claude' && /font-claude-response/.test(lastAssistant.className || '')) ||
                 (provider === 'gemini') ? 'assistant' : 'unknown';
    const plain = (lastAssistant.textContent || '').trim();
    let enriched;
    if (provider === 'chatgpt') enriched = E.enrichChatgpt(lastAssistant, document, role);
    else if (provider === 'claude') enriched = E.enrichClaude(lastAssistant, document, role);
    else if (provider === 'gemini') enriched = E.enrichGemini(lastAssistant, document, role);
    return {
      candidateCount: candidates.length,
      lastTurnLen: plain.length,
      plainPreview: plain.slice(0, 200),
      enriched: {
        modelName: enriched?.modelName,
        markdownLen: enriched?.markdown?.length,
        markdownPreview: (enriched?.markdown || '').slice(0, 200),
        reasoningLen: enriched?.reasoning?.length,
        reasoningPreview: (enriched?.reasoning || '').slice(0, 200),
        attachments: enriched?.attachments,
        researchReport: enriched?.researchReport,
      },
    };
  }, provider);
};

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const pages = ctx.pages();
const cgp = pages.find(p => /chatgpt\.com\/c\//.test(p.url()));
const cgpDeep = pages.find(p => /chatgpt\.com\/g\/.*\/c\//.test(p.url()));
const cla = pages.find(p => /claude\.ai\/chat\//.test(p.url()));
const gem = pages.find(p => /gemini\.google\.com\/app\/[^/]+$/.test(p.url()) && p.url().split('/').pop().length > 8);

const targets = [
  ['ChatGPT (regular)', cgp, 'chatgpt'],
  ['ChatGPT (deep-research project)', cgpDeep, 'chatgpt'],
  ['Claude', cla, 'claude'],
  ['Gemini', gem, 'gemini'],
];
for (const [label, page, provider] of targets) {
  if (!page) { console.log(`\n=== ${label}: SKIPPED (no tab) ===`); continue; }
  console.log(`\n=== ${label} ===\n  url: ${page.url().slice(0, 80)}`);
  try {
    const r = await probe(page, provider);
    if (r.error) {
      console.log('  ERR:', r.error);
      continue;
    }
    console.log('  candidates:', r.candidateCount, '| last turn plain-text len:', r.lastTurnLen);
    console.log('  plain preview:', JSON.stringify(r.plainPreview));
    console.log('  ENRICHED:');
    console.log('    modelName     :', r.enriched.modelName);
    console.log('    markdown len  :', r.enriched.markdownLen);
    console.log('    markdown prev :', JSON.stringify(r.enriched.markdownPreview));
    console.log('    reasoning len :', r.enriched.reasoningLen);
    console.log('    reasoning prev:', JSON.stringify(r.enriched.reasoningPreview));
    console.log('    attachments   :', JSON.stringify(r.enriched.attachments)?.slice(0, 200));
    console.log('    researchReport:', JSON.stringify(r.enriched.researchReport)?.slice(0, 200));
  } catch (e) {
    console.log('  THREW:', String(e).slice(0, 200));
  }
}
await browser.close();
