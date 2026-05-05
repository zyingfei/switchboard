// Live e2e: user mints "Attach coding session" in the logged-in test
// browser → Codex registers through MCP → Codex asks Sidetrack to
// dispatch to a target AI → extension auto-sends via the existing
// new-tab path → Codex reads back the linked target thread and queues
// follow-up work through MCP.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const repoRoot = path.resolve(packageRoot, '../..');
const idFile = path.join(packageRoot, '.output/cdp-extension-id');
const expandTilde = (input) =>
  input.startsWith('~') ? path.join(homedir(), input.slice(1).replace(/^[/\\]/, '')) : input;

const VAULT = expandTilde(process.env.SIDETRACK_VAULT ?? '~/Documents/Sidetrack-vault');
const COMPANION_PORT = Number(process.env.SIDETRACK_COMPANION_PORT ?? '17373');
const CDP_URL = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9223';
const TARGET_PROVIDER = process.env.SIDETRACK_INBOUND_TARGET_PROVIDER ?? 'chatgpt';
const DISPATCH_TITLE = process.env.SIDETRACK_INBOUND_TITLE;
const DISPATCH_BODY = process.env.SIDETRACK_INBOUND_BODY;
const FOLLOWUP_TEXT = process.env.SIDETRACK_INBOUND_FOLLOWUP;
const WAIT_FOR_ASSISTANT = process.env.SIDETRACK_INBOUND_WAIT_ASSISTANT === '1';
const STRICT_USER_PATH = process.env.SIDETRACK_INBOUND_STRICT_USER_PATH === '1';
const MCP_PORT = 8840 + Math.floor(Math.random() * 100);
const TARGET_PROVIDER_LABEL = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
};

const BRIDGE_KEY_PATH = path.join(VAULT, '_BAC/.config/bridge.key');
const BRIDGE_KEY = (await readFile(BRIDGE_KEY_PATH, 'utf8')).trim();
if (BRIDGE_KEY.length === 0) {
  throw new Error(`${BRIDGE_KEY_PATH} is empty`);
}
if (!['chatgpt', 'claude', 'gemini'].includes(TARGET_PROVIDER)) {
  throw new Error('SIDETRACK_INBOUND_TARGET_PROVIDER must be chatgpt, claude, or gemini.');
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const structured = (result) => {
  if (result && typeof result === 'object' && 'structuredContent' in result) {
    return result.structuredContent;
  }
  throw new Error('tools/call response missing structuredContent');
};

const dataArray = (value) => {
  if (Array.isArray(value?.data)) {
    return value.data;
  }
  if (Array.isArray(value?.threads)) {
    return value.threads;
  }
  if (Array.isArray(value?.turns)) {
    return value.turns;
  }
  return [];
};

const browser = await chromium.connectOverCDP(CDP_URL);
const ctx = browser.contexts()[0];
if (!ctx) {
  throw new Error(`No browser context available at ${CDP_URL}`);
}

const extensionPage =
  ctx.pages().find((page) => page.url().includes('sidepanel.html')) ??
  ctx.pages().find((page) => page.url().startsWith('chrome-extension://'));
const extensionId =
  extensionPage === undefined
    ? (await readFile(idFile, 'utf8')).trim()
    : new URL(extensionPage.url()).host;
if (extensionId.length === 0) {
  throw new Error(`Could not resolve extension id from ${idFile}`);
}
const sidepanel =
  extensionPage?.url().includes('sidepanel.html') === true ? extensionPage : await ctx.newPage();
if (!sidepanel.url().includes('sidepanel.html')) {
  await sidepanel.goto(`chrome-extension://${extensionId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
  });
}
await sidepanel.waitForSelector('[aria-label="Attach coding session"]', { timeout: 15000 });

log('1.attach', 'minting attach prompt from side panel');
await sidepanel.getByRole('button', { name: 'Attach coding session' }).click();
await sidepanel.getByRole('button', { name: 'Generate prompt' }).click();
await sidepanel.waitForSelector('.coding-handoff-prompt', { timeout: 15000 });
const promptText = (await sidepanel.locator('.coding-handoff-prompt').textContent()) ?? '';
const attachToken = /sidetrack_attach_token:\s*([A-Za-z0-9_-]+)/u.exec(promptText)?.[1];
const workstreamId = /sidetrack_workstream_id:\s*([A-Za-z0-9_-]+)/u.exec(promptText)?.[1];
if (!attachToken) {
  throw new Error('Attach prompt did not contain sidetrack_attach_token.');
}
log('1.attach', 'token minted; workstream:', workstreamId ?? '(none)');

log('2.mcp', `starting sidetrack-mcp on ws://127.0.0.1:${MCP_PORT}/mcp`);
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
mcpProc.stdout.on('data', (data) => process.stdout.write(`  [mcp.out] ${data}`));
mcpProc.stderr.on('data', (data) => process.stdout.write(`  [mcp.err] ${data}`));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('MCP server did not start within 8s')), 8000);
  const onData = (data) => {
    if (String(data).includes('websocket listening')) {
      clearTimeout(timer);
      resolve();
    }
  };
  mcpProc.stdout.on('data', onData);
  mcpProc.stderr.on('data', onData);
});

const mcpEndpoint = `ws://127.0.0.1:${MCP_PORT}/mcp?token=${encodeURIComponent(BRIDGE_KEY)}`;
const client = new Client({ name: 'codex-inbound-live-e2e', version: '0.0.0' });
await client.connect(new WebSocketClientTransport(new URL(mcpEndpoint)));

try {
  log('3.register', 'registering Codex coding session');
  const registered = structured(
    await client.callTool({
      name: 'bac.coding_session_register',
      arguments: {
        token: attachToken,
        tool: 'codex',
        cwd: repoRoot,
        branch: process.env.SIDETRACK_E2E_BRANCH ?? 'codex/mcp-inbound-dispatch',
        sessionId: `codex-inbound-live-${Date.now().toString(36)}`,
        name: 'codex · inbound live e2e',
        resumeCommand: 'codex resume codex-inbound-live',
      },
    }),
  );
  const codingSessionId = registered.bac_id;
  if (typeof codingSessionId !== 'string') {
    throw new Error('Registration did not return bac_id.');
  }
  log('3.register', 'coding session:', codingSessionId);

  log('4.context', 'fetching context over MCP');
  const pack = structured(
    await client.callTool({
      name: 'bac.context_pack',
      arguments: { ...(workstreamId === undefined ? {} : { workstreamId }) },
    }),
  );
  const packText = JSON.stringify(pack).slice(0, 180);
  console.log('  context preview:', packText);
  const baselineThreads = dataArray(
    structured(
      await client.callTool({
        name: 'bac.recent_threads',
        arguments: { limit: 50 },
      }),
    ),
  );
  const baselineThreadIds = new Set(
    baselineThreads.map((thread) => thread?.bac_id).filter((bacId) => typeof bacId === 'string'),
  );

  log(
    '5.request_dispatch',
    `requesting auto-approved dispatch to ${TARGET_PROVIDER_LABEL[TARGET_PROVIDER]}`,
  );
  const marker = `Codex inbound live e2e ${new Date().toISOString()}`;
  const title =
    DISPATCH_TITLE ?? `Codex inbound live e2e → ${TARGET_PROVIDER_LABEL[TARGET_PROVIDER]}`;
  const body =
    DISPATCH_BODY ??
    `${marker}\n\nUse Sidetrack context to summarize the active coding session and ask one concrete follow-up question.`;
  const requested = structured(
    await client.callTool({
      name: 'bac.request_dispatch',
      arguments: {
        codingSessionId,
        targetProvider: TARGET_PROVIDER,
        title,
        body: `${marker}\n\n${body}`,
        ...(workstreamId === undefined ? {} : { workstreamId }),
      },
    }),
  );
  const dispatchId = requested.dispatchId;
  if (typeof dispatchId !== 'string') {
    throw new Error('request_dispatch did not return dispatchId.');
  }
  console.log('  dispatch:', dispatchId, requested.approval, requested.status);

  if (STRICT_USER_PATH) {
    log(
      '6.extension',
      'strict mode: waiting for the side panel polling loop to consume the dispatch',
    );
  } else {
    log('6.extension', 'triggering extension refresh so it consumes the auto-approved dispatch');
    await sidepanel.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'sidetrack.workboard.state' });
    });
  }

  let linkedThread;
  if (STRICT_USER_PATH) {
    const requestedAtMillis =
      typeof requested.requestedAt === 'string' ? Date.parse(requested.requestedAt) : Date.now();
    for (let i = 0; i < 120; i += 1) {
      await sleep(2500);
      const visibleChat = ctx.pages().find((page) => {
        try {
          const url = new URL(page.url());
          return (
            (url.hostname === 'chatgpt.com' || url.hostname === 'chat.openai.com') &&
            url.pathname.startsWith('/c/')
          );
        } catch {
          return false;
        }
      });
      const recentThreads = dataArray(
        structured(
          await client.callTool({
            name: 'bac.recent_threads',
            arguments: { limit: 50 },
          }),
        ),
      );
      const candidate = recentThreads.find((thread) => {
        const lastSeenMillis =
          typeof thread?.lastSeenAt === 'string' ? Date.parse(thread.lastSeenAt) : 0;
        return (
          thread?.provider === 'chatgpt' &&
          typeof thread?.bac_id === 'string' &&
          !baselineThreadIds.has(thread.bac_id) &&
          lastSeenMillis >= requestedAtMillis - 60_000
        );
      });
      if (candidate !== undefined) {
        linkedThread = {
          id: candidate.bac_id,
          title: candidate.title ?? '(untitled)',
          url: candidate.threadUrl,
        };
        console.log('  observed target:', linkedThread.id, linkedThread.title);
        break;
      }
      if (visibleChat !== undefined && i % 6 === 0) {
        console.log('  visible target tab:', visibleChat.url());
      } else if (i % 12 === 0) {
        console.log('  waiting for user-path dispatch consumption...');
      }
    }
  } else {
    for (let i = 0; i < 90; i += 1) {
      await sleep(2000);
      const state = await sidepanel.evaluate(async (id) => {
        const data = await chrome.storage.local.get([
          'sidetrack.dispatchLinks',
          'sidetrack.threads',
        ]);
        return {
          linkedThreadId: data['sidetrack.dispatchLinks']?.[id],
          threads: data['sidetrack.threads'] ?? [],
        };
      }, dispatchId);
      if (typeof state.linkedThreadId === 'string') {
        const linked = state.threads.find((thread) => thread.bac_id === state.linkedThreadId);
        linkedThread = {
          id: state.linkedThreadId,
          title: linked?.title ?? '(untitled)',
          url: linked?.threadUrl,
        };
        console.log('  linked target:', linkedThread.id, linkedThread.title);
        break;
      }
      if (i % 10 === 0) {
        console.log('  waiting for dispatch link...');
      }
    }
  }
  if (linkedThread === undefined) {
    throw new Error('Auto-approved dispatch did not produce a captured target thread in time.');
  }

  let assistantText;
  if (WAIT_FOR_ASSISTANT) {
    log('7.readback', 'waiting for assistant reply to be captured over MCP');
    if (typeof linkedThread.url !== 'string' || linkedThread.url.length === 0) {
      throw new Error('Linked target thread did not expose threadUrl for MCP turn readback.');
    }
    for (let i = 0; i < 120; i += 1) {
      await sleep(2500);
      const turns = structured(
        await client.callTool({
          name: 'bac.turns',
          arguments: { threadUrl: linkedThread.url, limit: 20 },
        }),
      );
      const turnData = dataArray(turns);
      const lastAssistant = [...turnData]
        .reverse()
        .find(
          (turn) =>
            turn &&
            typeof turn === 'object' &&
            turn.role === 'assistant' &&
            typeof turn.text === 'string' &&
            turn.text.trim().length > 0,
        );
      if (lastAssistant !== undefined) {
        assistantText = lastAssistant.text.trim();
        console.log('  assistant chars:', assistantText.length);
        console.log('  assistant preview:', JSON.stringify(assistantText.slice(0, 800)));
        break;
      }
      if (i % 12 === 0) {
        console.log('  waiting for assistant capture...');
      }
    }
    if (assistantText === undefined) {
      throw new Error('Assistant reply was not captured over MCP within 300s.');
    }
  }

  log('7.queue_item', 'queueing follow-up against linked target thread');
  const followupText =
    FOLLOWUP_TEXT ??
    'Codex inbound live e2e follow-up: read the target AI reply and extract one actionable next step.';
  const queued = structured(
    await client.callTool({
      name: 'bac.queue_item',
      arguments: {
        scope: 'thread',
        targetId: linkedThread.id,
        text: followupText,
      },
    }),
  );
  console.log('  queue item:', queued.bac_id);
  log('DONE', '✓ live inbound MCP dispatch flow green');
} finally {
  await client.close().catch(() => undefined);
  mcpProc.kill();
  await browser.close().catch(() => undefined);
}
