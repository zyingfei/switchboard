import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBuildInfo } from './build-info.js';

// Unit coverage for the build-provenance reader that feeds
// /v1/version. Two contract points:
//   1. a present, well-formed BUILD_INFO.json maps sha/builtAt/branch
//      onto buildSha/buildTime/buildBranch;
//   2. an absent (or malformed) file degrades to all-null and never
//      throws — the companion must boot from a raw tsc-only dist.

describe('readBuildInfo', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sidetrack-build-info-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('maps a present BUILD_INFO.json to buildSha/buildTime/buildBranch', async () => {
    const path = join(dir, 'BUILD_INFO.json');
    await writeFile(
      path,
      JSON.stringify({
        sha: 'abc1234',
        builtAt: '2026-07-19T12:00:00.000Z',
        branch: 'feat/menubar-app',
      }),
      'utf8',
    );

    const info = readBuildInfo(path);

    expect(info).toEqual({
      buildSha: 'abc1234',
      buildTime: '2026-07-19T12:00:00.000Z',
      buildBranch: 'feat/menubar-app',
    });
  });

  it('degrades to all-null when the file is absent', () => {
    const missing = join(dir, 'does-not-exist', 'BUILD_INFO.json');

    const info = readBuildInfo(missing);

    expect(info).toEqual({ buildSha: null, buildTime: null, buildBranch: null });
  });

  it('degrades to null per-field for malformed / partial JSON', async () => {
    const path = join(dir, 'BUILD_INFO.json');
    // Missing branch, non-string sha, empty builtAt — each bad field
    // must fall to null rather than reaching the API surface.
    await writeFile(path, JSON.stringify({ sha: 42, builtAt: '' }), 'utf8');

    const info = readBuildInfo(path);

    expect(info).toEqual({ buildSha: null, buildTime: null, buildBranch: null });
  });

  it('degrades to all-null for non-JSON contents', async () => {
    const path = join(dir, 'BUILD_INFO.json');
    await writeFile(path, 'not json at all', 'utf8');

    const info = readBuildInfo(path);

    expect(info).toEqual({ buildSha: null, buildTime: null, buildBranch: null });
  });
});
