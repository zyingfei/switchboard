import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
if (!sw) { console.error('SW not attached'); process.exit(1); }
const state = await sw.evaluate(async () => {
  const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
  const dispatches = (await get('sidetrack.recentDispatches')) ?? [];
  const autoApproved = Array.isArray(dispatches)
    ? dispatches.filter((d) => d?.mcpRequest?.approval === 'auto-approved').map((d) => ({
        bac_id: d.bac_id,
        title: d.title,
        target: d.target,
      }))
    : [];
  return {
    autoApprovedDispatches: autoApproved,
    mcpStarted: (await get('sidetrack.mcpAutoDispatched')) ?? {},
    links: (await get('sidetrack.dispatchLinks')) ?? {},
    dispatchTabs: (await get('sidetrack.mcpDispatchTabs')) ?? {},
    alarms: (await chrome.alarms.getAll()).map((a) => ({
      name: a.name,
      periodInMinutes: a.periodInMinutes,
      scheduledTime: new Date(a.scheduledTime).toISOString(),
    })),
    chatgptTabCount: (await chrome.tabs.query({ url: 'https://chatgpt.com/*' })).length,
  };
});
console.log(JSON.stringify(state, null, 2));
await browser.close();
