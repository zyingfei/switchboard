import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
const sw = ctx.serviceWorkers().find(w => w.url().includes('background.js'));

const target = await sp.evaluate(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' });
  return r?.state?.threads?.[0];
});
console.log('target:', target.bac_id, '/', target.threadUrl);

// Install a mirror handler that logs each step.
await sp.evaluate(() => {
  window.__trace = [];
  const log = (...a) => window.__trace.push(a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '));

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'sidetrack.sidepanel.focusThread') return;
    log('step 1: handler entered, message=', message);
    setTimeout(async () => {
      log('step 2: setTimeout fired');
      // We can't read stateRef directly. Re-fetch state from background
      // (this matches what the live state should be).
      const stateResp = await chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' });
      const threads = stateResp?.state?.threads || [];
      log('step 3: threads count=', threads.length);
      const match = threads.find(t => t.threadUrl === message.threadUrl);
      log('step 4: match found=', !!match, 'bac_id=', match?.bac_id);
      if (!match) return;
      const rows = Array.from(document.querySelectorAll('.thread'));
      log('step 5: row count=', rows.length);
      // Find the row by matching the title text content (since we
      // don't have direct access to React refs).
      const targetRow = rows.find(r => (r.textContent || '').includes(match.title || ''));
      log('step 6: target row found=', !!targetRow, 'title=', match.title?.slice(0, 40));
      // Manually apply the focusing class
      if (targetRow) {
        targetRow.classList.add('focusing');
        log('step 7: focusing class applied');
      }
    }, 0);
  });
});

// Send the message.
await sw.evaluate(async ({ url }) => {
  await chrome.runtime.sendMessage({ type: 'sidetrack.sidepanel.focusThread', threadUrl: url });
}, { url: target.threadUrl });

await new Promise(r => setTimeout(r, 1500));
const trace = await sp.evaluate(() => window.__trace);
console.log('\nMIRROR TRACE:');
for (const t of trace) console.log('  ', t);

const focused = await sp.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.thread.focusing'));
  return rows.map(r => (r.textContent || '').slice(0, 60));
});
console.log('\nfocused rows after trace:', focused);

await browser.close();
