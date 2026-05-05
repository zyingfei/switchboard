import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
const sw = ctx.serviceWorkers().find(w => w.url().includes('background.js'));
const probeCtx = sp ?? sw;

const target = process.argv[2] ?? 'https://chatgpt.com/c/69f8ea95-e4b8-8325-97d6-ace1a3005d46';

const data = await probeCtx.evaluate(async ({ target }) => {
  const all = await chrome.storage.local.get(['sidetrack.settings', 'sidetrack.threads', 'sidetrack.workstreams']);
  const port = all['sidetrack.settings']?.companion?.port || 17373;
  const key = all['sidetrack.settings']?.companion?.bridgeKey || '';
  const threads = all['sidetrack.threads'] || [];
  const workstreams = all['sidetrack.workstreams'] || [];
  const thread = threads.find(t => t.threadUrl === target);
  if (!thread) return { error: 'no local thread', sample: threads.slice(0,3).map(t => t.threadUrl) };

  const travelWs = workstreams.find(w => /travel/i.test(w.title || ''));
  const travelMembers = threads.filter(t => t.primaryWorkstreamId === travelWs?.bac_id);

  const r = await fetch(`http://127.0.0.1:${port}/v1/suggestions/thread/${thread.bac_id}?limit=20&threshold=0`, {
    headers: { 'x-bac-bridge-key': key }
  });
  const sug = await r.json();

  // Also probe recall to see what other threads cluster nearby
  const r2 = await fetch(`http://127.0.0.1:${port}/v1/recall/query?q=${encodeURIComponent(thread.title || 'travel')}&limit=10`, {
    headers: { 'x-bac-bridge-key': key }
  });
  const recall = (await r2.json()).data;

  return {
    thread: { bac_id: thread.bac_id, title: thread.title, threadUrl: thread.threadUrl, ws: thread.primaryWorkstreamId },
    travelWs: travelWs ? { bac_id: travelWs.bac_id, title: travelWs.title } : null,
    travelMembers: travelMembers.map(t => ({ bac_id: t.bac_id, title: t.title })),
    allWorkstreams: workstreams.map(w => ({ bac_id: w.bac_id, title: w.title, members: threads.filter(t => t.primaryWorkstreamId === w.bac_id).length })),
    suggestions: sug.data,
    recallTopN: Array.isArray(recall) ? recall.slice(0, 6).map(r => ({ score: r.score?.toFixed(3), title: r.title?.slice(0, 50), bac_id: r.threadId })) : recall,
  };
}, { target });

console.log('THREAD:', JSON.stringify(data.thread, null, 2));
console.log('\nTRAVEL WS:', data.travelWs);
console.log('TRAVEL MEMBERS:', JSON.stringify(data.travelMembers, null, 2));
console.log('\nALL WORKSTREAMS:');
for (const w of data.allWorkstreams || []) console.log(' ', w.bac_id, '|', w.members, '|', w.title);
console.log('\nRAW SUGGESTIONS (threshold=0):');
for (const s of data.suggestions || []) {
  const wsName = (data.allWorkstreams || []).find(w => w.bac_id === s.workstreamId)?.title || s.workstreamId;
  console.log(' ', wsName.padEnd(30), 'score=', s.score.toFixed(3), 'lex=', s.breakdown.lexical.toFixed(3), 'vec=', s.breakdown.vector.toFixed(3), 'link=', s.breakdown.link);
}
console.log('\nRECALL nearest threads:');
for (const r of data.recallTopN || []) console.log(' ', r);
console.log(JSON.stringify(data.error || {}, null, 2));
await b.close();
