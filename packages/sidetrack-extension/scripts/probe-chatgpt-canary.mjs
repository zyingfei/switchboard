import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const pages = context.pages();
const chatPage = pages.find((p) => p.url().includes('chatgpt.com/c/'));
if (!chatPage) {
  console.error('No chatgpt.com/c/<id> tab open. Open one in CfT first.');
  process.exit(1);
}
console.log(`Inspecting: ${chatPage.url()}`);
await chatPage.bringToFront();
// Wait for content script to attempt extraction (canary fires at 1.2s)
await chatPage.waitForTimeout(2_000);
const canary = await chatPage.evaluate(() =>
  document.documentElement.getAttribute('data-sidetrack-provider-canary'),
);
console.log(`canary attribute: ${canary}`);
// Also check what the extension's directSources would match
const directSourceMatches = await chatPage.evaluate(() => {
  const selectors = [
    '[data-capture-turn]',
    'main [data-message-author-role], article[data-message-author-role]',
    'main article, main [data-testid*="conversation-turn"], main [data-testid*="message"]',
  ];
  return selectors.map((sel) => ({
    selector: sel,
    count: document.querySelectorAll(sel).length,
  }));
});
console.log('directSource matches:');
console.log(JSON.stringify(directSourceMatches, null, 2));
await browser.close();
