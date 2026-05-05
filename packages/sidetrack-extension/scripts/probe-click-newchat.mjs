import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const page = await context.newPage();
await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5_000);
console.log(`before: ${page.url()}`);
const result = await page.evaluate(() => {
  const el = document.querySelector('a[data-testid="create-new-chat-button"]');
  if (!(el instanceof HTMLElement)) return 'no-button';
  el.click();
  return 'clicked';
});
console.log(`click: ${result}`);
await page.waitForTimeout(2_500);
console.log(`after:  ${page.url()}`);
await page.close();
await browser.close();
