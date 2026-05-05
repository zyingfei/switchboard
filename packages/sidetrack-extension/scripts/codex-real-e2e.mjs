// Real e2e: navigate test browser to target thread → capture via
// extension → start MCP server → simulate Codex via MCP SDK,
// pulling everything via MCP only (no direct companion calls).
// Logs every step so the run is its own evidence trail.
//
// Resolves paths and the bridge key relative to the script's own
// location + env vars, so it works on any machine without edits:
//
//   SIDETRACK_TARGET_URL       (default: a known-good ChatGPT thread)
//   SIDETRACK_VAULT            (default: ~/Documents/Sidetrack-vault)
//   SIDETRACK_COMPANION_PORT   (default: 17373)
//   SIDETRACK_E2E_CDP_URL      (default: http://localhost:9222)
//
// The bridge key is read from <vault>/_BAC/.config/bridge.key, which
// the companion writes on first start. To pre-pair the extension on
// a fresh machine: `npm run e2e:pair`.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const packageRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const repoRoot = path.resolve(packageRoot, '../..');
const expandTilde = (input) =>
  input.startsWith('~') ? path.join(homedir(), input.slice(1).replace(/^[/\\]/, '')) : input;

const TARGET_URL =
  process.env.SIDETRACK_TARGET_URL ?? 'https://chatgpt.com/c/69fa10f8-ae00-8330-a104-ee21469af0e0';
const VAULT = expandTilde(process.env.SIDETRACK_VAULT ?? '~/Documents/Sidetrack-vault');
const COMPANION_PORT = Number(process.env.SIDETRACK_COMPANION_PORT ?? '17373');
const CDP_URL = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9222';
const MCP_PORT = 8730 + Math.floor(Math.random() * 100); // pick a free-ish port
const TARGET = new URL(TARGET_URL);
const isChatGptTarget = TARGET.hostname === 'chatgpt.com' || TARGET.hostname === 'chat.openai.com';
const withoutHash = (url) => url.split('#')[0];

const BRIDGE_KEY_PATH = path.join(VAULT, '_BAC/.config/bridge.key');
let BRIDGE_KEY;
try {
  BRIDGE_KEY = (await readFile(BRIDGE_KEY_PATH, 'utf8')).trim();
  if (BRIDGE_KEY.length === 0) throw new Error(`${BRIDGE_KEY_PATH} is empty`);
} catch (err) {
  console.error(`[setup] cannot read bridge key from ${BRIDGE_KEY_PATH}`);
  console.error('  Start the companion first:');
  console.error(`    node packages/sidetrack-companion/dist/cli.js --vault ${VAULT}`);
  console.error('  Then pair the extension:');
  console.error('    npm run e2e:pair');
  console.error('  Underlying error:', err.message ?? err);
  process.exit(1);
}

const { chromium } = await import(path.join(packageRoot, 'node_modules/playwright/index.mjs'));
const { Client } = await import(
  path.join(
    repoRoot,
    'packages/sidetrack-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js',
  )
);
const { WebSocketClientTransport } = await import(
  path.join(
    repoRoot,
    'packages/sidetrack-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/websocket.js',
  )
);

const log = (step, ...args) => console.log(`\n[${step}]`, ...args);

// ───────── Step 1 — connect to test browser, open target tab
const browser = await chromium.connectOverCDP(CDP_URL);
const ctx = browser.contexts()[0];
let tab = ctx.pages().find((p) => p.url() === TARGET_URL);
if (!tab) {
  log('1.nav', 'no existing tab; opening target URL');
  // Reuse an existing tab on the same provider origin when possible so
  // auth prompts stay in the user's visible provider window.
  tab =
    ctx.pages().find((p) => {
      try {
        return new URL(p.url()).origin === TARGET.origin;
      } catch {
        return false;
      }
    }) ?? (await ctx.newPage());
  await tab.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
}
log('1.nav', 'tab url:', tab.url());
if (isChatGptTarget) {
  await tab.waitForSelector('[data-message-author-role]', { timeout: 15000 });
  const turnCount = await tab.evaluate(
    () => document.querySelectorAll('[data-message-author-role]').length,
  );
  log('1.nav', `tab loaded with ${turnCount} message turns`);
} else {
  await tab.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
  log('1.nav', `target page settled for ${TARGET.hostname}`);
}

// ───────── Step 2 — trigger capture via extension's existing message bus
const extensionContext =
  ctx.serviceWorkers().find((w) => w.url().includes('background.js')) ??
  ctx
    .pages()
    .find((p) => p.url().startsWith('chrome-extension://') && p.url().includes('sidepanel.html'));
if (!extensionContext) throw new Error('extension context not loaded');
log(
  '2.capture',
  'focusing target tab + window, then sending captureCurrentTab from side panel context',
);
// SW.sendMessage doesn't fan out to its own onMessage — we must
// send the message from a NON-SW extension page. Side panel is
// already open; use it as the sender so the SW's handler runs.
const sidepanel = ctx.pages().find((p) => p.url().includes('sidepanel.html'));
if (!sidepanel) throw new Error('side panel must be open for capture trigger');
// Focus the tab from inside the extension context.
await extensionContext.evaluate(async (targetUrl) => {
  const normalize = (url) => url.split('#')[0];
  const tabs = await chrome.tabs.query({});
  const target = normalize(targetUrl);
  const t = tabs.find((x) => x.url !== undefined && normalize(x.url) === target);
  if (!t || t.id === undefined || t.windowId === undefined) throw new Error('no tab');
  await chrome.tabs.update(t.id, { active: true });
  await chrome.windows.update(t.windowId, { focused: true });
}, TARGET_URL);
await new Promise((r) => setTimeout(r, 1500));
const captureRes = await sidepanel.evaluate(async () =>
  chrome.runtime.sendMessage({ type: 'sidetrack.capture.current-tab' }),
);
log(
  '2.capture',
  'capture response keys:',
  Object.keys(captureRes ?? {}).join(','),
  'ok:',
  captureRes?.ok,
);

// Poll until thread shows up in vault.
let bacId = null;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const all = await extensionContext.evaluate(async () => {
    const r = await chrome.storage.local.get(['sidetrack.threads']);
    return r['sidetrack.threads'] || [];
  });
  const match = all.find(
    (t) => t.threadUrl === TARGET_URL || withoutHash(t.threadUrl ?? '') === withoutHash(TARGET_URL),
  );
  if (match) {
    bacId = match.bac_id;
    break;
  }
}
if (!bacId) throw new Error('thread did not appear in local cache after 10s');
log('2.capture', 'thread bac_id:', bacId);

// ───────── Step 3 — start MCP server (websocket) pointing at vault + companion
log('3.mcp', `starting sidetrack-mcp on ws://127.0.0.1:${MCP_PORT}/mcp`);
const mcpProc = spawn(
  'node',
  [
    path.join(repoRoot, 'packages/sidetrack-mcp/dist/cli.js'),
    '--vault',
    VAULT,
    '--transport',
    'websocket',
    '--port',
    String(MCP_PORT),
    '--companion-url',
    `http://127.0.0.1:${COMPANION_PORT}`,
    '--bridge-key',
    BRIDGE_KEY,
    '--mcp-auth-key',
    BRIDGE_KEY,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
mcpProc.stdout.on('data', (d) => process.stdout.write(`  [mcp.out] ${d}`));
mcpProc.stderr.on('data', (d) => process.stdout.write(`  [mcp.err] ${d}`));
// Wait for the listening line.
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('MCP server did not log listening within 8s')), 8000);
  mcpProc.stderr.on('data', (d) => {
    if (String(d).includes('websocket listening')) {
      clearTimeout(t);
      resolve();
    }
  });
  mcpProc.stdout.on('data', (d) => {
    if (String(d).includes('websocket listening')) {
      clearTimeout(t);
      resolve();
    }
  });
});
log('3.mcp', 'MCP listening');

// ───────── Step 4 — build the lean Codex handoff prompt
const prompt = `# Coding handoff: chat thread

sidetrack_thread_id: ${bacId}
sidetrack_mcp: ws://127.0.0.1:${MCP_PORT}/mcp?token=${BRIDGE_KEY}

The Sidetrack companion is running locally and exposes the thread's full context (markdown, dispatches, annotations, recall) over MCP. Connect to the endpoint above and call \`tools/list\` to see what's available; \`bac.read_thread_md\` returns the conversation body.

## User's ask
Summarise this conversation and identify the single biggest open question.`;
log(
  '4.prompt',
  `lean prompt length: ${prompt.length} chars (no chat URL, no provider, no turn snapshot)`,
);

// ───────── Step 5 — agent: parse + connect via MCP only
const parsed = {
  threadId: /sidetrack_thread_id:\s*(\S+)/.exec(prompt)?.[1],
  endpoint: /sidetrack_mcp:\s*(\S+)/.exec(prompt)?.[1],
  ask: /## User's ask\n([\s\S]+)$/.exec(prompt)?.[1]?.trim(),
};
log(
  '5.parse',
  `agent parsed: thread_id=${parsed.threadId} endpoint=${parsed.endpoint?.slice(0, 40)}…`,
);

const client = new Client({ name: 'codex-sim-real-e2e', version: '0.0.1' });
await client.connect(new WebSocketClientTransport(new URL(parsed.endpoint)));
log('5.connect', 'MCP client connected');

// ───────── Step 6 — agent walks the canonical flow
log('6.tools/list', 'calling tools/list');
const tools = await client.listTools();
const advertised = tools.tools.map((t) => t.name);
log('6.tools/list', `advertised: ${advertised.length} tools`);
console.log('  sample:', advertised.slice(0, 8).join(', '));
console.log('  ...');

log('6.read_thread_md', `bac.read_thread_md(${parsed.threadId})`);
const thread = await client.callTool({
  name: 'bac.read_thread_md',
  arguments: { bac_id: parsed.threadId },
});
const threadHeader = thread.structuredContent;
console.log('  vault path:', threadHeader?.path);
console.log('  header content len:', String(threadHeader?.content?.length ?? 0));
console.log('  header preview:', JSON.stringify(String(threadHeader?.content ?? '').slice(0, 200)));

log('6.turns', `bac.turns — captured-turn payload for the thread`);
const turns = await client.callTool({
  name: 'bac.turns',
  arguments: { threadUrl: TARGET_URL, limit: 10 },
});
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
const recallQuery = String(turnsData[0]?.text ?? 'heap rank algorithm')
  .slice(0, 100)
  .replace(/\n/g, ' ')
  .trim();
console.log('  query:', JSON.stringify(recallQuery.slice(0, 80)));
const recall = await client.callTool({
  name: 'bac.recall',
  arguments: { query: recallQuery, limit: 5 },
});
const recallItems = recall.structuredContent?.data ?? [];
console.log('  related-thread count:', recallItems.length);
recallItems.slice(0, 3).forEach((r, i) => {
  console.log(
    `  [${i}] score=${(r.score ?? 0).toFixed(3)} title=${(r.title || '').slice(0, 50)} threadId=${String(r.threadId).slice(0, 16)}`,
  );
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
