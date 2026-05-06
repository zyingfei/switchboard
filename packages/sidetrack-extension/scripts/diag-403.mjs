import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));

// Same call from SW context for comparison
const swResult = await sw.evaluate(async () => {
  const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
  const settings = await get('sidetrack.settings');
  const port = settings.companion.port;
  const bridgeKey = settings.companion.bridgeKey;
  const resp = await fetch(`http://127.0.0.1:${port}/v1/annotations?url=${encodeURIComponent('https://chatgpt.com/c/69fa8f0f-8b24-8330-be54-7de1740f11bc')}`, {
    headers: { 'x-bac-bridge-key': bridgeKey },
  });
  const body = await resp.json();
  return { context: 'SW', port, bridgeKeyHead: bridgeKey.slice(0, 8), bridgeKeyTail: bridgeKey.slice(-4), bridgeKeyLen: bridgeKey.length, status: resp.status, count: body?.data?.length ?? 0, errorBody: resp.status >= 400 ? body : undefined };
});
console.log('SW:', JSON.stringify(swResult, null, 2));

const isoResult = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const target = tabs.find((t) => t.url?.includes('69fa8f0f'));
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: target.id },
    world: 'ISOLATED',
    func: async () => {
      const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
      const settings = await get('sidetrack.settings');
      const port = settings?.companion?.port;
      const bridgeKey = settings?.companion?.bridgeKey ?? '';
      const resp = await fetch(`http://127.0.0.1:${port}/v1/annotations?url=${encodeURIComponent('https://chatgpt.com/c/69fa8f0f-8b24-8330-be54-7de1740f11bc')}`, {
        headers: { 'x-bac-bridge-key': bridgeKey },
      });
      const body = await resp.json();
      return { context: 'CONTENT', port, bridgeKeyHead: bridgeKey.slice(0, 8), bridgeKeyTail: bridgeKey.slice(-4), bridgeKeyLen: bridgeKey.length, status: resp.status, count: body?.data?.length ?? 0, errorBody: resp.status >= 400 ? body : undefined };
    },
  });
  return result;
});
console.log('Content:', JSON.stringify(isoResult, null, 2));
await browser.close();
