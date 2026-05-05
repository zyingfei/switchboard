import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
// service workers live on the BrowserContext, not on contexts[0]
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
if (!sw) {
  console.log('No background SW. Active service workers:');
  for (const w of context.serviceWorkers()) console.log('  -', w.url());
  process.exit(1);
}
console.log(`SW: ${sw.url()}`);
const state = await sw.evaluate(async () => {
  const get = (key) => new Promise((res) => chrome.storage.local.get(key, (v) => res(v[key])));
  const dispatches = await get('sidetrack.dispatches');
  const mcpStarted = await get('sidetrack.mcpAutoDispatched');
  const links = await get('sidetrack.dispatchLinks');
  const settings = await get('sidetrack.settings');
  const alarms = await chrome.alarms.getAll();
  return {
    dispatches: Array.isArray(dispatches) ? dispatches.map((d) => ({
      bac_id: d.bac_id,
      kind: d.kind,
      target: d.target,
      title: d.title,
      status: d.status,
      mcpRequest: d.mcpRequest,
      createdAt: d.createdAt,
    })) : dispatches,
    mcpStarted,
    links,
    hasSettings: !!settings,
    alarms: alarms.map((a) => ({
      name: a.name,
      scheduledTime: new Date(a.scheduledTime).toISOString(),
      periodInMinutes: a.periodInMinutes,
    })),
  };
});
console.log(JSON.stringify(state, null, 2));
await browser.close();
