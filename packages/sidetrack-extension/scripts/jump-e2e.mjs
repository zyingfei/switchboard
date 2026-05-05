// Drive the full Jump path: trigger Déjà-vu on a chat page, click
// Jump in the popover, observe what happens in the side panel.
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const sidepanel = ctx.pages().find((p) => p.url().includes('sidepanel.html'));
const chat = ctx.pages().find((p) => p.url().startsWith('https://gemini.google.com/') || p.url().startsWith('https://chatgpt.com/'));
if (!sidepanel || !chat) { console.error('missing pages'); process.exit(1); }
console.log('side panel:', sidepanel.url());
console.log('chat page:', chat.url());

// Capture side panel console messages so we can spot the receive
// side of the jump.
const spLogs = [];
sidepanel.on('console', (m) => spLogs.push(m.type() + ': ' + m.text()));
sidepanel.on('pageerror', (e) => spLogs.push('pageerror: ' + e.message));

// Watch the body for any `.thread.focusing` class addition.
await sidepanel.evaluate(() => {
  if (!window.__jumpDebugInstalled) {
    window.__jumpDebugInstalled = true;
    chrome.runtime.onMessage.addListener((msg) => {
      console.log('[jump-e2e] sidepanel onMessage:', JSON.stringify(msg));
    });
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type !== 'attributes' || r.attributeName !== 'class') continue;
        const target = r.target;
        if (target instanceof HTMLElement && target.classList.contains('focusing')) {
          console.log('[jump-e2e] focusing class APPLIED to', (target.textContent || '').slice(0, 60));
        }
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
    window.__focusObserver = observer;
  }
});

// Pre-fetch state from the side panel so we know what threads it sees.
const stateInfo = await sidepanel.evaluate(async () => {
  const all = await chrome.storage.local.get(['sidetrack.threads']);
  const threads = all['sidetrack.threads'] || [];
  return {
    threadCount: threads.length,
    sampleUrls: threads.slice(0, 5).map((t) => ({ bac_id: t.bac_id, threadUrl: t.threadUrl })),
  };
});
console.log('side panel sees', stateInfo.threadCount, 'threads');
console.log('sample:', stateInfo.sampleUrls);

// Pick a target URL we know is in storage — use the first thread's URL.
const targetUrl = stateInfo.sampleUrls[0]?.threadUrl;
const targetBacId = stateInfo.sampleUrls[0]?.bac_id;
if (!targetUrl) { console.error('no thread to target'); process.exit(2); }
console.log('\ntargeting:', targetUrl, '(bac_id:', targetBacId + ')');

// Send a focusThreadInSidePanel message directly via the background
// service worker — bypass the chip flow so we isolate the side-panel
// handler. chrome.runtime.sendMessage from the SW's own context
// broadcasts to all other extension pages (including the side panel)
// without triggering the SW itself.
const messageTypeKey = 'sidetrack.sidepanel.focusThread';
const swTarget = browser.contexts()[0].serviceWorkers().find((w) => w.url().includes(`/background.js`));
if (!swTarget) { console.error('no background SW available'); process.exit(2); }
await swTarget.evaluate(async ({ msg, target }) => {
  await chrome.runtime.sendMessage({ type: msg, threadUrl: target });
}, { msg: messageTypeKey, target: targetUrl });

// Focus class is set then cleared after 1500ms. Check at 400ms so
// we catch it while still applied.
await sidepanel.waitForTimeout(400);

// Inspect side panel: what's currently focused? Thread rows use the
// `.thread` className (no data-thread-id attr).
const focusState = await sidepanel.evaluate(() => {
  const focusing = document.querySelector('.thread.focusing');
  const allRows = document.querySelectorAll('.thread');
  return {
    focusingExists: !!focusing,
    focusingTitle: focusing?.querySelector('.title, h3, h4')?.textContent?.slice(0, 60),
    rowCount: allRows.length,
    sampleTitles: Array.from(allRows).slice(0, 4).map((r) => r.querySelector('.title, h3, h4')?.textContent?.slice(0, 50)),
  };
});
console.log('\nfocus state after message:', focusState);

console.log('\nside panel logs (last 10):');
for (const l of spLogs.slice(-10)) console.log('  ', l.slice(0, 200));

// Also test the canonical-URL path: send a slightly-mangled URL and
// see if the handler still finds the match.
const mangledUrl = targetUrl + '?utm=test';
console.log('\ntesting non-canonical URL:', mangledUrl);
spLogs.length = 0;
await swTarget.evaluate(async ({ msg, target }) => {
  await chrome.runtime.sendMessage({ type: msg, threadUrl: target });
}, { msg: messageTypeKey, target: mangledUrl });
await sidepanel.waitForTimeout(800);
const mangledFocus = await sidepanel.evaluate((targetBac) => {
  const focusing = document.querySelector('.focusing, [data-focusing="true"]');
  return { focusingExists: !!focusing, focusingId: focusing?.getAttribute('data-thread-id') };
}, targetBacId);
console.log('mangled-url focus state:', mangledFocus);
console.log('logs after mangled:', spLogs.slice(-5));

await browser.close();
