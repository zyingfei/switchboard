import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const sw = ctx.serviceWorkers().find(w => w.url().includes('background.js'));
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));

const target = 'https://chatgpt.com/c/69f8db62-5428-832e-9ae0-b8bfb9da3530';

const ctxPage = sp ?? ctx.pages().find(p => p.url().startsWith('chrome-extension://')) ?? sw;
const probe = sp ?? sw;
console.log('using', sp ? 'side panel' : 'service worker', 'for evals');

const data = await probe.evaluate(async ({ target }) => {
  const all = await chrome.storage.local.get(['sidetrack.settings','sidetrack.threads','sidetrack.workstreams']);
  const port = all['sidetrack.settings']?.companion?.port || 17373;
  const key = all['sidetrack.settings']?.companion?.bridgeKey || '';
  const threads = all['sidetrack.threads'] || [];
  const workstreams = all['sidetrack.workstreams'] || [];
  const localThread = threads.find(t => t.threadUrl === target);

  // 1. Suggestions for the thread (no threshold)
  let suggestions = null;
  if (localThread) {
    const r = await fetch(`http://127.0.0.1:${port}/v1/suggestions/thread/${localThread.bac_id}?limit=10`, { headers: { 'x-bac-bridge-key': key }});
    suggestions = await r.json();
  }

  // 2. Query recall for "hacker news" to see what threads cluster together
  const recallR = await fetch(`http://127.0.0.1:${port}/v1/recall/query?q=${encodeURIComponent('hacker news summary technology')}&limit=10`, { headers: { 'x-bac-bridge-key': key }});
  const recall = (await recallR.json()).data;

  // 3. Find any "hackernews"/"hn"/"hacker news" workstream
  const hnWs = workstreams.filter(w => /hacker|hn/i.test(w.title || '') || /hacker|hn/i.test((w.tags || []).join(' ')));

  return {
    localThread: localThread ? {
      bac_id: localThread.bac_id,
      title: localThread.title,
      primaryWorkstreamId: localThread.primaryWorkstreamId,
      provider: localThread.provider,
      threadUrl: localThread.threadUrl,
      tags: localThread.tags,
    } : null,
    workstreams: workstreams.map(w => ({ bac_id: w.bac_id, title: w.title, tags: w.tags, memberHint: threads.filter(t => t.primaryWorkstreamId === w.bac_id).length })),
    hnWs,
    suggestions,
    topRecall: Array.isArray(recall) ? recall.slice(0, 8).map(r => ({ score: r.score?.toFixed(3), title: r.title?.slice(0, 60), bac_id: r.threadId })) : recall,
  };
}, { target });

console.log('LOCAL THREAD:', JSON.stringify(data.localThread, null, 2));
console.log('\nWORKSTREAMS (with member count):');
for (const w of data.workstreams) console.log(' ', w.bac_id, '|', w.memberHint, 'members |', w.title, w.tags?.length ? '#' + w.tags.join(',#') : '');
console.log('\nHACKER-NEWS-LIKE WORKSTREAMS:', data.hnWs);
console.log('\nSUGGESTIONS for that thread:');
console.log(JSON.stringify(data.suggestions, null, 2));
console.log('\nRECALL "hacker news summary technology" top 8:');
for (const r of data.topRecall) console.log(' ', r);

await browser.close();
