// Direct test of the batched index path against the running
// companion. Bypasses sendToCompanion / autoCapture gates so we
// isolate the server-side batch ingestion.
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const refreshSW = () => ctx.serviceWorkers().find(w => w.url().includes('background.js'));
let sw = refreshSW();
if (!sw) { console.error('missing SW'); process.exit(1); }
const wakeSW = async () => {
  // chrome.runtime calls also wake an idle SW; running a tiny eval
  // until it succeeds keeps the rest of the script simple.
  for (let i = 0; i < 5; i += 1) {
    try {
      sw = refreshSW();
      if (sw) await sw.evaluate(() => 1);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 400));
    }
  }
};

const fetchHealth = async () => {
  await wakeSW();
  return sw.evaluate(async () => {
    const all = await chrome.storage.local.get(['sidetrack.settings']);
    const port = all['sidetrack.settings']?.companion?.port || 17373;
    const key = all['sidetrack.settings']?.companion?.bridgeKey || '';
    const r = await fetch(`http://127.0.0.1:${port}/v1/system/health`, { headers: { 'x-bac-bridge-key': key }});
    return (await r.json()).data?.recall;
  });
};

const before = await fetchHealth();
console.log('before:', { entries: before.entryCount, eventTurns: before.eventTurnCount });

// Send a 3-item batch via the SW context (extension origin).
const stamp = Date.now().toString(36);
await wakeSW();
const result = await sw.evaluate(async ({ stamp }) => {
  const all = await chrome.storage.local.get(['sidetrack.settings']);
  const port = all['sidetrack.settings']?.companion?.port || 17373;
  const key = all['sidetrack.settings']?.companion?.bridgeKey || '';
  const items = [0, 1, 2].map((i) => ({
    id: `recall-batch-${stamp}:${i}`,
    threadId: `recall-batch-${stamp}`,
    capturedAt: new Date().toISOString(),
    text: `batch turn ${i} probe content for recall index increment test ${stamp}`,
  }));
  const r = await fetch(`http://127.0.0.1:${port}/v1/recall/index`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bac-bridge-key': key },
    body: JSON.stringify({ items }),
  });
  return { status: r.status, body: await r.text() };
}, { stamp });
console.log('post status:', result.status, 'body:', result.body.slice(0, 120));

// Companion's appendEntry write is awaited inside the route handler,
// but the embedder takes time. Wait a few seconds for embeds to land.
await new Promise(r => setTimeout(r, 4000));

const after = await fetchHealth();
console.log('after :', { entries: after.entryCount, eventTurns: after.eventTurnCount });
console.log('delta entries:', after.entryCount - before.entryCount);

await browser.close();
