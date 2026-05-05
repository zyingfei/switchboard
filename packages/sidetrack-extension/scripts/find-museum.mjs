import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const sp = b.contexts()[0].pages().find(p => p.url().includes('sidepanel.html'));
const data = await sp.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const threads = all['sidetrack.threads'] || [];
  const queueItems = all['sidetrack.queueItems'] || [];
  const dispatches = all['sidetrack.recentDispatches'] || [];
  return {
    threadHits: threads.filter(t => /washington|museum/i.test(t.title || t.threadUrl || '')),
    threadTitles: threads.map(t => ({ bac_id: t.bac_id, title: t.title, status: t.status })),
  };
});
console.log('threads matching washington/museum:', JSON.stringify(data.threadHits, null, 2));
console.log('\nall thread titles:');
for (const t of data.threadTitles) console.log(' ', t.bac_id, '|', t.status, '|', t.title);
await b.close();
