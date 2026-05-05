import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const sp = b.contexts()[0].pages().find(p => p.url().includes('sidepanel.html'));
const sw = b.contexts()[0].serviceWorkers().find(w => w.url().includes('background.js'));

// Reload the side panel to load the new bundle.
await sp.reload();
await sp.waitForLoadState('networkidle');
await new Promise(r => setTimeout(r, 1500));

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

// Send focusThreadInSidePanel for a thread NOT in local cache
// (a fake bac_id + URL the user has never captured).
await sw.evaluate(async () => {
  await chrome.runtime.sendMessage({
    type: 'sidetrack.sidepanel.focusThread',
    threadUrl: 'https://chatgpt.com/c/synthetic-test-12345',
    bacId: 'SYNTHETIC_TEST_BAC_ID',
    title: 'Synthetic test thread (Jump to vault-only)',
    lastSeenAt: '2026-05-04T00:00:00.000Z',
  });
});

await new Promise(r => setTimeout(r, 1500));
const result = await sp.evaluate(() => ({
  hits: window.__hits,
  rowCount: document.querySelectorAll('.thread').length,
  syntheticVisible: !!document.querySelector('.thread.focusing'),
  focusingTitle: document.querySelector('.thread.focusing')?.textContent?.slice(0, 80) || null,
}));
console.log('hits:', result.hits);
console.log('row count:', result.rowCount);
console.log('focusing applied:', result.syntheticVisible);
console.log('focusing title:', result.focusingTitle);
await b.close();
