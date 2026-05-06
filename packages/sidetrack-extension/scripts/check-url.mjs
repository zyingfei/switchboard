import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const chat = context.pages().find((p) => p.url().includes('69fa8f0f'));
const out = await chat.evaluate(() => ({
  href: location.href,
  origin: location.origin,
  pathname: location.pathname,
  search: location.search,
  hash: location.hash,
}));
console.log(JSON.stringify(out, null, 2));
await browser.close();
