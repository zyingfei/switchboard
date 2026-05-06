// Poll SW state every 10s for up to 3 min; report when a dispatch
// transitions from started → linked, and what URL the linked thread
// has. Use after clear-stuck-mcp-dispatches + extension reload.
import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
if (!sw) { console.error('SW not attached'); process.exit(1); }
const start = Date.now();
const timeoutMs = 3 * 60 * 1000;
let lastSnap = '';
while (Date.now() - start < timeoutMs) {
  const snap = await sw.evaluate(async () => {
    const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
    const started = (await get('sidetrack.mcpAutoDispatched')) ?? {};
    const links = (await get('sidetrack.dispatchLinks')) ?? {};
    const threads = (await get('sidetrack.cachedThreads')) ?? [];
    const linkedThreadInfo = {};
    for (const [dispatchId, threadBacId] of Object.entries(links)) {
      const t = Array.isArray(threads) ? threads.find((x) => x.bac_id === threadBacId) : undefined;
      linkedThreadInfo[dispatchId] = t ? { bac_id: t.bac_id, url: t.threadUrl, lastSeenAt: t.lastSeenAt, title: t.title } : { bac_id: threadBacId };
    }
    const tabs = await chrome.tabs.query({});
    const chatgptTabs = tabs.filter((t) => t.url?.includes('chatgpt.com'))
      .map((t) => ({ id: t.id, url: t.url, active: t.active }));
    return { started, links, linkedThreadInfo, chatgptTabs };
  });
  const fp = JSON.stringify(snap);
  if (fp !== lastSnap) {
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[${elapsed}s]`, JSON.stringify(snap, null, 2));
    lastSnap = fp;
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
await browser.close();
