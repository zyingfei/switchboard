import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
if (!sw) { console.log('SW dormant - open side panel briefly'); process.exit(1); }
// Use SW to fetch annotations directly via companion API.
const result = await sw.evaluate(async () => {
  const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
  const settings = await get('sidetrack.settings');
  const port = settings?.companion?.port;
  const bridgeKey = settings?.companion?.bridgeKey;
  if (!port || !bridgeKey) return { error: 'no settings', settings };
  const url = `http://127.0.0.1:${port}/v1/annotations?url=${encodeURIComponent('https://chatgpt.com/c/69fa8f0f-8b24-8330-be54-7de1740f11bc')}`;
  const resp = await fetch(url, { headers: { 'x-bac-bridge-key': bridgeKey } });
  const body = await resp.json();
  return { status: resp.status, count: body?.data?.length ?? 0, sample: body?.data?.[0]?.anchor };
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
