import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const pages = context.pages();
// Find the existing chat tab from the previous probe
const chatPage = pages.find((p) => p.url().includes('chatgpt.com/c/'));
if (!chatPage) {
  console.log('No chat tab open. Run probe-chatgpt-autosend.mjs first or open a chat manually.');
  process.exit(1);
}
console.log(`Inspecting: ${chatPage.url()}`);
const survey = await chatPage.evaluate(() => {
  const candidates = [
    'article[data-message-author-role]',
    '[data-message-author-role]',
    '[data-testid^="conversation-turn"]',
    '[data-testid*="conversation"]',
    '.text-message',
    'main article',
    'main [data-testid]',
  ];
  const out = {};
  for (const sel of candidates) {
    out[sel] = document.querySelectorAll(sel).length;
  }
  // Also: walk a few elements that look like message turns
  const sample = [];
  for (const el of document.querySelectorAll('main *')) {
    if (sample.length >= 8) break;
    const role = el.getAttribute('data-message-author-role');
    const testid = el.getAttribute('data-testid');
    if (role || (testid && testid.includes('turn'))) {
      sample.push({
        tag: el.tagName.toLowerCase(),
        role,
        testid,
        textHead: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 80),
      });
    }
  }
  return { counts: out, sample };
});
console.log(JSON.stringify(survey, null, 2));
await browser.close();
