#!/usr/bin/env node
// Stamp dist/ with build provenance.
//
// Runs after tsc emits dist/. Writes dist/BUILD_INFO.json with the git
// short-sha, an ISO build timestamp, and the branch, so the running
// companion can report "which build is this dist" on /v1/version (see
// src/build-info.ts). This is the root fix for the invisible-daemon
// stale-dist problem: a plain `bun dist/cli.js` run has no way to know
// its own commit otherwise — codePath only proves the checkout path,
// not that dist was recompiled from the current HEAD.
//
// Wired into package.json `build` so `bun run build` always stamps.
// The raw `../../node_modules/.bin/tsc -p tsconfig.build.json` path
// (used by the CI gate / dogfood scripts) still works on its own; this
// script is separate and idempotent, so the gate can run it too.
//
// Never fails the build. If git is unavailable (a tarball checkout, a
// CI without .git) the fields fall back to null and the timestamp is
// still written — build-info.ts degrades to nulls, /v1/version does
// not crash.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// packages/sidetrack-companion/scripts/stamp-build.mjs
//   → package root is two levels up from this file's dir.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptDir, '..');
const distDir = join(packageRoot, 'dist');

// Run a git command anchored at the package root. Returns the trimmed
// stdout, or null on any failure (git missing, not a repo, detached
// weirdness). Runs in the repo dir so it reflects the checkout being
// built, not some ambient cwd.
const git = (args) => {
  try {
    return execFileSync('git', args, {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

const emptyToNull = (value) => (value === null || value.length === 0 ? null : value);

const sha = emptyToNull(git(['rev-parse', '--short', 'HEAD']));
const branchRaw = emptyToNull(git(['rev-parse', '--abbrev-ref', 'HEAD']));
// A detached-HEAD checkout reports the branch as literal "HEAD" —
// surface null rather than a meaningless "HEAD" string.
const branch = branchRaw === 'HEAD' ? null : branchRaw;
const builtAt = new Date().toISOString();

const buildInfo = { sha, builtAt, branch };

mkdirSync(distDir, { recursive: true });
const outPath = join(distDir, 'BUILD_INFO.json');
writeFileSync(outPath, `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');

process.stdout.write(
  `stamped ${outPath} — sha=${sha ?? 'null'} branch=${branch ?? 'null'} builtAt=${builtAt}\n`,
);
