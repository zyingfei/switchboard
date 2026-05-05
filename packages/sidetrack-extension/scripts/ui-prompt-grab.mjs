// Drive the side-panel UI to produce the coding-agent prompt for
// our target thread, then read it off the clipboard. Proves the
// production UI path emits the same lean prompt the e2e exercises.
const ROOT = '/Users/yingfei/Documents/playground/browser-ai-companion/.claude/worktrees/m1+foundation';
const { chromium } = await import(`${ROOT}/packages/sidetrack-extension/node_modules/playwright/index.mjs`);
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
if (!sp) { console.error('side panel must be open'); process.exit(1); }

const TARGET_BAC = '2ZRHJ5ZHV9TDTT3A';
const TARGET_TITLE = 'Heap rank algorithm';

// Skip clipboard grants — CDP context doesn't accept extension
// origins for grantPermissions. We read the packet directly from
// the dispatch-confirm modal instead.

// Bring the side panel to the front.
await sp.bringToFront();

// 1. Find the thread row by title.
const rowFound = await sp.evaluate((title) => {
  const rows = Array.from(document.querySelectorAll('.thread'));
  const row = rows.find(r => (r.textContent || '').includes(title));
  if (!row) return { ok: false, rowsTotal: rows.length };
  row.scrollIntoView({ block: 'center' });
  return { ok: true, snippet: (row.textContent || '').slice(0, 80) };
}, TARGET_TITLE);
console.log('row located:', rowFound);
if (!rowFound.ok) process.exit(2);

// 2. Hover the row to reveal the action strip, then click the Send-to button.
//    The Send-to control opens a dropdown of targets.
const sendToOpen = await sp.evaluate((title) => {
  const row = Array.from(document.querySelectorAll('.thread'))
    .find(r => (r.textContent || '').includes(title));
  if (!row) return { ok: false, reason: 'no row' };
  // Look for a button that opens the Send-to dropdown — common
  // markers: aria-label "Send to" / class includes "send-to".
  const btn = row.querySelector('[aria-label^="Send to"], [aria-label="Send"], [class*="send-to-trigger"], [data-testid*="send-to"]')
    ?? Array.from(row.querySelectorAll('button')).find(b => /send.?to/i.test(b.textContent || ''));
  if (!btn) {
    return {
      ok: false,
      reason: 'no send-to button',
      buttons: Array.from(row.querySelectorAll('button')).map(b => ({
        cls: (b.className?.toString?.() || '').slice(0, 60),
        aria: b.getAttribute('aria-label'),
        title: b.getAttribute('title'),
        text: (b.textContent || '').trim().slice(0, 40),
      })).slice(0, 12),
    };
  }
  btn.click();
  return { ok: true };
}, TARGET_TITLE);
console.log('send-to open:', JSON.stringify(sendToOpen).slice(0, 400));
if (!sendToOpen.ok) process.exit(3);
await sp.waitForTimeout(400);

// 3. Click the "Codex" target. The dropdown nests options inside
//    a menu container; we want the LEAF button whose text is
//    exactly "Codex" (not the parent that aggregates all three).
const targetClicked = await sp.evaluate(() => {
  const all = Array.from(document.querySelectorAll('button, [role="menuitem"], .send-to-row'));
  const codex = all.find(el =>
    /^codex$/i.test((el.textContent || '').trim()) && el.children.length <= 3,
  )
    ?? all.find(el => /\bcodex\b/i.test((el.textContent || '').trim()) && (el.textContent || '').length < 20);
  if (!codex) {
    return {
      ok: false,
      candidates: all
        .filter(el => /codex/i.test(el.textContent || ''))
        .slice(0, 6)
        .map(el => ({
          tag: el.tagName,
          cls: (el.className?.toString?.() || '').slice(0, 60),
          text: (el.textContent || '').trim().slice(0, 60),
        })),
    };
  }
  codex.click();
  return { ok: true, label: (codex.textContent || '').trim() };
});
console.log('codex picked:', JSON.stringify(targetClicked).slice(0, 400));
if (!targetClicked.ok) process.exit(4);
await sp.waitForTimeout(1500);

// 4. The DispatchConfirm modal opened. Try multiple candidate
//    selectors for the packet preview (different React versions /
//    customizations have shipped with different markup).
const modalState = await sp.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"], .modal, .Modal, .composer, [aria-modal="true"]');
  const tryPre =
    document.querySelector('pre.preview-body') ??
    document.querySelector('pre.mono') ??
    document.querySelector('pre[class*="preview"]') ??
    dialog?.querySelector('pre, textarea[readonly]') ??
    null;
  return {
    dialogTag: dialog?.tagName,
    dialogCls: (dialog?.className?.toString?.() || '').slice(0, 80),
    bodyVisible: !!tryPre,
    body: tryPre ? tryPre.textContent ?? tryPre.value ?? '' : null,
    bodyLen: tryPre ? (tryPre.textContent ?? tryPre.value ?? '').length : 0,
    dialogText: dialog ? (dialog.textContent || '').slice(0, 200) : null,
  };
});
console.log('modal:', JSON.stringify({ tag: modalState.dialogTag, cls: modalState.dialogCls, bodyLen: modalState.bodyLen }).slice(0, 200));
if (modalState.bodyLen === 0) {
  console.log('dialog text head:', JSON.stringify(modalState.dialogText));
}
console.log('--- begin packet body from UI ---');
console.log(modalState.body);
console.log('--- end packet body from UI ---');

await browser.close();
