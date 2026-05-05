import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
if (!sp) { console.error('no side panel'); process.exit(1); }
console.log('reloading side panel...');
await sp.reload();
await sp.waitForLoadState('networkidle');
await sp.waitForTimeout(800);

const swList = ctx.serviceWorkers();
const sw = swList.find(w => w.url().includes('background.js'));
if (!sw) { console.error('no SW'); process.exit(2); }

// Snapshot a target URL
const target = await sp.evaluate(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' });
  return r?.state?.threads?.[0];
});
console.log('target:', target?.threadUrl, '(', target?.bac_id, ')');

// Install observer for class changes
await sp.evaluate(() => {
  window.__hits = [];
  const o = new MutationObserver((records) => {
    for (const r of records) {
      if (r.attributeName === 'class' && r.target.classList?.contains('focusing')) {
        window.__hits.push((r.target.textContent || '').slice(0, 60));
      }
    }
  });
  o.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
});

// Send the focus message via SW
await sw.evaluate(async ({ url }) => {
  await chrome.runtime.sendMessage({ type: 'sidetrack.sidepanel.focusThread', threadUrl: url });
}, { url: target.threadUrl });

await sp.waitForTimeout(500);
const hits = await sp.evaluate(() => window.__hits);
const focusedNow = await sp.evaluate(() => {
  const f = document.querySelector('.thread.focusing');
  return f ? (f.textContent || '').slice(0, 60) : null;
});
console.log('mutation hits:', hits);
console.log('currently focused:', focusedNow);
await browser.close();
