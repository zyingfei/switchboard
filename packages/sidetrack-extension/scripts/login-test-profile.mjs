#!/usr/bin/env node
// Open a Playwright Chromium window with the Sidetrack extension loaded
// and a persistent user-data dir, then keep it open while you log in to
// chatgpt.com / claude.ai / gemini.google.com. Cookies + local storage
// persist in the user-data dir; subsequent `npx playwright test` runs
// using SIDETRACK_USER_DATA_DIR=<same path> reuse them.
//
// Usage:
//   npm run build        # produce .output/chrome-mv3
//   node scripts/login-test-profile.mjs
//
// Or with a custom profile path:
//   SIDETRACK_USER_DATA_DIR=~/.my-test-profile node scripts/login-test-profile.mjs
//
// Close the window in any normal way (Cmd-Q / window-close button) to
// stop the script. The profile is left in place.

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { chromium } from '@playwright/test';

const packageRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const extensionPath =
  process.env.SIDETRACK_EXTENSION_PATH ?? path.join(packageRoot, '.output/chrome-mv3');

const expandTilde = (input) =>
  input.startsWith('~') ? path.join(homedir(), input.slice(1).replace(/^[/\\]/, '')) : input;

const userDataDir = expandTilde(process.env.SIDETRACK_USER_DATA_DIR ?? '~/.sidetrack-test-profile');

await mkdir(userDataDir, { recursive: true });

console.log(`[login] extension path : ${extensionPath}`);
console.log(`[login] user data dir  : ${userDataDir}`);
console.log('[login] launching headed Chromium with extension loaded…');

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  viewport: { width: 1280, height: 900 },
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

const startupUrls = ['https://chatgpt.com/', 'https://claude.ai/', 'https://gemini.google.com/'];

for (const [index, url] of startupUrls.entries()) {
  const page =
    index === 0 ? (context.pages()[0] ?? (await context.newPage())) : await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((error) => {
    console.warn(`[login] failed to open ${url}: ${error.message ?? String(error)}`);
  });
}

console.log('');
console.log('[login] Three tabs are open: chatgpt.com / claude.ai / gemini.google.com.');
console.log('[login] Log in to each provider you want covered by future e2e runs.');
console.log('[login] When done, close the Chromium window — your cookies stay in:');
console.log(`[login]   ${userDataDir}`);
console.log('');
console.log('[login] Subsequent test runs reuse this profile:');
console.log(`[login]   SIDETRACK_USER_DATA_DIR=${userDataDir} \\`);
console.log('[login]     SIDETRACK_E2E_HEADLESS=0 \\');
console.log('[login]     npx playwright test <spec>.spec.ts');
console.log('');

await context.waitForEvent('close', { timeout: 0 });
console.log('[login] Window closed. Profile saved.');
