// One-shot cleanup: remove `mcpAutoDispatched` + `dispatchLinks`
// entries for any auto-approved-MCP dispatch in the cache. Lets the
// background alarm retry them with the latest content-script logic.
// No data is read except the keys/values we explicitly target.
import { chromium } from '@playwright/test';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const [context] = browser.contexts();
const sw = context.serviceWorkers().find((w) => w.url().includes('background.js'));
if (!sw) {
  console.error('background SW not attached');
  process.exit(1);
}
const result = await sw.evaluate(async () => {
  const get = (k) => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k])));
  const set = (k, v) => new Promise((r) => chrome.storage.local.set({ [k]: v }, () => r()));
  const dispatches = (await get('sidetrack.recentDispatches')) ?? [];
  const mcpStarted = { ...((await get('sidetrack.mcpAutoDispatched')) ?? {}) };
  const links = { ...((await get('sidetrack.dispatchLinks')) ?? {}) };
  const cleared = [];
  for (const d of dispatches) {
    if (d?.mcpRequest?.approval === 'auto-approved' && d?.target?.mode === 'auto-send') {
      if (mcpStarted[d.bac_id] !== undefined) {
        cleared.push({ bac_id: d.bac_id, hadStarted: true, hadLink: links[d.bac_id] ?? null });
        delete mcpStarted[d.bac_id];
      }
      if (links[d.bac_id] !== undefined) {
        delete links[d.bac_id];
      }
    }
  }
  await set('sidetrack.mcpAutoDispatched', mcpStarted);
  await set('sidetrack.dispatchLinks', links);
  return { cleared, remainingStarted: Object.keys(mcpStarted), remainingLinks: Object.keys(links) };
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
