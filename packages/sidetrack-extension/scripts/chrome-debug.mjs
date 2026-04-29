#!/usr/bin/env node
// Launch Chrome stable via Playwright's launchPersistentContext (same
// flag set the e2e:login script uses, which Chrome 147 actually
// accepts for unpacked extensions) PLUS --remote-debugging-port so
// e2e specs can attach via chromium.connectOverCDP.
//
// Why not plain child_process.spawn? Chrome 147 silently refuses
// --load-extension in non-Playwright sessions when the user-data-dir
// has Developer Mode off — even with --no-first-run. Going through
// Playwright sets the right combination of flags (including
// --enable-automation handling) so the extension actually loads.
//
// Usage:
//   npm run e2e:chrome-debug
//   SIDETRACK_E2E_CDP_PORT=9333 npm run e2e:chrome-debug
//
// Then, in another terminal:
//   SIDETRACK_E2E_CDP_URL=http://localhost:9222 \
//     npx playwright test live-providers-smoke

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const packageRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const extensionPath =
  process.env.SIDETRACK_EXTENSION_PATH ?? path.join(packageRoot, '.output/chrome-mv3');

const expandTilde = (input) =>
  input.startsWith('~') ? path.join(homedir(), input.slice(1).replace(/^[/\\]/, '')) : input;

const userDataDir = expandTilde(
  process.env.SIDETRACK_USER_DATA_DIR ?? '~/.sidetrack-test-profile',
);
const port = process.env.SIDETRACK_E2E_CDP_PORT ?? '9222';
const channel = process.env.SIDETRACK_E2E_BROWSER ?? 'chrome';

await mkdir(userDataDir, { recursive: true });

console.log(`[chrome-debug] browser channel: ${channel}`);
console.log(`[chrome-debug] extension path : ${extensionPath}`);
console.log(`[chrome-debug] user data dir  : ${userDataDir}`);
console.log(`[chrome-debug] debug port     : ${port}`);
console.log('');
console.log('[chrome-debug] launching Chrome with the extension loaded…');
console.log('');
console.log('[chrome-debug] In another terminal, run:');
console.log(`[chrome-debug]   SIDETRACK_E2E_CDP_URL=http://localhost:${port} \\`);
console.log('[chrome-debug]     npx playwright test live-providers-smoke');
console.log('');
console.log('[chrome-debug] Close the Chrome window (Cmd-Q) to stop this script.');
console.log('');

const context = await chromium.launchPersistentContext(userDataDir, {
  channel,
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
  viewport: { width: 1280, height: 900 },
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

// Pre-open the three providers in the existing window so the user
// doesn't have to type the URLs.
const startupUrls = [
  'https://chatgpt.com/',
  'https://claude.ai/',
  'https://gemini.google.com/',
];
for (const [index, url] of startupUrls.entries()) {
  const page =
    index === 0 ? (context.pages()[0] ?? (await context.newPage())) : await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((error) => {
    console.warn(`[chrome-debug] failed to open ${url}: ${error.message ?? String(error)}`);
  });
}

console.log('[chrome-debug] Chrome ready. Tabs open: chatgpt.com / claude.ai / gemini.google.com.');
console.log('[chrome-debug] Open whichever specific chats you want the specs to capture.');
console.log('');

await context.waitForEvent('close', { timeout: 0 });
console.log('[chrome-debug] Chrome closed.');
