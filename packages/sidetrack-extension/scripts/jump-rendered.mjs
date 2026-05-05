import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
const sw = ctx.serviceWorkers().find(w => w.url().includes('background.js'));

// Pick a thread that IS rendered (the 《飘》 one).
const target = await sp.evaluate(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' });
  const threads = r?.state?.threads || [];
  return threads.find(t => t.bac_id === '2Y647MNJF6WR32AQ');
});
console.log('target:', target?.bac_id, '/', target?.threadUrl);

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

await sw.evaluate(async ({ url }) => {
  await chrome.runtime.sendMessage({ type: 'sidetrack.sidepanel.focusThread', threadUrl: url });
}, { url: target.threadUrl });

await new Promise(r => setTimeout(r, 800));
const result = await sp.evaluate(() => ({
  hits: window.__hits,
  currentlyFocused: document.querySelector('.thread.focusing')?.textContent?.slice(0, 60) || null,
}));
console.log('mutation hits:', result.hits);
console.log('still focused:', result.currentlyFocused);
await browser.close();
