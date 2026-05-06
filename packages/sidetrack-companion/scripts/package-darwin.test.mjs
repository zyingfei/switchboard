// Smoke test for scripts/package-darwin.mjs.
//
// Runs the package builder against an isolated --out dir, asserts
// the expected layout exists, and runs the wrapper's --version
// command to make sure the bundle is executable. Skips the
// --include-model path (real model download).

import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const companionRoot = resolve(dirname(here), '..');

let outDir;
let packageDir;

// Heavy: runs a real tsc build + copies node_modules. Default-
// skipped to keep `npm test` fast. Opt in with
// SIDETRACK_RUN_PACKAGE_TEST=1.
const RUN = process.env['SIDETRACK_RUN_PACKAGE_TEST'] === '1';

describe.skipIf(!RUN)('package-darwin smoke', () => {
  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'sidetrack-pkg-test-'));
    execSync(`node ${join(companionRoot, 'scripts', 'package-darwin.mjs')} --out ${outDir}`, {
      stdio: ['ignore', 'inherit', 'inherit'],
      cwd: companionRoot,
    });
    const fs = await import('node:fs/promises');
    const entries = await fs.readdir(outDir);
    const pkgName = entries.find((name) => name.startsWith('sidetrack-darwin-'));
    if (pkgName === undefined) {
      throw new Error(`packaging produced no sidetrack-darwin-* dir in ${outDir}`);
    }
    packageDir = join(outDir, pkgName);
  }, 300_000);

  afterAll(async () => {
    if (outDir !== undefined) {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('lays down the expected files', () => {
    expect(packageDir).toBeDefined();
    expect(existsSync(join(packageDir, 'bin', 'sidetrack-companion'))).toBe(true);
    expect(existsSync(join(packageDir, 'companion', 'dist', 'cli.js'))).toBe(true);
    expect(existsSync(join(packageDir, 'companion', 'package.json'))).toBe(true);
    expect(existsSync(join(packageDir, 'install.sh'))).toBe(true);
    expect(existsSync(join(packageDir, 'README.md'))).toBe(true);
  });

  it('wrapper script returns a non-error exit and prints a version-shaped string', () => {
    const wrapper = join(packageDir, 'bin', 'sidetrack-companion');
    const result = spawnSync(wrapper, ['--version'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });
});
