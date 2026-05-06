import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const chat = context.pages().find((p) => p.url().includes('69fa8f0f'));
const out = await chat.evaluate(() => {
  const titles = Array.from(document.querySelectorAll('.sidetrack-ann-highlight'))
    .map((el) => (el.title || '').slice(0, 40));
  return {
    highlightCount: document.querySelectorAll('.sidetrack-ann-highlight').length,
    marginCount: document.querySelectorAll('.sidetrack-ann-margin').length,
    highlightTitles: [...new Set(titles)],
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
