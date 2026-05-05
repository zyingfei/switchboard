#!/usr/bin/env node
// Find and (with --apply) delete legacy per-worktree Chrome-for-Testing
// installs. The shared cache at ~/Library/Caches/sidetrack/chrome-for-testing
// is what chrome-debug.mjs reads from now; the per-worktree copies are
// just disk weight (~340 MB each).
//
// Defaults to dry-run. Pass --apply to actually delete.
//
//   node scripts/gc-cft.mjs            # list candidates only
//   node scripts/gc-cft.mjs --apply    # delete them
//   SIDETRACK_GC_ROOTS="$HOME/Documents,$HOME/.codex" node scripts/gc-cft.mjs

import { rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');

const roots = (process.env.SIDETRACK_GC_ROOTS ?? `${homedir()}/Documents,${homedir()}/.codex`)
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const sharedRoot =
  process.env.SIDETRACK_CFT_ROOT ?? path.join(homedir(), 'Library/Caches/sidetrack/chrome-for-testing');

const findCftDirs = (root) => {
  const result = spawnSync(
    'find',
    [
      root,
      '-maxdepth',
      '10',
      '-type',
      'd',
      '(',
      '-name',
      '.chrome-for-testing',
      '-o',
      '-name',
      'chrome-for-testing',
      ')',
      '-prune',
    ],
    { encoding: 'utf8' },
  );
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

const humanSize = async (dir) => {
  const out = spawnSync('du', ['-sh', dir], { encoding: 'utf8' });
  return (out.stdout ?? '').split(/\s+/u)[0] ?? '?';
};

const candidates = [];
for (const root of roots) {
  for (const dir of findCftDirs(root)) {
    if (path.resolve(dir) === path.resolve(sharedRoot)) continue;
    if (path.resolve(dir).startsWith(path.resolve(sharedRoot))) continue;
    try {
      await stat(dir);
      candidates.push(dir);
    } catch {
      // gone already
    }
  }
}

console.log(`[gc-cft] shared cache (kept): ${sharedRoot}`);
console.log(`[gc-cft] scanning roots     : ${roots.join(', ')}`);
console.log(`[gc-cft] candidates         : ${String(candidates.length)}`);
console.log('');

if (candidates.length === 0) {
  console.log('[gc-cft] nothing to clean.');
  process.exit(0);
}

let totalApprox = 0;
for (const dir of candidates) {
  const size = await humanSize(dir);
  console.log(`  ${size.padStart(6)}  ${dir}`);
  if (size.endsWith('M')) totalApprox += Number(size.slice(0, -1));
  else if (size.endsWith('G')) totalApprox += Number(size.slice(0, -1)) * 1024;
}
console.log('');
console.log(`[gc-cft] approximate total  : ${String(Math.round(totalApprox))} MB`);
console.log('');

if (!apply) {
  console.log('[gc-cft] dry-run. Re-run with --apply to delete.');
  process.exit(0);
}

console.log('[gc-cft] --apply set; deleting…');
for (const dir of candidates) {
  await rm(dir, { recursive: true, force: true });
  console.log(`  removed: ${dir}`);
}
console.log('[gc-cft] done.');
