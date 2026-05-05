import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const target = 'https://chatgpt.com/g/g-p-69e9ab0f1e04819191397ca941f85cf1/c/69ea4331-7c44-832a-b8ad-90a454c47273';
const page = ctx.pages().find(p => p.url() === target) ?? ctx.pages().find(p => p.url().startsWith('https://chatgpt.com/g/'));
if (!page) { console.log('no chatgpt page'); process.exit(1); }
console.log('page:', page.url().slice(0, 90));
const data = await page.evaluate(() => {
  const sample = (els, n) => Array.from(els).slice(0, n).map(el => ({
    tag: el.tagName,
    cls: (el.className?.toString?.() || '').slice(0, 80),
    attrs: Object.fromEntries(Array.from(el.attributes || []).filter(a => /role|data-|aria-label|aria-describedby/.test(a.name)).map(a => [a.name, a.value.slice(0, 60)])),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
  }));
  return {
    deepResearchPills: sample(document.querySelectorAll('[data-testid*="research"], [aria-label*="research"], [class*="research"], [class*="report"]'), 6),
    citations: sample(document.querySelectorAll('[data-testid*="citation"], [class*="citation"], a[href*="ref="]'), 6),
    sources: sample(document.querySelectorAll('[data-testid*="source"], [class*="source"]'), 4),
    longResponses: Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'))
      .map(el => ({
        chars: el.textContent?.length ?? 0,
        cls: (el.className?.toString?.() || '').slice(0, 60),
      })).filter(r => r.chars > 1000),
    modelButton: document.querySelector('[aria-label="Switch model"], button[aria-haspopup="menu"][data-state="closed"]')?.textContent?.trim(),
    composeArea: !!document.querySelector('#prompt-textarea, [contenteditable="true"]'),
  };
});
console.log('deep-research markers:', JSON.stringify(data.deepResearchPills.slice(0, 3), null, 2));
console.log('\ncitations:', JSON.stringify(data.citations.slice(0, 3), null, 2));
console.log('\nsources:', JSON.stringify(data.sources.slice(0, 3), null, 2));
console.log('\nlong assistant responses:', data.longResponses.length, '— sample:', data.longResponses.slice(0, 3));
console.log('\nmodel button text:', JSON.stringify(data.modelButton));
console.log('compose area present:', data.composeArea);
await b.close();
