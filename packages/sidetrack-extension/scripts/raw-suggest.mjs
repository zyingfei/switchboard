import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
const sw = ctx.serviceWorkers().find(w => w.url().includes('background.js'));

const probeCtx = sp ?? sw;
const data = await probeCtx.evaluate(async () => {
  const all = await chrome.storage.local.get(['sidetrack.settings', 'sidetrack.threads']);
  const port = all['sidetrack.settings']?.companion?.port || 17373;
  const key = all['sidetrack.settings']?.companion?.bridgeKey || '';
  const target = 'https://chatgpt.com/c/69f8db62-5428-832e-9ae0-b8bfb9da3530';
  const thread = (all['sidetrack.threads'] || []).find(t => t.threadUrl === target);
  if (!thread) return { error: 'no local thread' };
  // Hit with threshold=0 to see ALL scores
  const r = await fetch(`http://127.0.0.1:${port}/v1/suggestions/thread/${thread.bac_id}?limit=20&threshold=0`, {
    headers: { 'x-bac-bridge-key': key }
  });
  return { status: r.status, body: await r.text() };
});
console.log('status:', data.status);
console.log('body:', data.body);
await b.close();
