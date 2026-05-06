import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
const out = await sw.evaluate(async () => {
  // Multiple ways of reading the same key
  const a = await new Promise((r) => chrome.storage.local.get('sidetrack.settings', (v) => r(v)));
  const b = await new Promise((r) => chrome.storage.local.get(['sidetrack.settings'], (v) => r(v)));
  const c = await new Promise((r) => chrome.storage.local.get({ 'sidetrack.settings': undefined }, (v) => r(v)));
  const d = await new Promise((r) => chrome.storage.local.get({ 'sidetrack.settings': 'DEFAULT' }, (v) => r(v)));
  // Also dump all keys
  const all = await new Promise((r) => chrome.storage.local.get(null, (v) => r(Object.keys(v))));
  return { a, b, c, d, allKeys: all };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
