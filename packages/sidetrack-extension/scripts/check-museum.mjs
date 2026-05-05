import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const sp = b.contexts()[0].pages().find(p => p.url().includes('sidepanel.html'));
const sw = b.contexts()[0].serviceWorkers().find(w => w.url().includes('background.js'));

const data = await sp.evaluate(async () => {
  const r = await chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' });
  const threads = r?.state?.threads || [];
  const collapsedBuckets = r?.state?.collapsedBuckets || [];
  const museum = threads.find(t => /washington|museum/i.test(t.title || ''));
  return {
    storedCount: threads.length,
    museumThread: museum,
    collapsedBuckets,
  };
});
console.log('stored count:', data.storedCount);
console.log('museum thread:', data.museumThread);
console.log('collapsed buckets:', data.collapsedBuckets);

if (!data.museumThread) {
  console.log('no museum thread found');
  await b.close(); process.exit(0);
}

// Watch for class mutations + visible row count.
await sp.evaluate(() => {
  window.__hits = [];
  window.__rowSnapshots = [];
  const o = new MutationObserver((records) => {
    for (const r of records) {
      if (r.attributeName !== 'class') continue;
      const t = r.target;
      if (t instanceof HTMLElement && t.classList.contains('focusing')) {
        window.__hits.push((t.textContent || '').slice(0, 60));
      }
    }
  });
  o.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
});

const rowsBefore = await sp.evaluate(() => document.querySelectorAll('.thread').length);
console.log('\nrows before send:', rowsBefore);

await sw.evaluate(async ({ url }) => {
  await chrome.runtime.sendMessage({ type: 'sidetrack.sidepanel.focusThread', threadUrl: url });
}, { url: data.museumThread.threadUrl });

await new Promise(r => setTimeout(r, 1500));

const after = await sp.evaluate(() => ({
  rowCount: document.querySelectorAll('.thread').length,
  hits: window.__hits,
  focused: document.querySelector('.thread.focusing')?.textContent?.slice(0, 60) || null,
  viewTabActive: document.querySelector('.view-tab.on')?.textContent?.slice(0, 30) || null,
  // Look for the museum thread title in DOM
  museumRowVisible: Array.from(document.querySelectorAll('.thread')).some(r => /Best Washington/i.test(r.textContent || '')),
}));
console.log('\nafter send:');
console.log('  rowCount:', after.rowCount);
console.log('  view tab active:', after.viewTabActive);
console.log('  mutation hits:', after.hits);
console.log('  focused:', after.focused);
console.log('  museum row visible in DOM:', after.museumRowVisible);

await b.close();
