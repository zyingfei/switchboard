// Tests for scripts/read-amplification-harness.ts (read-amplification,
// docs/plans/2026-08-15-foundation-program.md).
//
// Two layers, mirroring scripts/resolver-acceptance.test.ts's own split:
//   1. Unit tests for the pure fixture-generation helpers (fast, no
//      process spawn) — `seedBacklog`'s output must be genuinely valid
//      AcceptedEvent JSONL (checked against the SAME `isAcceptedEvent`
//      validator sync/eventLog.ts's real boot-time reader uses), since a
//      malformed fixture would make every real measurement run silently
//      seed zero backlog instead of throwing.
//   2. A smoke test that runs the REAL script end-to-end (`seed` then
//      `run`, both as real subprocesses) against a tiny fixture vault —
//      exercises the harness's own orchestration (copying, spawning a
//      real companion, the rusage tracker, phase attribution, JSON
//      report writing) without the full 45s settle window a real
//      measurement run uses. Requires a built dist/ (same "child-process
//      tests need it" contract .github/workflows/ci.yml's companion job
//      already applies before `bun test` — the harness spawns
//      dist/cli.js, not src/cli.ts, because the connections reconcile
//      child's fork target only exists there; see companionEntrypoint's
//      own comment in the script).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isAcceptedEvent } from '../src/sync/eventLog.js';

import { seedBacklog, stratifiedSample } from './read-amplification-harness.js';

describe('stratifiedSample', () => {
  it('returns the input unchanged when it is already <= count', () => {
    expect(stratifiedSample(['a', 'b'], 5)).toEqual(['a', 'b']);
  });

  it('samples the requested count, reaching past a prefix', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const sample = stratifiedSample(items, 5);
    expect(sample.length).toBe(5);
    expect(Math.max(...sample)).toBeGreaterThanOrEqual(10);
  });
});

describe('seedBacklog', () => {
  let workRoot: string;

  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'read-amp-seed-unit-'));
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  it('writes N lines, each a valid AcceptedEvent the real boot-time reader accepts', async () => {
    seedBacklog(workRoot, 25);
    const day = new Date().toISOString().slice(0, 10);
    const shardPath = join(workRoot, '_BAC', 'log', 'harness-seed', `${day}.jsonl`);
    const raw = await readFile(shardPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(25);
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);
      expect(isAcceptedEvent(parsed)).toBe(true);
    }
  });

  it('assigns strictly increasing per-replica seq numbers (no dot collisions)', async () => {
    seedBacklog(workRoot, 10);
    const day = new Date().toISOString().slice(0, 10);
    const shardPath = join(workRoot, '_BAC', 'log', 'harness-seed', `${day}.jsonl`);
    const raw = await readFile(shardPath, 'utf8');
    const seqs = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as { dot: { seq: number } }).dot.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('gives every seeded event a distinct canonical URL', async () => {
    seedBacklog(workRoot, 10);
    const day = new Date().toISOString().slice(0, 10);
    const shardPath = join(workRoot, '_BAC', 'log', 'harness-seed', `${day}.jsonl`);
    const raw = await readFile(shardPath, 'utf8');
    const urls = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => (JSON.parse(l) as { payload: { canonicalUrl: string } }).payload.canonicalUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

// ---------------------------------------------------------------------------
// End-to-end smoke test — runs the real script as a subprocess, both
// `seed` and `run` subcommands, against a tiny fixture vault.
// ---------------------------------------------------------------------------

const here = fileURLToPath(import.meta.url);
const scriptPath = resolve(dirname(here), 'read-amplification-harness.ts');
const distEntry = resolve(dirname(here), '..', 'dist', 'cli.js');

// Same contract as other child-process-spawning tests in this package
// (see .github/workflows/ci.yml's companion job: "Typecheck + build dist
// (child-process tests need it)" runs before `bun test`) — the CI runner
// always has dist/ built by this point, so `it` (not a skip) is correct
// there; locally this documents why the smoke test needs `bun run build`
// first if it fails with "Built entrypoint not found".
const distIt = existsSync(distEntry) ? it : it.skip;

describe('read-amplification-harness.ts end-to-end smoke test', () => {
  let workRoot: string;
  let sourceVault: string;
  let seedBase: string;
  let manifestOut: string;

  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'read-amp-harness-smoke-'));
    // A tiny, empty vault — mirrors resolver-acceptance.test.ts's own
    // fixture: small enough to boot in well under a second, exercises
    // the harness's full seed+run orchestration without any real
    // browsing history. `seed` writes its own synthetic backlog on top.
    sourceVault = join(workRoot, 'source-vault');
    await mkdir(sourceVault, { recursive: true });
    seedBase = join(workRoot, 'seed-base');
    manifestOut = join(workRoot, 'report.json');
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  distIt(
    'seed then run produce a well-formed JSON report with all three phases',
    async () => {
      const seedResult = spawnSync(
        process.execPath,
        [scriptPath, 'seed', '--source', sourceVault, '--out', seedBase, '--backlog', '5'],
        { encoding: 'utf8', timeout: 30_000 },
      );
      expect(seedResult.error).toBeUndefined();
      expect(seedResult.status).toBe(0);

      const runResult = spawnSync(
        process.execPath,
        [
          scriptPath,
          'run',
          '--seed-base',
          seedBase,
          '--manifest',
          manifestOut,
          '--label',
          'smoke',
          '--resolve-count',
          '0',
          '--settle-ms',
          '300',
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );
      expect(runResult.error).toBeUndefined();
      expect(runResult.status).toBe(0);

      const raw = await readFile(manifestOut, 'utf8');
      const report = JSON.parse(raw) as {
        readonly label: string;
        readonly phases: readonly { readonly name: string; readonly bytesRead: number }[];
        readonly totals: { readonly bytesRead: number; readonly peakResidentSizeMB: number };
      };
      expect(report.label).toBe('smoke');
      expect(report.phases.map((p) => p.name)).toEqual(['boot', 'settle', 'resolves']);
      for (const phase of report.phases) {
        expect(phase.bytesRead).toBeGreaterThanOrEqual(0);
      }
      expect(report.totals.bytesRead).toBeGreaterThan(0);
      expect(report.totals.peakResidentSizeMB).toBeGreaterThan(0);
    },
    90_000,
  );
});
