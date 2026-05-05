import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const sp = b.contexts()[0].pages().find(p => p.url().includes('sidepanel.html'));
const data = await sp.evaluate(async () => {
  const resp = await chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' });
  const threads = resp?.state?.threads || [];
  return {
    count: threads.length,
    sample: threads.slice(0, 5).map(t => ({ bac_id: t.bac_id, threadUrl: t.threadUrl, status: t.status, primaryWorkstreamId: t.primaryWorkstreamId })),
  };
});
console.log(JSON.stringify(data, null, 2));
await b.close();
