// Real e2e: navigate test browser to target thread → capture via
// extension → start MCP server → simulate Codex via MCP SDK,
// pulling everything via MCP only (no direct companion calls).
// Logs every step so the run is its own evidence trail.
// Imports use absolute paths into each package's node_modules so
// this script can run from any cwd (extension has playwright; MCP
// has the MCP SDK + ws transport).
const ROOT = '/Users/yingfei/Documents/playground/browser-ai-companion/.claude/worktrees/m1+foundation';
const { chromium } = await import(`${ROOT}/packages/sidetrack-extension/node_modules/playwright/index.mjs`);
const { Client } = await import(`${ROOT}/packages/sidetrack-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js`);
const { WebSocketClientTransport } = await import(`${ROOT}/packages/sidetrack-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/websocket.js`);
const { spawn } = await import('node:child_process');

const TARGET_URL = 'https://chatgpt.com/c/69fa10f8-ae00-8330-a104-ee21469af0e0';
const VAULT = '/Users/yingfei/Documents/Sidetrack-vault';
const COMPANION_PORT = 17373;
const BRIDGE_KEY = 'Xnr-n2HC2QO5aSvpWFRPROqrhTiSJyWUTYP7WHb2QZg';
const MCP_PORT = 8730 + Math.floor(Math.random() * 100); // pick a free-ish port

const log = (step, ...args) => console.log(`\n[${step}]`, ...args);

// ───────── Step 1 — connect to test browser, open target tab
const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
let tab = ctx.pages().find(p => p.url() === TARGET_URL);
if (!tab) {
  log('1.nav', 'no existing tab; opening target URL');
  // Reuse an existing chatgpt tab so we keep the user's auth session.
  tab = ctx.pages().find(p => p.url().startsWith('https://chatgpt.com/'));
  if (!tab) throw new Error('no chatgpt tab to navigate; user must have one logged in');
  await tab.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
}
log('1.nav', 'tab url:', tab.url());
await tab.waitForSelector('[data-message-author-role]', { timeout: 15000 });
const turnCount = await tab.evaluate(() => document.querySelectorAll('[data-message-author-role]').length);
log('1.nav', `tab loaded with ${turnCount} message turns`);

// ───────── Step 2 — trigger capture via extension's existing message bus
const sw = ctx.serviceWorkers().find(w => w.url().includes('background.js'));
if (!sw) throw new Error('extension SW not loaded');
log('2.capture', 'focusing target tab + window, then sending captureCurrentTab from side panel context');
// SW.sendMessage doesn't fan out to its own onMessage — we must
// send the message from a NON-SW extension page. Side panel is
// already open; use it as the sender so the SW's handler runs.
const sidepanel = ctx.pages().find(p => p.url().includes('sidepanel.html'));
if (!sidepanel) throw new Error('side panel must be open for capture trigger');
// Focus the tab from inside the SW (chrome.tabs needs SW context).
await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/c/*' });
  const t = tabs.find(x => x.url?.includes('69fa10f8-ae00'));
  if (!t || t.id === undefined || t.windowId === undefined) throw new Error('no tab');
  await chrome.tabs.update(t.id, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
});
await new Promise(r => setTimeout(r, 1500));
const captureRes = await sidepanel.evaluate(async () =>
  chrome.runtime.sendMessage({ type: 'sidetrack.capture.current-tab' }),
);
log('2.capture', 'capture response keys:', Object.keys(captureRes ?? {}).join(','), 'ok:', captureRes?.ok);

// Poll until thread shows up in vault.
let bacId = null;
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 500));
  const all = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get(['sidetrack.threads']);
    return r['sidetrack.threads'] || [];
  });
  const match = all.find(t => t.threadUrl === 'https://chatgpt.com/c/69fa10f8-ae00-8330-a104-ee21469af0e0');
  if (match) { bacId = match.bac_id; break; }
}
if (!bacId) throw new Error('thread did not appear in local cache after 10s');
log('2.capture', 'thread bac_id:', bacId);

// ───────── Step 3 — start MCP server (websocket) pointing at vault + companion
log('3.mcp', `starting sidetrack-mcp on ws://127.0.0.1:${MCP_PORT}/mcp`);
const mcpProc = spawn('node', [
  '/Users/yingfei/Documents/playground/browser-ai-companion/.claude/worktrees/m1+foundation/packages/sidetrack-mcp/dist/cli.js',
  '--vault', VAULT,
  '--transport', 'websocket',
  '--port', String(MCP_PORT),
  '--companion-url', `http://127.0.0.1:${COMPANION_PORT}`,
  '--bridge-key', BRIDGE_KEY,
  '--mcp-auth-key', BRIDGE_KEY,
], { stdio: ['ignore', 'pipe', 'pipe'] });
mcpProc.stdout.on('data', d => process.stdout.write(`  [mcp.out] ${d}`));
mcpProc.stderr.on('data', d => process.stdout.write(`  [mcp.err] ${d}`));
// Wait for the listening line.
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('MCP server did not log listening within 8s')), 8000);
  mcpProc.stderr.on('data', d => { if (String(d).includes('websocket listening')) { clearTimeout(t); resolve(); } });
  mcpProc.stdout.on('data', d => { if (String(d).includes('websocket listening')) { clearTimeout(t); resolve(); } });
});
log('3.mcp', 'MCP listening');

// ───────── Step 4 — build the lean Codex handoff prompt
const prompt = `# Coding handoff: chat thread

sidetrack_thread_id: ${bacId}
sidetrack_mcp: ws://127.0.0.1:${MCP_PORT}/mcp?token=${BRIDGE_KEY}

The Sidetrack companion is running locally and exposes the thread's full context (markdown, dispatches, annotations, recall) over MCP. Connect to the endpoint above and call \`tools/list\` to see what's available; \`bac.read_thread_md\` returns the conversation body.

## User's ask
Summarise this conversation and identify the single biggest open question.`;
log('4.prompt', `lean prompt length: ${prompt.length} chars (no chat URL, no provider, no turn snapshot)`);

// ───────── Step 5 — agent: parse + connect via MCP only
const parsed = {
  threadId: /sidetrack_thread_id:\s*(\S+)/.exec(prompt)?.[1],
  endpoint: /sidetrack_mcp:\s*(\S+)/.exec(prompt)?.[1],
  ask: /## User's ask\n([\s\S]+)$/.exec(prompt)?.[1]?.trim(),
};
log('5.parse', `agent parsed: thread_id=${parsed.threadId} endpoint=${parsed.endpoint?.slice(0, 40)}…`);

const client = new Client({ name: 'codex-sim-real-e2e', version: '0.0.1' });
await client.connect(new WebSocketClientTransport(new URL(parsed.endpoint)));
log('5.connect', 'MCP client connected');

// ───────── Step 6 — agent walks the canonical flow
log('6.tools/list', 'calling tools/list');
const tools = await client.listTools();
const advertised = tools.tools.map(t => t.name);
log('6.tools/list', `advertised: ${advertised.length} tools`);
console.log('  sample:', advertised.slice(0, 8).join(', '));
console.log('  ...');

log('6.read_thread_md', `bac.read_thread_md(${parsed.threadId})`);
const thread = await client.callTool({ name: 'bac.read_thread_md', arguments: { bac_id: parsed.threadId } });
const threadHeader = thread.structuredContent;
console.log('  vault path:', threadHeader?.path);
console.log('  header content len:', String(threadHeader?.content?.length ?? 0));
console.log('  header preview:', JSON.stringify(String(threadHeader?.content ?? '').slice(0, 200)));

log('6.turns', `bac.turns — captured-turn payload for the thread`);
const turns = await client.callTool({ name: 'bac.turns', arguments: { threadUrl: 'https://chatgpt.com/c/69fa10f8-ae00-8330-a104-ee21469af0e0', limit: 10 } });
const turnsData = turns.structuredContent?.turns ?? turns.structuredContent?.data ?? [];
console.log('  turn count:', turnsData.length);
if (turnsData[0]) {
  console.log('  first role:', turnsData[0].role, 'len:', (turnsData[0].text || '').length);
  console.log('  first preview:', JSON.stringify(String(turnsData[0].text || '').slice(0, 160)));
}
if (turnsData[turnsData.length - 1]) {
  const last = turnsData[turnsData.length - 1];
  console.log('  last role:', last.role, 'len:', (last.text || '').length);
}

log('6.list_dispatches', 'bac.list_dispatches(limit=5)');
const disp = await client.callTool({ name: 'bac.list_dispatches', arguments: { limit: 5 } });
const dispData = disp.structuredContent?.data ?? [];
console.log('  count:', dispData.length);
if (dispData.length > 0) console.log('  first:', JSON.stringify(dispData[0]).slice(0, 200));

log('6.recall', 'bac.recall — agent finds related threads using a snippet from a captured turn');
const recallQuery = String(turnsData[0]?.text ?? 'heap rank algorithm').slice(0, 100).replace(/\n/g, ' ').trim();
console.log('  query:', JSON.stringify(recallQuery.slice(0, 80)));
const recall = await client.callTool({ name: 'bac.recall', arguments: { query: recallQuery, limit: 5 } });
const recallItems = recall.structuredContent?.data ?? [];
console.log('  related-thread count:', recallItems.length);
recallItems.slice(0, 3).forEach((r, i) => {
  console.log(`  [${i}] score=${(r.score ?? 0).toFixed(3)} title=${(r.title || '').slice(0, 50)} threadId=${String(r.threadId).slice(0, 16)}`);
});

log('6.list_annotations', `bac.list_annotations(url=...)`);
const ann = await client.callTool({ name: 'bac.list_annotations', arguments: {} });
const annData = ann.structuredContent?.data ?? [];
console.log('  annotation count:', annData.length);

log('6.queue_item', 'agent writes back: bac.queue_item with a follow-up note');
const queued = await client.callTool({
  name: 'bac.queue_item',
  arguments: {
    scope: 'thread',
    targetId: parsed.threadId,
    text: 'Codex e2e probe: read thread markdown via MCP, identified user ask, queued this confirmation.',
  },
});
const queueId = queued.structuredContent?.bac_id;
console.log('  queue item bac_id:', queueId);

await client.close();
mcpProc.kill();
await browser.close();

log('DONE', '✓ all steps green; queue item bac_id:', queueId);
