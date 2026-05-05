#!/usr/bin/env node
// Pair the loaded Sidetrack extension with the running companion by
// injecting the bridge key directly into the extension's storage —
// no UI paste required. Designed for headless / agent-driven setups
// (CI, another machine running the e2e for the first time).
//
// What it does:
//   1. Connects to the test browser at SIDETRACK_E2E_CDP_URL.
//   2. Reads the bridge key from <vault>/_BAC/.config/bridge.key.
//   3. Writes both:
//        chrome.storage.local["sidetrack.settings"].companion.bridgeKey
//        chrome.storage.local["sidetrack:setupCompleted"] = true
//      so the side panel skips the first-run wizard.
//   4. (optional) calls /v1/system/health to confirm the link.
//
// Usage:
//   npm run e2e:pair                       # uses defaults
//   SIDETRACK_VAULT=~/path npm run e2e:pair
//   SIDETRACK_E2E_CDP_URL=http://localhost:9222 npm run e2e:pair
//
// Required state:
//   - test browser running with the extension loaded (e2e:chrome-debug)
//   - companion running against the named vault (so bridge.key exists)

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const cdpUrl = process.env.SIDETRACK_E2E_CDP_URL ?? 'http://localhost:9222';
const expandTilde = (input) =>
  input.startsWith('~') ? path.join(homedir(), input.slice(1).replace(/^[/\\]/, '')) : input;
const vault = expandTilde(process.env.SIDETRACK_VAULT ?? '~/Documents/Sidetrack-vault');
const companionPort = Number(process.env.SIDETRACK_COMPANION_PORT ?? '17373');

const bridgeKeyPath = path.join(vault, '_BAC/.config/bridge.key');
let bridgeKey;
try {
  bridgeKey = (await readFile(bridgeKeyPath, 'utf8')).trim();
} catch (err) {
  console.error(`[pair-extension] cannot read ${bridgeKeyPath}`);
  console.error('  Start the companion first:');
  console.error(`    node packages/sidetrack-companion/dist/cli.js --vault ${vault}`);
  console.error(`  (then re-run this script)`);
  console.error('  Underlying error:', err.message ?? err);
  process.exit(1);
}
if (bridgeKey.length === 0) {
  console.error(`[pair-extension] ${bridgeKeyPath} is empty`);
  process.exit(1);
}

const { chromium } = await import(path.join(packageRoot, 'node_modules/playwright/index.mjs'));

let browser;
try {
  browser = await chromium.connectOverCDP(cdpUrl);
} catch (err) {
  console.error(`[pair-extension] cannot connect to ${cdpUrl}`);
  console.error('  Start the test browser first:');
  console.error('    npm run e2e:chrome-debug');
  console.error('  Underlying error:', err.message ?? err);
  process.exit(1);
}

const ctx = browser.contexts()[0];
const sw = ctx.serviceWorkers().find((w) => w.url().includes('background.js'));
if (sw === undefined) {
  console.error('[pair-extension] extension service worker not found.');
  console.error('  Confirm .output/chrome-mv3 was loaded by chrome-debug.mjs.');
  process.exit(1);
}

await sw.evaluate(
  async ({ key, port }) => {
    const SETTINGS_KEY = 'sidetrack.settings';
    const SETUP_KEY = 'sidetrack:setupCompleted';
    const existing = await chrome.storage.local.get(SETTINGS_KEY);
    const settings = existing[SETTINGS_KEY] ?? {
      companion: { port, bridgeKey: '' },
      autoTrack: false,
      siteToggles: { chatgpt: true, claude: true, gemini: true, codex: true },
      notifyOnQueueComplete: true,
    };
    settings.companion = { ...(settings.companion ?? {}), port, bridgeKey: key };
    await chrome.storage.local.set({
      [SETTINGS_KEY]: settings,
      [SETUP_KEY]: true,
    });
  },
  { key: bridgeKey, port: companionPort },
);

console.log(`[pair-extension] paired extension with companion (vault: ${vault})`);
console.log(`[pair-extension]   bridge key length : ${String(bridgeKey.length)} chars`);
console.log(`[pair-extension]   companion port    : ${String(companionPort)}`);

// Health check (optional; fails open if companion not yet listening).
try {
  const resp = await fetch(`http://127.0.0.1:${String(companionPort)}/v1/system/health`, {
    headers: { 'x-bac-bridge-key': bridgeKey },
  });
  const body = await resp.json();
  if (resp.ok) {
    const status = body?.data?.status ?? body?.status ?? 'unknown';
    console.log(`[pair-extension]   companion health  : ${String(status)} (HTTP ${String(resp.status)})`);
  } else {
    console.warn(`[pair-extension] WARN: companion returned HTTP ${String(resp.status)}`);
  }
} catch (err) {
  console.warn(`[pair-extension] WARN: companion not reachable (${err.message ?? err})`);
}

await browser.close();
