import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().startsWith('https://chatgpt.com/'));
if (!page) { console.log('no chatgpt page'); process.exit(1); }
const probe = await page.evaluate(async () => {
  const out = {};
  try {
    const all = await chrome.storage.local.get(null);
    out.keys = Object.keys(all).slice(0, 30);
    out.settingsRaw = all['sidetrack.settings'];
    out.settingsCompanion = all['sidetrack.settings']?.companion;
    out.bridgeKeyLen = all['sidetrack.settings']?.companion?.bridgeKey?.length;
    out.port = all['sidetrack.settings']?.companion?.port;
  } catch (e) { out.storageErr = String(e); }
  // Try calling fetch from content-script context to companion
  try {
    const r = await fetch('http://127.0.0.1:17373/v1/system/health', {
      headers: { 'x-bac-bridge-key': out.settingsCompanion?.bridgeKey || '' },
    });
    out.fetchStatus = r.status;
    out.fetchBody = (await r.text()).slice(0, 200);
  } catch (e) { out.fetchErr = String(e); }
  return out;
});
console.log(JSON.stringify(probe, null, 2));
await browser.close();
