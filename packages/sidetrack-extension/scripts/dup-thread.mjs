import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const sw = b.contexts()[0].serviceWorkers().find(w => w.url().includes('background.js'));
const target = 'https://gemini.google.com/app/45e8a50792869814';
const data = await sw.evaluate(async ({ target }) => {
  const all = await chrome.storage.local.get(null);
  const threads = all['sidetrack.threads'] || [];
  const sameUrl = threads.filter(t => t.threadUrl === target ||
    (t.threadUrl?.includes('45e8a50792869814')) ||
    target.includes(t.threadUrl?.split('?')[0] ?? '__none__'));
  return {
    matches: sameUrl.map(t => ({
      bac_id: t.bac_id, title: t.title, threadUrl: t.threadUrl,
      primaryWorkstreamId: t.primaryWorkstreamId,
      lastSeenAt: t.lastSeenAt, status: t.status,
    })),
    totalThreads: threads.length,
  };
}, { target });
console.log(JSON.stringify(data, null, 2));
await b.close();
