import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
if (!sp) { console.log('no side panel'); process.exit(1); }
// 1. What background returns
const bgState = await sp.evaluate(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' });
  const t = r?.state?.threads?.find(x => x.threadUrl === 'https://gemini.google.com/app/45e8a50792869814');
  return t ? { bac_id: t.bac_id, title: t.title, primaryWorkstreamId: t.primaryWorkstreamId } : null;
});
console.log('background.getWorkboardState says:', JSON.stringify(bgState, null, 2));

// 2. What's in the rendered DOM
const domRow = await sp.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.thread'));
  const target = rows.find(r => /Hacker News.*Agentic Coding Debate/i.test(r.textContent || ''));
  if (!target) return { found: false, total: rows.length };
  const wsLabel = target.querySelector('.thread-ws-path')?.textContent;
  return {
    found: true,
    wsLabel,
    text: (target.textContent || '').slice(0, 120),
    classes: target.className,
  };
});
console.log('DOM row:', JSON.stringify(domRow, null, 2));

// 3. Active section / view
const view = await sp.evaluate(() => ({
  activeViewTab: document.querySelector('.view-tab.on')?.textContent,
  currentWsLabel: document.querySelector('.ws-bar .ws-current, .ws-current')?.textContent,
}));
console.log('view state:', JSON.stringify(view, null, 2));
await b.close();
