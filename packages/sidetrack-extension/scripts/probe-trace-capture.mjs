import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
const state = await sw.evaluate(async () => {
  const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
  const cachedDispatches = (await get('sidetrack.recentDispatches')) ?? [];
  const cachedThreads = (await get('sidetrack.cachedThreads')) ?? [];
  const queuedCaptures = (await get('sidetrack.captureQueue')) ?? [];
  const dispatchDiagnostic = (await get('sidetrack.dispatchDiagnostic')) ?? null;
  return {
    dispatchCount: cachedDispatches.length,
    autoApprovedCount: cachedDispatches.filter((d) => d.mcpRequest?.approval === 'auto-approved').length,
    threadCount: Array.isArray(cachedThreads) ? cachedThreads.length : 'not-array',
    chatgptThreads: Array.isArray(cachedThreads) ? cachedThreads
      .filter((t) => t.provider === 'chatgpt')
      .map((t) => ({ bac_id: t.bac_id, url: t.threadUrl, title: t.title, lastSeenAt: t.lastSeenAt })) : [],
    queuedCaptureCount: Array.isArray(queuedCaptures) ? queuedCaptures.length : 'not-array',
    dispatchDiagnostic,
  };
});
console.log(JSON.stringify(state, null, 2));
await browser.close();
