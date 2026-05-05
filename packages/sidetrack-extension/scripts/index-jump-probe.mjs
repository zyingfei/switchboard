// Proves incremental indexing now covers every turn of a capture
// event. Compares the companion's recall.entryCount before and
// after a synthetic capture submitted via the SW's existing path.
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
const sw = ctx.serviceWorkers().find(w => w.url().includes('background.js'));
if (!sp || !sw) { console.error('missing pages'); process.exit(1); }

await sp.reload();
await sp.waitForLoadState('networkidle');
await new Promise(r => setTimeout(r, 1500));

// Helper to read recall.entryCount via the side panel's storage.
const fetchHealth = async () => sp.evaluate(async () => {
  const all = await chrome.storage.local.get(['sidetrack.settings']);
  const port = all['sidetrack.settings']?.companion?.port || 17373;
  const key = all['sidetrack.settings']?.companion?.bridgeKey || '';
  const r = await fetch(`http://127.0.0.1:${port}/v1/system/health`, { headers: { 'x-bac-bridge-key': key }});
  return (await r.json()).data?.recall;
});

const before = await fetchHealth();
console.log('before:', { entries: before.entryCount, eventTurns: before.eventTurnCount, drift: before.eventTurnCount - before.entryCount });

// Build a synthetic 3-turn capture event and POST through the
// background SW (uses sendToCompanion, the path we just fixed).
const probeUrl = `https://chatgpt.com/c/probe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const result = await sw.evaluate(async ({ url }) => {
  const message = {
    type: 'sidetrack.capture.auto',
    capture: {
      provider: 'chatgpt',
      threadUrl: url,
      threadId: url.split('/').pop(),
      title: 'Index-jump probe (synthetic 3 turns)',
      capturedAt: new Date().toISOString(),
      tabSnapshot: {
        tabId: 99999,
        windowId: 99999,
        url,
        title: 'Index-jump probe',
        capturedAt: new Date().toISOString(),
      },
      turns: [
        { ordinal: 0, role: 'user', text: 'Probe turn one — first user message about caching.', capturedAt: new Date().toISOString() },
        { ordinal: 1, role: 'assistant', text: 'Probe turn two — assistant response describing recall index drift fix.', capturedAt: new Date().toISOString() },
        { ordinal: 2, role: 'user', text: 'Probe turn three — closing user follow-up about systematic review.', capturedAt: new Date().toISOString() },
      ],
    },
  };
  const r = await chrome.runtime.sendMessage(message);
  return r;
}, { url: probeUrl });
console.log('capture sw response.ok =', result?.ok);

await new Promise(r => setTimeout(r, 2500));
const after = await fetchHealth();
console.log('after :', { entries: after.entryCount, eventTurns: after.eventTurnCount, drift: after.eventTurnCount - after.entryCount });
console.log('delta entryCount:', after.entryCount - before.entryCount);
console.log('delta eventTurnCount:', after.eventTurnCount - before.eventTurnCount);

await browser.close();
