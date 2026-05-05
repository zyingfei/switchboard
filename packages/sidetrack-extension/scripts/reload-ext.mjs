import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];

// Force the extension to reload via chrome.runtime.reload() from the SW.
const sw = ctx.serviceWorkers().find(w => w.url().includes('background.js'));
if (sw) {
  console.log('Triggering chrome.runtime.reload() from SW...');
  try { await sw.evaluate(() => chrome.runtime.reload()); } catch (e) { console.log('SW eval error (expected):', e.message); }
}

// Wait for SW to come back
await new Promise(r => setTimeout(r, 2000));

// Re-fetch contexts
const ctx2 = browser.contexts()[0];
let sp = ctx2.pages().find(p => p.url().includes('sidepanel.html'));
if (sp) {
  console.log('Reloading side panel...');
  await sp.reload().catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
}

// Refresh ref to side panel after reload
sp = ctx2.pages().find(p => p.url().includes('sidepanel.html'));
const sw2 = ctx2.serviceWorkers().find(w => w.url().includes('background.js'));
if (!sp || !sw2) { console.log('missing pages after reload'); process.exit(2); }

await new Promise(r => setTimeout(r, 1000));
const target = await sp.evaluate(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' });
  return r?.state?.threads?.[0];
});
console.log('target:', target?.threadUrl, '(', target?.bac_id, ')');

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

await sw2.evaluate(async ({ url }) => {
  await chrome.runtime.sendMessage({ type: 'sidetrack.sidepanel.focusThread', threadUrl: url });
}, { url: target.threadUrl });

await new Promise(r => setTimeout(r, 800));
const hits = await sp.evaluate(() => window.__hits);
const focusedNow = await sp.evaluate(() => {
  const f = document.querySelector('.thread.focusing');
  return f ? (f.textContent || '').slice(0, 60) : null;
});
console.log('mutation hits:', hits);
console.log('currently focused:', focusedNow);
await browser.close();
