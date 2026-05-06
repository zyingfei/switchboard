import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
const out = await sw.evaluate(async () => {
  const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
  const settings = await get('sidetrack.settings');
  // Show the structure (not the actual key — just types/lengths)
  const desc = (v) => {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'object') {
      const entries = {};
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === 'object' && val !== null) {
          entries[k] = `<object>(${Object.keys(val).join(',')})`;
        } else if (typeof val === 'string') {
          entries[k] = `<string len=${val.length}>`;
        } else {
          entries[k] = `<${typeof val}>${String(val).slice(0, 40)}`;
        }
      }
      return entries;
    }
    return `<${typeof v}>`;
  };
  return {
    settingsTopKeys: settings ? Object.keys(settings) : null,
    structure: desc(settings),
    companion: desc(settings?.companion),
    portType: typeof settings?.companion?.port,
    bridgeKeyType: typeof settings?.companion?.bridgeKey,
    bridgeKeyLen: typeof settings?.companion?.bridgeKey === 'string' ? settings.companion.bridgeKey.length : 0,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
