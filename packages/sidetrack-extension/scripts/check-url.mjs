import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const sp = browser.contexts()[0].pages().find(p => p.url().includes('sidepanel.html'));

const target = 'https://chatgpt.com/g/g-p-69e9ab0f1e04819191397ca941f85cf1/c/69ea6203-f6c4-832e-90d6-6fc0e0165d68';

const data = await sp.evaluate(async (url) => {
  // 1. Local thread cache
  const all = await chrome.storage.local.get(null);
  const threads = all['sidetrack.threads'] || [];
  const localMatch = threads.find(t => t.threadUrl === url || (t.threadUrl && url.includes(t.threadUrl)) || (t.threadUrl && t.threadUrl.includes(url.split('?')[0])));
  const localUrlSamples = threads.filter(t => /chatgpt/i.test(t.threadUrl || '')).map(t => ({ bac_id: t.bac_id, threadUrl: t.threadUrl, title: t.title }));

  // 2. Companion recall — query for unique bits of the url path
  const settings = all['sidetrack.settings'] || {};
  const port = settings.companion?.port || 17373;
  const bridgeKey = settings.companion?.bridgeKey || '';

  // 3. Health snapshot
  let health, recallByPath;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/system/health`, { headers: { 'x-bac-bridge-key': bridgeKey }});
    health = (await r.json()).data?.recall;
  } catch (e) { health = { err: String(e) }; }
  // Query recall for the chat id chunk
  const idSearch = '69ea6203-f6c4-832e-90d6-6fc0e0165d68';
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/recall/query?q=${encodeURIComponent(idSearch)}&limit=20`, { headers: { 'x-bac-bridge-key': bridgeKey }});
    recallByPath = (await r.json()).data;
  } catch (e) { recallByPath = { err: String(e) }; }

  return { localMatch, localUrlSamples: localUrlSamples.slice(0, 8), health, recallByPath };
}, target);

console.log('TARGET:', target);
console.log('\nlocal match:', JSON.stringify(data.localMatch, null, 2));
console.log('\nlocal chatgpt threads (sample):', JSON.stringify(data.localUrlSamples, null, 2));
console.log('\nrecall.health:', data.health);
console.log('\nrecall query results (first 5):');
const rows = Array.isArray(data.recallByPath) ? data.recallByPath : [];
for (const r of rows.slice(0, 5)) console.log(' ', { score: r.score?.toFixed(3), title: r.title?.slice(0, 50), threadUrl: r.threadUrl, bac_id: r.threadId });

await browser.close();
