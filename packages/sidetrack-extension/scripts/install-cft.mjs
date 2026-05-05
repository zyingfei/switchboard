#!/usr/bin/env node
// Install Chrome for Testing into a SHARED OS-cache directory rather
// than under the worktree (`./.chrome-for-testing/`). One install
// (~340 MB) serves every worktree, PoC, and clone instead of one per
// `npm run e2e:install-cft`.
//
// Override the destination with SIDETRACK_CFT_ROOT.
// chrome-debug.mjs reads from the same location.

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const SHARED_CFT_ROOT =
  process.env.SIDETRACK_CFT_ROOT ?? path.join(homedir(), 'Library/Caches/sidetrack/chrome-for-testing');

await mkdir(SHARED_CFT_ROOT, { recursive: true });

console.log(`[install-cft] target : ${SHARED_CFT_ROOT}`);
console.log('[install-cft] running @puppeteer/browsers install chrome@stable…');
console.log('');

const child = spawn(
  'npx',
  ['--yes', '@puppeteer/browsers', 'install', 'chrome@stable', '--path', SHARED_CFT_ROOT],
  { stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (code === 0) {
    console.log('');
    console.log('[install-cft] done. chrome-debug.mjs will pick this up automatically.');
    console.log('[install-cft] To remove legacy per-worktree copies, run: npm run e2e:gc-cft');
  }
  process.exit(code ?? (signal !== null ? 1 : 0));
});
