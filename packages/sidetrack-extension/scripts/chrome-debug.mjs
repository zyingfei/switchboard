#!/usr/bin/env node
// Spawn Chrome for Testing (CfT) directly, with the Sidetrack extension
// loaded and a remote debugging port open. CfT is Google's automation
// distribution — it accepts --load-extension and avoids Playwright's
// extra automation flags. Provider passkey sign-in still requires a
// human with the passkey hardware; see the Codex handoff runbook.
//
// Two-terminal usage:
//
//   Terminal A:
//     npm run e2e:chrome-debug
//   Terminal B:
//     SIDETRACK_E2E_CDP_URL=http://localhost:9222 \
//       npx playwright test live-providers-smoke
//
// One-time login:
//   First run, navigate to chatgpt.com / claude.ai / gemini.google.com
//   in the CfT window and sign in. Cookies persist in the profile dir
//   below; subsequent runs reuse them.

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const extensionPath =
  process.env.SIDETRACK_EXTENSION_PATH ?? path.join(packageRoot, '.output/chrome-mv3');
const idFile = path.join(packageRoot, '.output/cdp-extension-id');

const expandTilde = (input) =>
  input.startsWith('~') ? path.join(homedir(), input.slice(1).replace(/^[/\\]/, '')) : input;

const userDataDir = expandTilde(process.env.SIDETRACK_USER_DATA_DIR ?? '~/.sidetrack-test-profile');
const port = process.env.SIDETRACK_E2E_CDP_PORT ?? '9222';

// Shared CfT install root, in the OS user-cache. One copy serves all
// worktrees / PoCs / clones, instead of each `npm run e2e:install-cft`
// dropping a 340 MB tree under `.chrome-for-testing/` per worktree.
// Override with SIDETRACK_CFT_ROOT.
const SHARED_CFT_ROOT =
  process.env.SIDETRACK_CFT_ROOT ??
  path.join(homedir(), 'Library/Caches/sidetrack/chrome-for-testing');

const findCftBinaryUnder = async (rootWithChromeSubdir) => {
  try {
    const platforms = await readdir(rootWithChromeSubdir);
    for (const platform of platforms) {
      const candidate = path.join(
        rootWithChromeSubdir,
        platform,
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      );
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // dir absent — caller falls through.
  }
  return null;
};

// Find Chrome for Testing. Order:
//   1) SIDETRACK_E2E_CHROME_BIN env var
//   2) ~/Library/Caches/sidetrack/chrome-for-testing/chrome/...  (shared cache)
//   3) ./.chrome-for-testing/chrome/...                          (legacy per-worktree install)
//   4) /Applications/Google Chrome for Testing.app
//   5) Fall back to regular Chrome with a clear warning.
const findChromeForTesting = async () => {
  if (process.env.SIDETRACK_E2E_CHROME_BIN !== undefined) {
    return { binary: process.env.SIDETRACK_E2E_CHROME_BIN, channel: 'env-override' };
  }
  const sharedHit = await findCftBinaryUnder(path.join(SHARED_CFT_ROOT, 'chrome'));
  if (sharedHit !== null) {
    return { binary: sharedHit, channel: `CfT (shared cache: ${SHARED_CFT_ROOT})` };
  }
  const localHit = await findCftBinaryUnder(path.join(packageRoot, '.chrome-for-testing/chrome'));
  if (localHit !== null) {
    console.warn(
      '\n[chrome-debug] NOTE: using legacy per-worktree CfT install at .chrome-for-testing/.\n' +
        '  Consider migrating to the shared cache to save disk:\n' +
        '    npm run e2e:install-cft   (now installs to ~/Library/Caches/sidetrack/chrome-for-testing)\n' +
        '    rm -rf ./.chrome-for-testing\n',
    );
    return { binary: localHit, channel: 'CfT (legacy local install)' };
  }
  const systemCft =
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  if (existsSync(systemCft)) {
    return { binary: systemCft, channel: 'CfT (system)' };
  }
  const stableChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(stableChrome)) {
    console.warn(
      '\n[chrome-debug] WARNING: Chrome for Testing not found. Falling back to ' +
        'regular Chrome stable, but extension loading may fail silently and ' +
        'Google login may be blocked. Install CfT with:\n' +
        '  npm run e2e:install-cft\n',
    );
    return { binary: stableChrome, channel: 'Chrome stable (fallback)' };
  }
  throw new Error('No Chrome binary found. See chrome-debug.mjs comments.');
};

const { binary, channel } = await findChromeForTesting();

await mkdir(userDataDir, { recursive: true });
await rm(idFile, { force: true });

console.log(`[chrome-debug] chrome binary  : ${binary}`);
console.log(`[chrome-debug] channel        : ${channel}`);
console.log(`[chrome-debug] extension path : ${extensionPath}`);
console.log(`[chrome-debug] user data dir  : ${userDataDir}`);
console.log(`[chrome-debug] debug port     : ${port}`);
console.log('');
console.log('[chrome-debug] launching Chrome for Testing with the extension loaded…');
console.log('');
console.log('[chrome-debug] In another terminal, run:');
console.log(`[chrome-debug]   SIDETRACK_E2E_CDP_URL=http://localhost:${port} \\`);
console.log('[chrome-debug]     npx playwright test live-providers-smoke');
console.log('');
console.log('[chrome-debug] First-time setup:');
console.log(
  '[chrome-debug]   Sign in to chatgpt.com / claude.ai / gemini.google.com in this window.',
);
console.log('[chrome-debug]   Cookies persist in the user-data-dir above.');
console.log('');
console.log('[chrome-debug] Close the Chrome window (Cmd-Q) to stop this script.');
console.log('');

const args = [
  `--user-data-dir=${userDataDir}`,
  `--remote-debugging-port=${port}`,
  // Allow CDP WebSocket connections from any origin so external
  // automation scripts (Playwright, custom CDP drivers) can attach.
  // Recent Chrome versions reject ws upgrades from non-default
  // origins by default; without this flag, /devtools/page/<id>
  // returns 403 even from localhost.
  '--remote-allow-origins=*',
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
  '--no-first-run',
  '--no-default-browser-check',
  // Open the three providers as starter tabs.
  'https://chatgpt.com/',
  'https://claude.ai/',
  'https://gemini.google.com/',
];

const child = spawn(binary, args, { stdio: 'inherit' });

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

// Watch CDP for the extension service worker. Once it appears, write
// the extension ID to .output/cdp-extension-id so the spec runner
// doesn't have to guess. MV3 workers go dormant after ~30s idle, so
// the spec wakes the worker by opening chrome-extension://<id>/sidepanel.html.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(1_000);
    try {
      const list = await fetch(`http://localhost:${port}/json/list`).then((r) => r.json());
      const sw = list.find(
        (t) =>
          t.type === 'service_worker' &&
          (t.url ?? '').startsWith('chrome-extension://') &&
          (t.url ?? '').endsWith('/background.js'),
      );
      if (sw === undefined) continue;
      const match = /^chrome-extension:\/\/([^/]+)\//u.exec(sw.url);
      if (match === null) continue;
      const extId = match[1];
      await writeFile(idFile, extId, 'utf8');
      console.log(`[chrome-debug] extension id   : ${extId}`);
      console.log(`[chrome-debug] wrote          : ${idFile}`);
      return;
    } catch {
      // Chrome not ready yet; retry.
    }
  }
  console.warn(
    '[chrome-debug] WARNING: extension service worker never appeared. The spec will fail.',
  );
})();
