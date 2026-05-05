import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const page = b.contexts()[0].pages().find(p => /chatgpt\.com\/c\//.test(p.url()));
if (!page) process.exit(1);
const data = await page.evaluate(() => {
  const findByPattern = (sel) => Array.from(document.querySelectorAll(sel)).slice(0, 4).map(el => ({
    tag: el.tagName,
    cls: (el.className?.toString?.() || '').slice(0, 80),
    aria: el.getAttribute('aria-label'),
    testid: el.getAttribute('data-testid'),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
  }));
  return {
    switchModel: findByPattern('[aria-label="Switch model"]'),
    switchModelLoose: findByPattern('[aria-label*="Switch"]'),
    modelTestid: findByPattern('button[data-testid*="model"]'),
    modelClass: findByPattern('[class*="model"]'),
    composerHeader: findByPattern('header button, header [role="button"]'),
    topButtons: findByPattern('button[aria-haspopup="menu"]'),
  };
});
console.log(JSON.stringify(data, null, 2));
await b.close();
