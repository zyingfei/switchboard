import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
const sw = ctx.serviceWorkers().find(w => w.url().includes('background.js'));

// Get target.
const target = await sp.evaluate(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' });
  return r?.state?.threads?.[0];
});
console.log('target:', target.bac_id, '/', target.threadUrl);

// Run the same lookup the handler does, but from the side panel
// directly, AND try to set the class manually to verify the React
// path is even reachable from outside.
const probe = await sp.evaluate(async ({ url, bacId }) => {
  // 1. Re-fetch state to mirror the listener's stateRef.current.
  const stateResp = await chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' });
  const threads = stateResp?.state?.threads || [];
  const match = threads.find(t => t.threadUrl === url);
  // 2. Look at every .thread row's INNERHTML/inner text to try to
  //    figure out which one corresponds to the target bac_id.
  const rows = Array.from(document.querySelectorAll('.thread'));
  const rowSnippets = rows.slice(0, 5).map(r => ({
    cls: r.className,
    text: (r.textContent || '').slice(0, 80),
    keyAttr: r.getAttribute('data-key') || null,
  }));
  // 3. Manually attempt to add `.focusing` to the first row to see
  //    if the React render system clobbers it on the next tick.
  if (rows[0]) rows[0].classList.add('focusing');
  return {
    matchFound: !!match,
    matchBacId: match?.bac_id,
    rowCount: rows.length,
    rowSnippets,
    afterManualAdd: rows[0]?.className,
  };
}, { url: target.threadUrl, bacId: target.bac_id });
console.log('\nprobe result:', JSON.stringify(probe, null, 2));

// Wait a tick then check if React clobbered the manually-added class.
await new Promise(r => setTimeout(r, 200));
const afterTick = await sp.evaluate(() => {
  const focused = document.querySelectorAll('.thread.focusing');
  return Array.from(focused).map(f => (f.textContent || '').slice(0, 60));
});
console.log('after 200ms — focusing rows:', afterTick);

await browser.close();
