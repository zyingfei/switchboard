import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const sw = b.contexts()[0].serviceWorkers().find(w => w.url().includes('background.js'));
const data = await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(['sidetrack.threads']);
  const threads = all['sidetrack.threads'] || [];
  return threads
    .filter(t => /hacker.*news|agentic|coding.*debate/i.test(t.title || ''))
    .map(t => ({
      bac_id: t.bac_id,
      title: t.title,
      threadUrl: t.threadUrl,
      primaryWorkstreamId: t.primaryWorkstreamId,
      lastSeenAt: t.lastSeenAt,
      provider: t.provider,
    }));
});
for (const t of data) console.log(JSON.stringify(t));
await b.close();
