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

// Find the Sidetrack extension's ID. Two paths because MV3 SWs are
// flaky after idle:
//   1. /json/list service_worker target — works when SW is at least
//      registered (warm or recently-warm).
//   2. chrome://extensions UI scrape — works whenever the extension
//      is installed + enabled, regardless of SW state.
const findExtensionId = async () => {
  try {
    const targets = await fetch(`${cdpUrl}/json/list`).then((r) => r.json());
    const swTarget = targets.find(
      (t) => t.type === 'service_worker' && (t.url ?? '').includes('background.js'),
    );
    const m = /^chrome-extension:\/\/([^/]+)\//u.exec(swTarget?.url ?? '');
    if (m !== null) return m[1];
  } catch {
    // fall through to chrome://extensions
  }
  const probe = await ctx.newPage();
  try {
    await probe.goto('chrome://extensions/', { timeout: 5_000 });
    await probe.waitForTimeout(500);
    const ids = await probe.evaluate(() => {
      const root = document.querySelector('extensions-manager')?.shadowRoot;
      const list = root?.querySelector('extensions-item-list')?.shadowRoot;
      if (list === null || list === undefined) return [];
      return Array.from(list.querySelectorAll('extensions-item'))
        .map((c) => {
          const name = c.shadowRoot?.querySelector('#name')?.textContent?.trim() ?? '';
          return { id: c.id, name };
        })
        .filter((it) => /sidetrack/i.test(it.name));
    });
    if (Array.isArray(ids) && ids.length > 0) return ids[0].id;
    return null;
  } finally {
    await probe.close();
  }
};

const extensionId = await findExtensionId();
if (extensionId === null) {
  console.error('[pair-extension] cannot find Sidetrack extension.');
  console.error('  Confirm chrome://extensions/ shows Sidetrack as enabled,');
  console.error('  or relaunch the test browser:');
  console.error('    npm run e2e:chrome-debug');
  process.exit(1);
}

// Opening sidepanel.html forces the dormant SW to wake so that the
// page-side chrome.storage call (next) is serviced.
const page = await ctx.newPage();
try {
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 10_000,
  });
} catch (err) {
  console.error(
    `[pair-extension] failed to open side panel at ${extensionId}: ${err.message ?? err}`,
  );
  process.exit(1);
}

await page.evaluate(
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

await page.close();

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
    const recall = body?.data?.recall;
    const entries = typeof recall?.entryCount === 'number' ? recall.entryCount : null;
    const status = typeof recall?.status === 'string' ? recall.status : null;
    const uptime = body?.data?.uptimeSec ?? 0;
    const recallSlug =
      status !== null
        ? `recall=${status}${entries !== null ? ` (${String(entries)} entries)` : ''}, `
        : entries !== null
          ? `recall=${String(entries)} entries, `
          : '';
    console.log(
      `[pair-extension]   companion health  : HTTP 200, ${recallSlug}uptime ${String(uptime)}s`,
    );
  } else {
    console.warn(`[pair-extension] WARN: companion returned HTTP ${String(resp.status)}`);
  }
} catch (err) {
  console.warn(`[pair-extension] WARN: companion not reachable (${err.message ?? err})`);
}

await browser.close();
