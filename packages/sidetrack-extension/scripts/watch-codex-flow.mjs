import { chromium } from '@playwright/test';
const cdpUrl = 'http://localhost:9222';
const browser = await chromium.connectOverCDP(cdpUrl);
const [context] = browser.contexts();

const start = Date.now();
const timeoutMs = 4 * 60 * 1000;
let lastFingerprint = '';
let prints = 0;

const ts = () => new Date().toISOString().slice(11, 19);
const elapsed = () => Math.round((Date.now() - start) / 1000) + 's';

while (Date.now() - start < timeoutMs) {
  const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
  if (!sw) {
    if (lastFingerprint !== 'no-sw') {
      console.log(`[${ts()} +${elapsed()}] SW dormant (Chrome MV3 evicts on idle).`);
      lastFingerprint = 'no-sw';
    }
    await new Promise((r) => setTimeout(r, 15_000));
    continue;
  }
  let snap;
  try {
    snap = await sw.evaluate(async () => {
      const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
      const dispatches = (await get('sidetrack.recentDispatches')) ?? [];
      const autoApproved = Array.isArray(dispatches)
        ? dispatches
            .filter((d) => d?.mcpRequest?.approval === 'auto-approved')
            .map((d) => ({ bac_id: d.bac_id, createdAt: d.createdAt, title: d.title }))
        : [];
      const links = (await get('sidetrack.dispatchLinks')) ?? {};
      const dispatchTabs = (await get('sidetrack.mcpDispatchTabs')) ?? {};
      const lastOpenedAt = (await get('sidetrack.lastMcpDispatchOpenedAt')) ?? '';
      const threads = (await get('sidetrack.threads')) ?? [];
      const chatgptThreads = Array.isArray(threads)
        ? threads
            .filter((t) => t.provider === 'chatgpt')
            .map((t) => ({ bac_id: t.bac_id, url: t.threadUrl, title: t.title, lastSeenAt: t.lastSeenAt }))
        : [];
      const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
      const chatgptTabs = tabs.map((t) => ({ url: t.url, status: t.status, active: t.active }));
      return { autoApproved, links, dispatchTabs, lastOpenedAt, chatgptThreads, chatgptTabs };
    });
  } catch (error) {
    console.log(`[${ts()} +${elapsed()}] SW probe failed (likely evicted mid-eval): ${error.message?.slice(0, 80)}`);
    await new Promise((r) => setTimeout(r, 15_000));
    continue;
  }
  const fp = JSON.stringify(snap);
  if (fp !== lastFingerprint) {
    console.log(`[${ts()} +${elapsed()}]`);
    console.log(JSON.stringify(snap, null, 2));
    lastFingerprint = fp;
    prints += 1;
  }
  await new Promise((r) => setTimeout(r, 15_000));
}
console.log(`\nWatch ended. ${prints} state prints.`);
await browser.close();
