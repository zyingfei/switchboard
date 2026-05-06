import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
if (!sw) { console.log('SW dormant'); process.exit(1); }
const result = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const target = tabs.find((t) => t.url?.includes('69fa8f0f'));
  if (!target?.id) return { error: 'tab not found' };
  await chrome.tabs.reload(target.id, { bypassCache: false });
  return { ok: true, tabId: target.id, url: target.url };
});
console.log('Reload result:', JSON.stringify(result));
// Wait for content script to boot + run restore at 1.5s.
await new Promise((r) => setTimeout(r, 5_000));
const chat = context.pages().find((p) => p.url().includes('69fa8f0f'));
const after = await chat.evaluate(() => ({
  canary: document.documentElement.getAttribute('data-sidetrack-provider-canary'),
  overlayRoot: document.getElementById('sidetrack-overlay-root') !== null,
  highlights: document.querySelectorAll('.sidetrack-ann-highlight').length,
  margins: document.querySelectorAll('.sidetrack-ann-margin').length,
  highlightTitles: Array.from(document.querySelectorAll('.sidetrack-ann-highlight'))
    .map((el) => (el.title || '').slice(0, 40))
    .slice(0, 8),
}));
console.log('After 5s:', JSON.stringify(after, null, 2));
await browser.close();
