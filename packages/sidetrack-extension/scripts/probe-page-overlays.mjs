import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const chat = context.pages().find((p) => p.url().includes('69fa8f0f'));
if (!chat) { console.log('chat tab not found'); process.exit(1); }
const out = await chat.evaluate(() => ({
  url: location.href,
  title: document.title,
  canary: document.documentElement.getAttribute('data-sidetrack-provider-canary'),
  overlayRoot: document.getElementById('sidetrack-overlay-root') !== null,
  highlightCount: document.querySelectorAll('.sidetrack-ann-highlight').length,
  marginCount: document.querySelectorAll('.sidetrack-ann-margin').length,
  hintCount: document.querySelectorAll('.sidetrack-ann-hint').length,
}));
console.log(JSON.stringify(out, null, 2));
await browser.close();
