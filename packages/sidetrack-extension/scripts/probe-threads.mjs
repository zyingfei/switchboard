import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
const state = await sw.evaluate(async () => {
  const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
  const threads = (await get('sidetrack.threads')) ?? [];
  const queue = (await get('sidetrack.captureQueue')) ?? [];
  const diag = (await get('sidetrack.dispatchDiagnostic')) ?? null;
  return {
    threadCount: Array.isArray(threads) ? threads.length : 'not-array',
    chatgptThreads: Array.isArray(threads) ? threads
      .filter((t) => t.provider === 'chatgpt')
      .map((t) => ({ bac_id: t.bac_id, url: t.threadUrl, title: t.title, lastSeenAt: t.lastSeenAt })) : [],
    queueCount: Array.isArray(queue) ? queue.length : 'not-array',
    dispatchDiagnostic: diag,
  };
});
console.log(JSON.stringify(state, null, 2));
await browser.close();
