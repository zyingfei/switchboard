import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
const sw = ctx.serviceWorkers().find(w => w.url().includes('background.js'));
const probeCtx = sp ?? sw;
const target = 'https://chatgpt.com/g/g-p-69e90d50b60c8191ae921376538a5a30-ddia/c/69eacc53-a0d8-832f-bd39-20158bd86a01';
const data = await probeCtx.evaluate(async ({ target }) => {
  const all = await chrome.storage.local.get(null);
  const threads = all['sidetrack.threads'] || [];
  const reminders = all['sidetrack.reminders'] || [];
  const recentDispatches = all['sidetrack.recentDispatches'] || [];
  const dispatchLinks = all['sidetrack.dispatchLinks'] || {};
  const target_thread = threads.find(t => t.threadUrl === target);
  return {
    target_thread,
    targetReminders: reminders.filter(r => r.threadId === target_thread?.bac_id || r.threadUrl === target),
    targetRecentDispatches: recentDispatches.filter(d => d.threadId === target_thread?.bac_id || d.targetUrl === target),
    targetDispatchLinks: Object.fromEntries(Object.entries(dispatchLinks).filter(([k, v]) => v?.threadId === target_thread?.bac_id || v?.threadUrl === target)),
    storageKeys: Object.keys(all).filter(k => k.includes('reminder') || k.includes('dispatch') || k.includes('recent')),
  };
}, { target });
console.log('TARGET THREAD:', JSON.stringify(data.target_thread, null, 2));
console.log('\nRELATED REMINDERS:', JSON.stringify(data.targetReminders, null, 2));
console.log('\nRECENT DISPATCHES:', JSON.stringify(data.targetRecentDispatches, null, 2));
console.log('\nDISPATCH LINKS:', JSON.stringify(data.targetDispatchLinks, null, 2));
console.log('\nstorage keys:', data.storageKeys);
await b.close();
