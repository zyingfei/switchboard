// Quick recall-pathway probe via CDP. Connects to the side panel
// page (which has the bridge key in chrome.storage), runs the
// recall query through the same fetch path the content script uses,
// and dumps everything: settings, raw response, parsed items.
import { chromium } from 'playwright';

const cdp = 'http://localhost:9222';
const browser = await chromium.connectOverCDP(cdp);
const contexts = browser.contexts();
let sidepanelPage = null;
let contentPage = null;
for (const ctx of contexts) {
  for (const p of ctx.pages()) {
    const url = p.url();
    if (url.includes('sidepanel.html')) sidepanelPage = p;
    if (url.startsWith('https://chatgpt.com/') && contentPage === null) contentPage = p;
    if (url.startsWith('https://claude.ai/') && contentPage === null) contentPage = p;
  }
}
if (!sidepanelPage) {
  console.error('No side panel page found');
  process.exit(1);
}
console.log('Side panel:', sidepanelPage.url());
if (contentPage) console.log('Content page:', contentPage.url());

// Read companion settings from chrome.storage.local in the side panel.
const settings = await sidepanelPage.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  const summary = {};
  for (const [k, v] of Object.entries(all)) {
    summary[k] = typeof v === 'string' ? `<str ${v.length}>` :
      (typeof v === 'object' && v !== null) ? Object.keys(v).slice(0, 8) : typeof v;
  }
  return { keys: Object.keys(all), summary, raw: all };
});
console.log('storage keys:', settings.keys.length);
console.log('summary:', JSON.stringify(settings.summary, null, 2));

// Recursive search for bridgeKey + port — ext storage shape varies.
let port = 17373, bridgeKey = '';
const walk = (obj) => {
  if (typeof obj !== 'object' || obj === null) return;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'bridgeKey' && typeof v === 'string' && v.length > 0) bridgeKey = v;
    if (k === 'port' && typeof v === 'number') port = v;
    if (typeof v === 'object') walk(v);
  }
};
walk(settings.raw);
console.log('settings: port=' + port + ' bridgeKey.len=' + bridgeKey.length);

if (!bridgeKey) {
  console.error('No bridge key found in chrome.storage');
  process.exit(2);
}

// Run the recall query inside the side-panel context (uses chrome's
// own fetch with no CORS issues).
const result = await sidepanelPage.evaluate(async ({ port, bridgeKey, q }) => {
  const out = {};
  try {
    const url = `http://127.0.0.1:${port}/v1/recall/query?q=${encodeURIComponent(q)}&limit=5`;
    const r = await fetch(url, { headers: { 'x-bac-bridge-key': bridgeKey } });
    out.status = r.status;
    out.body = await r.json();
  } catch (e) {
    out.error = String(e);
  }
  // Also fetch health to see embedder + status
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/system/health`, { headers: { 'x-bac-bridge-key': bridgeKey } });
    const j = await r.json();
    out.health = j.data?.recall;
  } catch (e) { out.healthErr = String(e); }
  return out;
}, { port, bridgeKey, q: 'react' });

console.log('\n=== /v1/recall/query?q=react ===');
console.log('http status:', result.status);
console.log('items returned:', result.body?.data?.length);
console.log('first 3 items:');
for (const it of (result.body?.data || []).slice(0, 3)) {
  console.log('  -', JSON.stringify({ score: it.score?.toFixed(3), title: it.title, threadId: it.threadId?.slice(0,12) }));
}
if (result.error) console.log('error:', result.error);

console.log('\n=== /v1/system/health.recall ===');
console.log('  status:', result.health?.status);
console.log('  entries:', result.health?.entryCount, '/', result.health?.eventTurnCount);
console.log('  model:', result.health?.modelId);
console.log('  embedderDevice:', result.health?.embedderDevice);
console.log('  embedderAccelerator:', result.health?.embedderAccelerator);

// If we have a content page (chat provider), simulate the Déjà-vu flow:
// look at what the popover renders and any console errors.
if (contentPage) {
  console.log('\n=== Content-script Déjà-vu probe on:', contentPage.url(), '===');
  const errs = [];
  const recallReqs = [];
  contentPage.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  contentPage.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') errs.push(t + ': ' + msg.text().slice(0, 200));
  });
  contentPage.on('request', (req) => {
    if (req.url().includes('/v1/recall/')) recallReqs.push({ url: req.url(), method: req.method(), headers: req.headers() });
  });
  contentPage.on('response', async (res) => {
    const u = res.url();
    if (u.includes('/v1/recall/')) {
      try {
        const body = await res.text();
        recallReqs.push({ kind: 'response', status: res.status(), body: body.slice(0, 800) });
      } catch (e) { recallReqs.push({ kind: 'response-err', error: String(e) }); }
    }
  });

  // Find a chunk of assistant/user content. ChatGPT renders turns
  // as `[data-message-author-role]` containers; Claude/Gemini differ.
  // Pick the largest "selectable" paragraph as a fallback.
  const selectionInfo = await contentPage.evaluate(async () => {
    const explicit = document.querySelectorAll('[data-message-author-role] p, [data-message-author-role] div');
    const candidates = (explicit.length > 0 ? Array.from(explicit) :
      Array.from(document.querySelectorAll('p, li, div')))
      .filter((el) => {
        const t = (el.textContent || '').trim();
        return t.length > 60 && t.length < 1000 && el.children.length < 8;
      })
      .sort((a, b) => (b.textContent || '').length - (a.textContent || '').length);
    if (candidates.length === 0) return { ok: false, reason: 'no candidate' };
    const target = candidates[0];
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // Real user fires: mousedown → mousemove → mouseup, with
    // selectionchange firing throughout. Replicate the mouseup so
    // any mouseup-listening code wakes up; selectionchange is
    // dispatched automatically by the engine when the range moves.
    const rect = target.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy, button: 0 }));
    return { ok: true, text: (target.textContent || '').slice(0, 100), tag: target.tagName, role: target.closest('[data-message-author-role]')?.getAttribute('data-message-author-role') };
  });
  console.log('selection setup:', selectionInfo);

  // Debounce in content script is 400ms. Wait long enough for chip + auto-popover.
  await contentPage.waitForTimeout(1200);

  let overlay = await contentPage.evaluate(() => {
    return {
      chipExists: !!document.querySelector('.sidetrack-rv-chip'),
      chipCount: document.querySelectorAll('.sidetrack-rv-chip').length,
      chipText: Array.from(document.querySelectorAll('.sidetrack-rv-chip')).map((c) => c.textContent).join(' | '),
      autoPopExists: !!document.querySelector('.sidetrack-deja-pop'),
      autoPopHTML: document.querySelector('.sidetrack-deja-pop')?.outerHTML?.slice(0, 800),
      rvPopExists: !!document.querySelector('.sidetrack-rv-pop'),
    };
  });
  console.log('after selection:', overlay);

  // If a chip is visible, click the Déjà-vu one to force the popover.
  if (overlay.chipExists) {
    const clicked = await contentPage.evaluate(() => {
      const dv = Array.from(document.querySelectorAll('.sidetrack-rv-chip'))
        .find((c) => /Déjà|Deja/i.test(c.textContent || ''));
      if (!dv) return { ok: false, reason: 'no Déjà-vu chip' };
      dv.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      dv.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      dv.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
      return { ok: true };
    });
    console.log('clicked Déjà-vu chip:', clicked);
    await contentPage.waitForTimeout(2500); // recall round-trip + popover mount
    overlay = await contentPage.evaluate(() => {
      const auto = document.querySelector('.sidetrack-deja-pop');
      const items = Array.from(document.querySelectorAll('.sidetrack-deja-row, .sidetrack-deja-item, .sidetrack-deja-pop .row, .sidetrack-deja-pop li'));
      return {
        autoPopExists: !!auto,
        autoPopText: auto?.textContent?.slice(0, 400),
        rowsCount: items.length,
        firstRowText: items[0]?.textContent?.slice(0, 200),
      };
    });
    console.log('after click:', overlay);
  }
  if (errs.length > 0) console.log('content errors:', errs.slice(0, 8));
  console.log('recall network captured:', recallReqs.length, 'events');
  for (const r of recallReqs) console.log('  >', JSON.stringify(r).slice(0, 400));
}

await browser.close();
console.log('\ndone');
