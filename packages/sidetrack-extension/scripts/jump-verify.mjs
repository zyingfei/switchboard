import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
const sw = ctx.serviceWorkers().find(w => w.url().includes('background.js'));
if (!sp || !sw) { console.log('missing pages'); process.exit(1); }

// 1. Check what bundle the side panel actually loaded.
const loadedScripts = await sp.evaluate(() => {
  return Array.from(document.scripts).map(s => s.src);
});
console.log('side panel scripts:', loadedScripts.filter(s => s.includes('sidepanel-')).map(s => s.split('/').pop()));

// 2. Check that the page loaded the same chunk hash that's on disk.
const html = await sp.content();
const matches = html.match(/sidepanel-[A-Za-z0-9_-]+\.js/g);
console.log('html refs:', matches);

// 3. Get target thread.
const target = await sp.evaluate(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' });
  return r?.state?.threads?.[0];
});
console.log('target thread:', target?.bac_id, '/', target?.threadUrl);

// 4. Watch for class mutations + dump rich state about handler firing.
await sp.evaluate(() => {
  window.__hits = [];
  window.__msgs = [];
  const cb = (msg) => {
    window.__msgs.push({
      time: Date.now(),
      kind: 'message',
      type: msg?.type,
      url: msg?.threadUrl,
    });
  };
  chrome.runtime.onMessage.addListener(cb);
  const o = new MutationObserver((records) => {
    for (const r of records) {
      if (r.attributeName !== 'class') continue;
      const t = r.target;
      if (t instanceof HTMLElement && t.classList.contains('focusing')) {
        window.__hits.push({
          time: Date.now(),
          text: (t.textContent || '').slice(0, 60),
        });
      }
    }
  });
  o.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
});

// 5. Send the focus message.
const t0 = Date.now();
await sw.evaluate(async ({ url }) => {
  await chrome.runtime.sendMessage({ type: 'sidetrack.sidepanel.focusThread', threadUrl: url });
}, { url: target.threadUrl });

// 6. Wait + collect.
await new Promise(r => setTimeout(r, 800));
const result = await sp.evaluate(() => ({
  msgs: window.__msgs,
  hits: window.__hits,
  focusedNow: document.querySelector('.thread.focusing')?.textContent?.slice(0, 60) || null,
  rowCount: document.querySelectorAll('.thread').length,
}));
console.log('\nT+sent at', t0);
console.log('messages received:', result.msgs);
console.log('mutation hits (focusing class added):', result.hits);
console.log('still-focused element after 800ms:', result.focusedNow);
console.log('thread row count:', result.rowCount);

await browser.close();
