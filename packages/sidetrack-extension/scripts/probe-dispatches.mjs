import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
const dispatches = await sw.evaluate(async () => {
  const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
  const recent = await get('sidetrack.recentDispatches');
  return Array.isArray(recent) ? recent : recent;
});
console.log(JSON.stringify(dispatches, null, 2));
await browser.close();
