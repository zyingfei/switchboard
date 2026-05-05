import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0];
const sp = ctx.pages().find(p => p.url().includes('sidepanel.html'));
const sw = ctx.serviceWorkers().find(w => w.url().includes('background.js'));
const probeCtx = sp ?? sw;

const data = await probeCtx.evaluate(async () => {
  const all = await chrome.storage.local.get(['sidetrack.settings', 'sidetrack.threads', 'sidetrack.workstreams']);
  const port = all['sidetrack.settings']?.companion?.port || 17373;
  const key = all['sidetrack.settings']?.companion?.bridgeKey || '';
  const threads = all['sidetrack.threads'] || [];
  const workstreams = all['sidetrack.workstreams'] || [];

  // Health snapshot
  let health;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/system/health`, { headers: { 'x-bac-bridge-key': key }});
    health = (await r.json()).data?.recall;
  } catch (e) { health = { error: String(e) }; }

  // Pick two threads and see what their primaryWorkstreamId is
  const sample = threads.slice(0, 6).map(t => ({
    bac_id: t.bac_id,
    title: t.title?.slice(0, 50),
    threadUrl: t.threadUrl?.slice(0, 80),
    primaryWorkstreamId: t.primaryWorkstreamId,
  }));

  // Hit /v1/threads/{bacId}/markdown for one thread to see if vault has it
  const target = threads.find(t => t.threadUrl === 'https://chatgpt.com/c/69f944f4-2150-832b-9da8-292d9963bc39');
  let suggResp = null;
  if (target) {
    const r = await fetch(`http://127.0.0.1:${port}/v1/suggestions/thread/${target.bac_id}?limit=10&threshold=0`, { headers: { 'x-bac-bridge-key': key }});
    suggResp = await r.json();
  }

  return {
    threadCount: threads.length,
    workstreams: workstreams.map(w => ({ bac_id: w.bac_id, title: w.title, members: threads.filter(t => t.primaryWorkstreamId === w.bac_id).length })),
    sampleThreads: sample,
    targetThread: target ? { bac_id: target.bac_id, title: target.title, primaryWorkstreamId: target.primaryWorkstreamId } : null,
    health,
    suggResp,
  };
});

console.log('THREAD COUNT:', data.threadCount);
console.log('\nWORKSTREAMS:');
for (const w of data.workstreams || []) console.log(' ', w.bac_id, '|', w.members, 'members |', w.title);
console.log('\nSAMPLE THREADS:');
for (const t of data.sampleThreads || []) console.log(' ', t.bac_id, '|', (t.primaryWorkstreamId || '(unassigned)').padEnd(20), '|', t.title);
console.log('\nTARGET (Hacker News Summary May 4):', JSON.stringify(data.targetThread, null, 2));
console.log('\nRECALL HEALTH:', JSON.stringify(data.health, null, 2));
console.log('\nSUGGESTION RESPONSE:', JSON.stringify(data.suggResp, null, 2));
await b.close();
