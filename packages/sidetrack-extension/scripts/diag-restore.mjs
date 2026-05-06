import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));

// First confirm the new build is loaded (search bundle for the new sentinel)
const swCode = await sw.evaluate(async () => {
  const url = chrome.runtime.getURL('background.js');
  const text = await fetch(url).then(r => r.text());
  return {
    hasListAnnotations: text.includes('listAnnotationsByUrl') || text.includes('annotation.listByUrl'),
    hasMarkdownStrip: text.includes('[*_`~#>]') || text.includes('[*_`~#>]'),
    bytes: text.length,
  };
});
console.log('SW build check:', JSON.stringify(swCode));

const tabs = await sw.evaluate(() => chrome.tabs.query({}).then(t => t.filter(x => x.url?.includes('69fa8f0f')).map(x => ({id: x.id, url: x.url}))));
console.log('chat tab:', JSON.stringify(tabs));
if (tabs.length === 0) { process.exit(0); }
const tabId = tabs[0].id;

// Inject diagnostic into isolated world: try direct fetch, then SW message, return results.
const result = await sw.evaluate(async (id) => {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: id },
    world: 'ISOLATED',
    func: async () => {
      const out = { url: location.href, direct: null, sw: null, errors: [] };
      // Try direct fetch
      try {
        const settings = await new Promise((r) => chrome.storage.local.get('sidetrack.settings', (v) => r(v['sidetrack.settings'])));
        const port = settings?.companion?.port;
        const bridgeKey = settings?.companion?.bridgeKey;
        const resp = await fetch(`http://127.0.0.1:${port}/v1/annotations?url=${encodeURIComponent(location.href)}`, { headers: { 'x-bac-bridge-key': bridgeKey } });
        const body = await resp.json();
        out.direct = { status: resp.status, count: body?.data?.length ?? 0 };
      } catch (e) { out.direct = { error: String(e) }; }
      // Try SW route
      try {
        const r = await chrome.runtime.sendMessage({
          type: 'sidetrack.annotation.listByUrl',
          url: location.href,
        });
        out.sw = { ok: r?.ok, count: r?.annotations?.length ?? 0, error: r?.error };
      } catch (e) { out.sw = { error: String(e) }; }
      // Check overlay state
      out.overlayRoot = document.getElementById('sidetrack-overlay-root') !== null;
      out.highlights = document.querySelectorAll('.sidetrack-ann-highlight').length;
      out.canary = document.documentElement.getAttribute('data-sidetrack-provider-canary');
      return out;
    },
  });
  return result;
}, tabId);
console.log(JSON.stringify(result, null, 2));
await browser.close();
