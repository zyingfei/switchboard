import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const sw = b.contexts()[0].serviceWorkers().find(w => w.url().includes('background.js'));
const data = await sw.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const threads = all['sidetrack.threads'] || [];
  const recentDispatches = all['sidetrack.recentDispatches'] || [];
  const liveSet = new Set(threads.map(t => t.bac_id));
  const titleMatchPossible = recentDispatches.filter(d => {
    if (d.title?.startsWith('DDIA')) return true;
    return false;
  });
  return {
    totalDispatches: recentDispatches.length,
    ddiaDispatches: titleMatchPossible.map(d => ({
      bac_id: d.bac_id, title: d.title, sourceThreadId: d.sourceThreadId,
      sourceLive: d.sourceThreadId !== undefined && liveSet.has(d.sourceThreadId),
      target: d.target, status: d.status,
    })),
  };
});
console.log(JSON.stringify(data, null, 2));
await b.close();
