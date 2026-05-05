import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
const data = await sp.evaluate(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' });
  const stored = r?.state?.threads || [];
  // Try to match each rendered .thread to a stored thread by title.
  const rows = Array.from(document.querySelectorAll('.thread'));
  const renderedTitles = rows.map(row => {
    const text = row.textContent || '';
    return text;
  });
  const renderedBacIds = stored
    .filter(t => renderedTitles.some(r => r.includes(t.title)))
    .map(t => ({ bac_id: t.bac_id, title: t.title?.slice(0, 50) }));
  const notRenderedBacIds = stored
    .filter(t => !renderedTitles.some(r => r.includes(t.title)))
    .map(t => ({ bac_id: t.bac_id, title: t.title?.slice(0, 50), threadUrl: t.threadUrl, status: t.status }));
  return {
    storedCount: stored.length,
    renderedCount: rows.length,
    renderedBacIds: renderedBacIds.slice(0, 3),
    notRenderedBacIds: notRenderedBacIds,
  };
});
console.log(JSON.stringify(data, null, 2));
await browser.close();
