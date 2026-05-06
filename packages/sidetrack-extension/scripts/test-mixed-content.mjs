import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
const out = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  const target = tabs.find((t) => t.url?.includes('69fa8f0f'));
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: target.id },
    world: 'ISOLATED',
    func: async () => {
      const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
      const settings = await get('sidetrack.settings');
      const port = settings.companion.port;
      const bridgeKey = settings.companion.bridgeKey;
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/v1/annotations?url=${encodeURIComponent(window.location.href)}`, {
          headers: { 'x-bac-bridge-key': bridgeKey },
        });
        const body = await resp.json();
        return { ok: true, status: resp.status, count: body?.data?.length ?? 0 };
      } catch (e) {
        return { ok: false, error: String(e), name: e.name };
      }
    },
  });
  return result;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
