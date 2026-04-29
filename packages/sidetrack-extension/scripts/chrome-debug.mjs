#!/usr/bin/env node
// Spawn Chrome stable with the Sidetrack extension loaded, the
// persistent profile attached, and a remote debugging port open.
// Playwright e2e specs then attach via chromium.connectOverCDP, which
// gives us:
//   - real Chrome cookie storage (so chatgpt.com / claude.ai /
//     gemini.google.com logins from `npm run e2e:login` actually work)
//   - reliable MV3 service-worker registration (Chrome owns the
//     extension lifecycle, not Playwright)
// The Chrome window stays open across test runs; close it manually
// (Cmd-Q) when you're done.
//
// Usage:
//   npm run e2e:chrome-debug          # default port 9222, default profile
//   SIDETRACK_E2E_CDP_PORT=9333 npm run e2e:chrome-debug
//
// Then in another terminal:
//   SIDETRACK_E2E_CDP_URL=http://localhost:9222 \
//     npx playwright test live-providers-smoke

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const extensionPath =
  process.env.SIDETRACK_EXTENSION_PATH ?? path.join(packageRoot, '.output/chrome-mv3');

const expandTilde = (input) =>
  input.startsWith('~') ? path.join(homedir(), input.slice(1).replace(/^[/\\]/, '')) : input;

const userDataDir = expandTilde(process.env.SIDETRACK_USER_DATA_DIR ?? '~/.sidetrack-test-profile');
const port = process.env.SIDETRACK_E2E_CDP_PORT ?? '9222';

const chromeBinary =
  process.env.SIDETRACK_E2E_CHROME_BIN ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

await mkdir(userDataDir, { recursive: true });

console.log(`[chrome-debug] chrome binary  : ${chromeBinary}`);
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

const args = [
  `--user-data-dir=${userDataDir}`,
  `--remote-debugging-port=${port}`,
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  'https://chatgpt.com/',
  'https://claude.ai/',
  'https://gemini.google.com/',
];

const child = spawn(chromeBinary, args, { stdio: 'inherit' });

const onSignal = (signal) => {
  console.log(`\n[chrome-debug] received ${signal}, asking Chrome to quit…`);
  child.kill(signal);
};
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

child.on('exit', (code, signal) => {
  console.log(`[chrome-debug] Chrome exited (code=${String(code)}, signal=${String(signal)}).`);
  process.exit(code ?? 0);
});
