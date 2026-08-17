// Tests for scripts/resolver-acceptance.ts (task #32 ACCEPTANCE HARNESS).
//
// Two layers:
//   1. Unit tests for the pure stats/formatting helpers (fast, no process
//      spawn) — the arithmetic a benchmark report is only as trustworthy as.
//   2. A smoke test that runs the REAL script end-to-end (`bun run
//      scripts/resolver-acceptance.ts --vault <tiny fixture> --manifest
//      <out>`) against a tiny, freshly-created, empty vault directory (a
//      companion boots fine against an empty vault — no seeded events
//      needed for the harness's OWN plumbing to be exercised: copying,
//      starting/stopping two real companion instances, manifest building,
//      log scanning, and well-formed JSON output). This is intentionally
//      NOT a real-vault benchmark — that's task #32 item 4, run manually
//      once against a copy of ~/.sidetrack-vault-test and reported in the
//      PR body, never wired into `bun test`.

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  latencyStatsOf,
  parseArgs,
  percentile,
  renderTable,
  stratifiedSample,
} from './resolver-acceptance.js';

describe('percentile', () => {
  it('returns 0 for an empty array', () => {
    expect(percentile([], 50)).toBe(0);
  });

  it('picks the expected element for a small sorted array', () => {
    const sorted = [10, 20, 30, 40, 50];
    expect(percentile(sorted, 50)).toBe(30);
    expect(percentile(sorted, 100)).toBe(50);
  });
});

describe('latencyStatsOf', () => {
  it('reports n=0 and null percentiles for an empty outcome list', () => {
    const stats = latencyStatsOf([]);
    expect(stats).toEqual({ n: 0, p50: null, p95: null, p99: null, max: null, statusCounts: {} });
  });

  it('computes percentiles and status counts over a mixed outcome set', () => {
    const outcomes = [
      { ms: 10, status: 200, workstreamId: 'a', action: 'file' },
      { ms: 20, status: 200, workstreamId: 'a', action: 'file' },
      { ms: 30, status: 409, workstreamId: undefined, action: undefined },
    ];
    const stats = latencyStatsOf(outcomes);
    expect(stats.n).toBe(3);
    expect(stats.max).toBe(30);
    expect(stats.statusCounts).toEqual({ '200': 2, '409': 1 });
  });
});

describe('stratifiedSample', () => {
  it('returns the input unchanged when it is already <= count', () => {
    expect(stratifiedSample(['a', 'b'], 5)).toEqual(['a', 'b']);
  });

  it('samples evenly across the input rather than taking a prefix', () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const sample = stratifiedSample(items, 5);
    expect(sample.length).toBe(5);
    // A prefix sample would be [0,1,2,3,4]; a stratified sample should reach
    // into the back half of the array too.
    expect(Math.max(...sample)).toBeGreaterThanOrEqual(5);
  });
});

describe('parseArgs', () => {
  it('applies defaults when optional flags are omitted', () => {
    const args = parseArgs(['--vault', '/tmp/v', '--manifest', '/tmp/out.json']);
    expect(args.vault).toBe('/tmp/v');
    expect(args.manifestOut).toBe('/tmp/out.json');
    expect(args.coldCount).toBeGreaterThan(0);
    expect(args.eventCandidateCount).toBeGreaterThan(0);
    expect(args.keepCopies).toBe(false);
  });

  it('throws when --vault or --manifest is missing', () => {
    expect(() => parseArgs(['--vault', '/tmp/v'])).toThrow();
    expect(() => parseArgs(['--manifest', '/tmp/out.json'])).toThrow();
  });

  it('parses numeric overrides and --keep-copies', () => {
    const args = parseArgs([
      '--vault',
      '/tmp/v',
      '--manifest',
      '/tmp/out.json',
      '--cold',
      '7',
      '--event-candidates',
      '3',
      '--keep-copies',
    ]);
    expect(args.coldCount).toBe(7);
    expect(args.eventCandidateCount).toBe(3);
    expect(args.keepCopies).toBe(true);
  });
});

describe('renderTable', () => {
  it('renders a well-formed table for an all-empty report', () => {
    const empty = latencyStatsOf([]);
    const table = renderTable({
      manifest: {
        generatedAt: '2026-01-01T00:00:00.000Z',
        vaultPath: '/tmp/v',
        vaultIdentity: { files: [], totalSizeBytes: 0 },
        eventCount: null,
        nodeCount: null,
        edgeCount: null,
        candidateUrlCount: 0,
        enabledLanesFromEnv: {},
        machineClass: { cpuModel: 'test-cpu', cpuCount: 1 },
        bunVersion: 'test',
      },
      probeDesign: { coldCount: 0, warmCount: 0, eventCandidateCount: 0, timeBudgetMs: 1000 },
      results: { cold: empty, warm: empty, eventCandidate: empty },
      eventLoop: { stallCount: 0, totalStallMs: 0, maxStallMs: 0 },
      cacheHitRatio: { resolverCacheRowsBefore: null, resolverCacheRowsAfter: null, delta: null },
      truncation: { subgraphTruncatedMarks: 0, candidateWindowTruncatedMarks: 0 },
      decisionDrift: { comparedCount: 0, differingCount: 0, differingUrls: [], note: 'n/a' },
      deviations: ['example deviation note'],
    });
    expect(table).toContain('Resolver acceptance harness report');
    expect(table).toContain('| cold | 0 |');
    expect(table).toContain('example deviation note');
  });
});

// ---------------------------------------------------------------------------
// End-to-end smoke test — runs the real script as a subprocess.
// ---------------------------------------------------------------------------

const here = fileURLToPath(import.meta.url);
const scriptPath = resolve(dirname(here), 'resolver-acceptance.ts');

describe('resolver-acceptance.ts end-to-end smoke test', () => {
  let fixtureVault: string;
  let manifestOut: string;
  let workRoot: string;

  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'resolver-acceptance-smoke-'));
    // A tiny, completely empty vault directory — the companion bootstraps
    // its own _BAC/ structure on first boot, and the harness must handle
    // zero candidate URLs gracefully (this is the "tiny synthetic vault
    // fixture" the task asks for: small enough to boot in well under a
    // second, exercising the harness's full orchestration without any
    // seeded browsing history).
    fixtureVault = join(workRoot, 'fixture-vault');
    await mkdir(fixtureVault, { recursive: true });
    manifestOut = join(workRoot, 'report.json');
  });

  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  it('runs end-to-end and produces a well-formed JSON report', async () => {
    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--vault',
        fixtureVault,
        '--manifest',
        manifestOut,
        '--cold',
        '0',
        '--event-candidates',
        '0',
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);

    const raw = await readFile(manifestOut, 'utf8');
    const report = JSON.parse(raw) as {
      readonly manifest: { readonly vaultPath: string; readonly candidateUrlCount: number };
      readonly probeDesign: unknown;
      readonly results: { readonly cold: { readonly n: number } };
      readonly decisionDrift: { readonly comparedCount: number };
    };
    expect(typeof report.manifest.vaultPath).toBe('string');
    expect(report.manifest.candidateUrlCount).toBe(0);
    expect(report.results.cold.n).toBe(0);
    expect(report.probeDesign).toBeDefined();
    expect(report.decisionDrift.comparedCount).toBe(0);

    // The human table went to stdout too.
    expect(result.stdout).toContain('Resolver acceptance harness report');
  }, 90_000);
});
