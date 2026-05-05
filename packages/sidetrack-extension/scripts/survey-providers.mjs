import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];

const surveyTab = async (page, label) => {
  const url = page.url();
  console.log(`\n=== ${label} ===\nURL: ${url.slice(0, 90)}`);
  try {
    const data = await page.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const sample = (els, n) => Array.from(els).filter(visible).slice(0, n).map((el) => ({
        tag: el.tagName,
        cls: (el.className?.toString?.() || '').slice(0, 80),
        id: el.id?.slice(0, 40) || '',
        attr: Object.fromEntries(Array.from(el.attributes || []).filter(a => /role|data-|aria/.test(a.name)).map(a => [a.name, a.value.slice(0, 40)])),
        textPreview: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      }));
      // Common tag-fishing patterns
      const out = {
        h1: sample(document.querySelectorAll('h1, h2[role]'), 2),
        roleTurns: sample(document.querySelectorAll('[data-message-author-role], [data-author], [data-from]'), 4),
        articleTurns: sample(document.querySelectorAll('article, .conversation-turn, .turn, .message'), 4),
        modelHints: sample(document.querySelectorAll('[data-testid*="model"], [aria-label*="model"], [class*="model"], [class*="pill"], .model-selector'), 4),
        thinkingHints: sample(document.querySelectorAll('[data-testid*="reasoning"], [data-testid*="thinking"], [class*="think"], [class*="reason"], details summary, .reasoning, .thinking'), 4),
        timestamps: sample(document.querySelectorAll('time, [datetime], [data-timestamp], [class*="time"]'), 4),
        images: sample(document.querySelectorAll('img'), 4).map(s => ({ ...s, src: 'omitted' })),
        codeBlocks: document.querySelectorAll('pre code, pre.code-block, [class*="code-block"]').length,
        markdownContainers: sample(document.querySelectorAll('[class*="markdown"], [class*="prose"], .response-content, .message-content'), 3),
      };
      return out;
    });
    console.log('  h1/h2:', JSON.stringify(data.h1));
    console.log('  role turns (data-message-author-role / similar):', data.roleTurns.length, '— first:', JSON.stringify(data.roleTurns[0]));
    console.log('  article/message turns:', data.articleTurns.length, '— first:', JSON.stringify(data.articleTurns[0]));
    console.log('  model hints:', data.modelHints.length, '— first:', JSON.stringify(data.modelHints[0]));
    console.log('  thinking/reasoning hints:', data.thinkingHints.length, '— first:', JSON.stringify(data.thinkingHints[0]));
    console.log('  timestamps:', data.timestamps.length, '— first:', JSON.stringify(data.timestamps[0]));
    console.log('  images:', data.images.length, '— first:', JSON.stringify(data.images[0]));
    console.log('  code blocks:', data.codeBlocks);
    console.log('  markdown containers:', data.markdownContainers.length, '— first:', JSON.stringify(data.markdownContainers[0]));
  } catch (e) {
    console.log('  ERROR', String(e).slice(0, 200));
  }
};

const pages = ctx.pages();
const chatgpt = pages.find(p => p.url().startsWith('https://chatgpt.com/c/') || p.url().startsWith('https://chatgpt.com/g/'));
const claude = pages.find(p => p.url().startsWith('https://claude.ai/chat/'));
const gemini = pages.find(p => p.url().startsWith('https://gemini.google.com/app/') && !p.url().endsWith('/app'));

if (chatgpt) await surveyTab(chatgpt, 'ChatGPT');
if (claude) await surveyTab(claude, 'Claude');
if (gemini) await surveyTab(gemini, 'Gemini');
await b.close();
