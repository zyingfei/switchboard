#!/usr/bin/env bun
// Resolver acceptance harness (task #32, closure evidence for the week's
// resolver work — task #24). A checked-in, reproducible benchmark for the
// URL-resolve path (GET /v1/visits/:url/resolve). NEVER auto-run against a
// live vault — always point --vault at a COPY. Run manually, or later by CI:
//
//   bun run scripts/resolver-acceptance.ts --vault /tmp/vault-copy --manifest /tmp/report.json
//
// What it does:
//   1. Makes ITS OWN two working copies of the given --vault (source copy),
//      one per companion instance it starts (see "why two copies" below),
//      via `cp -Rc` (APFS clone, near-instant) falling back to `cp -R`.
//   2. Starts a real companion process on each copy (ephemeral port,
//      env-controlled lanes) — this is a real HTTP server serving real
//      resolves, not an in-process import of the resolver.
//   3. Instance A (production budgets): records a manifest (vault identity,
//      event/node/edge/candidate-url counts, enabled lanes, machine class,
//      bun version), then runs N cold resolves, N warm repeats, and M
//      event-candidate resolves, timing every call.
//   4. Instance B (structural budgets disabled — env 0=unlimited): resolves
//      the SAME N cold-probe URLs once each. Comparing A's cold decision to
//      B's decision per URL is the DECISION DRIFT report — the honest cost
//      of the 1200/4000/400/20k structural budgets, isolated from the
//      resolver cache by running on a cache-cold, budget-only-differing copy
//      (see "why two copies").
//   5. Reports p50/p95/p99/max per probe class, event-loop blocked time
//      (from instance A's own [api.stall] log lines), resolver-cache row
//      count before/after (cache hit signal), subgraph + candidate-window
//      throttled-truncation-mark counts, and decision drift.
//   6. Writes the full report as JSON to --manifest <path> and prints a
//      human-readable table to stdout.
//
// Why two copies (not one instance, two env flips): the resolver-cache key
// (resolverCacheRevision, visitsRoutes.ts) is (snapshotRevision, arm[, state])
// ONLY — it does NOT fold in the subgraph/candidate-window budgets. Running
// both budget regimes against the SAME vault copy would let instance B's
// "disabled budgets" resolve silently HIT a cache row instance A already
// wrote under production budgets (same snapshotRevision+arm), serving A's
// answer back to B and making every "drift" comparison a false negative.
// Two independent copies make that impossible: B's copy has never been
// resolved against, so every read is a genuine budgets-disabled compute.
//
// Bounded runtime: a coarse wall-clock budget (--time-budget-ms, default
// 9 minutes) is checked between phases; remaining phases are skipped (and
// the skip is recorded in the report, never silently) if time is short, to
// stay under the <10 min target on the ~400MB test-vault copy.
//
// Safety: refuses to run against the well-known daily-vault path
// ($HOME/.sidetrack-vault) even as a source — this script only ever reads
// from --vault (its own copies are the only thing it writes to), but a
// human pointing it at the live vault by mistake is exactly the failure
// mode worth a cheap guard against.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { cpus, homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Database } from 'bun:sqlite';

import { generationDbPath, readPointer } from '../src/connections/generationBuffer.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly vault: string;
  readonly manifestOut: string;
  readonly coldCount: number;
  readonly eventCandidateCount: number;
  readonly timeBudgetMs: number;
  readonly keepCopies: boolean;
}

const DEFAULTS = {
  coldCount: 30,
  eventCandidateCount: 10,
  timeBudgetMs: 9 * 60 * 1000,
};

const usage = `Usage: bun run scripts/resolver-acceptance.ts --vault <path-to-a-COPY> --manifest <out.json> [options]

  --vault <path>            Required. Path to a COPY of a vault (never a live one).
  --manifest <path>         Required. Where to write the JSON report.
  --cold <n>                Cold-resolve probe count (default ${String(DEFAULTS.coldCount)}).
  --event-candidates <n>    Event-candidate resolve probe count (default ${String(DEFAULTS.eventCandidateCount)}).
  --time-budget-ms <n>      Wall-clock budget before later phases are skipped (default ${String(DEFAULTS.timeBudgetMs)}).
  --keep-copies             Do not delete the working copies this script makes (debugging).
`;

const parseArgs = (argv: readonly string[]): CliArgs => {
  let vault: string | undefined;
  let manifestOut: string | undefined;
  let coldCount = DEFAULTS.coldCount;
  let eventCandidateCount = DEFAULTS.eventCandidateCount;
  let timeBudgetMs = DEFAULTS.timeBudgetMs;
  let keepCopies = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--vault') {
      vault = argv[index + 1];
      index += 1;
    } else if (arg === '--manifest') {
      manifestOut = argv[index + 1];
      index += 1;
    } else if (arg === '--cold') {
      coldCount = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--event-candidates') {
      eventCandidateCount = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--time-budget-ms') {
      timeBudgetMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--keep-copies') {
      keepCopies = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage);
      process.exit(0);
    }
  }
  if (vault === undefined || manifestOut === undefined) {
    process.stderr.write(usage);
    throw new Error('--vault and --manifest are required.');
  }
  if (!Number.isFinite(coldCount) || coldCount < 0) coldCount = DEFAULTS.coldCount;
  if (!Number.isFinite(eventCandidateCount) || eventCandidateCount < 0) {
    eventCandidateCount = DEFAULTS.eventCandidateCount;
  }
  if (!Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0) timeBudgetMs = DEFAULTS.timeBudgetMs;
  return {
    vault: resolvePath(vault),
    manifestOut: resolvePath(manifestOut),
    coldCount,
    eventCandidateCount,
    timeBudgetMs,
    keepCopies,
  };
};

// The one documented daily-vault path (scripts/run-test-companion.sh's own
// comment: "daily companion : vault ~/.sidetrack-vault"). Exact-match only —
// this is a cheap last-resort guard, not a content inspection; the operator
// is still the one responsible for pointing --vault at an actual copy.
const assertNotLiveVaultPath = (vaultPath: string): void => {
  const liveVaultPath = resolvePath(join(homedir(), '.sidetrack-vault'));
  if (resolvePath(vaultPath) === liveVaultPath) {
    throw new Error(
      `Refusing to run: --vault points at the live daily vault (${liveVaultPath}). ` +
        'Point this at a COPY (e.g. cp -Rc ~/.sidetrack-vault-test /tmp/resolver-bench-copy).',
    );
  }
};

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

const copyVaultTree = async (source: string, dest: string): Promise<void> => {
  await mkdir(dirname(dest), { recursive: true });
  // APFS clone (macOS) — copy-on-write, effectively instant regardless of
  // vault size. Falls back to a plain recursive copy on any other platform
  // or filesystem (Linux CI, a non-APFS destination, etc.).
  const clone = spawnSync('cp', ['-Rc', source, dest], { stdio: 'ignore' });
  if (clone.status !== 0) {
    const plain = spawnSync('cp', ['-R', source, dest], { stdio: 'ignore' });
    if (plain.status !== 0) {
      throw new Error(`Failed to copy vault tree from ${source} to ${dest}`);
    }
  }
  // Stale locks from whatever process last touched the SOURCE vault must
  // not carry over into a copy this script's own companion instance will
  // open fresh (mirrors scripts/run-test-companion.sh's documented
  // `rm -f .../recall/.lock` seeding step; the connections publish lock is
  // the equivalent for the connections store).
  await rm(join(dest, '_BAC', 'recall', '.lock'), { force: true });
  await rm(join(dest, '_BAC', 'connections', 'current.publish.lock'), { force: true });
};

const dirSizeBytes = async (root: string, maxFiles = 20_000): Promise<number> => {
  let total = 0;
  let seen = 0;
  const walk = async (dir: string): Promise<void> => {
    if (seen >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= maxFiles) return;
      seen += 1;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size;
        } catch {
          // best-effort
        }
      }
    }
  };
  await walk(root);
  return total;
};

// Streamed (not readFile-into-memory) — the identity-critical db files this
// is called on (event-store.db, the connections generation db) can be
// hundreds of MB to low-GB on a real vault; buffering the whole file would
// be slow and needlessly memory-heavy for what is only a manifest identity
// check, not a security digest.
const sha256Of = (path: string): Promise<string | null> =>
  new Promise((resolveP) => {
    try {
      const hash = createHash('sha256');
      const stream = createReadStream(path);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolveP(hash.digest('hex').slice(0, 16)));
      stream.on('error', () => resolveP(null));
    } catch {
      resolveP(null);
    }
  });

// ---------------------------------------------------------------------------
// Direct, read-only vault introspection for the manifest (task #32 item 3).
// Companion is NOT running for these reads — they happen before boot, on a
// working copy nothing else has touched yet.
// ---------------------------------------------------------------------------

const connectionsDbPathFor = (vaultRoot: string): string => {
  const connectionsDir = join(vaultRoot, '_BAC', 'connections');
  if (process.env['SIDETRACK_CONNECTIONS_DOUBLE_BUFFER'] === '0') {
    return join(connectionsDir, 'current.db');
  }
  const genId = readPointer(connectionsDir);
  return genId === null ? join(connectionsDir, 'current.db') : generationDbPath(connectionsDir, genId);
};

// The SWR resolver cache (connections_resolver_cache) lives in its OWN,
// fixed-path db file — snapshot.ts's own comment (D3): "the SWR resolver
// cache lives in its OWN db file (resolver-cache.db)... NOT generation-
// swapped". Unlike the nodes/edges graph tables above, this path is stable
// regardless of double-buffer mode or which generation is currently
// resident, so it needs none of connectionsDbPathFor's pointer resolution.
const resolverCacheDbPathFor = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'connections', 'resolver-cache.db');

// Best-effort row count: returns null (never throws) when the db/table is
// missing or the file isn't a readable sqlite db yet (e.g. a fresh vault
// that has never materialized), so manifest-building never crashes the
// harness over a table that may legitimately not exist.
const rowCountBestEffort = (dbPath: string, table: string): number | null => {
  if (!existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | null;
      return typeof row?.n === 'number' ? row.n : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
};

const eventStoreDbPathFor = (vaultRoot: string): string =>
  join(vaultRoot, '_BAC', 'connections', 'event-store.db');

// ---------------------------------------------------------------------------
// Companion process management
// ---------------------------------------------------------------------------

const getFreePort = async (): Promise<number> =>
  new Promise((resolveP, rejectP) => {
    const server = createServer();
    server.on('error', rejectP);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') {
          resolveP(address.port);
        } else {
          rejectP(new Error('Could not allocate an ephemeral port.'));
        }
      });
    });
  });

interface CompanionHandle {
  readonly label: string;
  readonly proc: ChildProcess;
  readonly port: number;
  readonly baseUrl: string;
  readonly vaultRoot: string;
  readonly logPath: string;
  readonly bridgeKey: string;
}

const companionEntrypoint = (): string => {
  const here = fileURLToPath(import.meta.url);
  // Run the TS source directly (bun executes it natively) rather than
  // depending on a pre-built dist/ — identical behavior, no stale-dist
  // footgun (see docs/plans/2026-08-15-foundation-program.md's note on a
  // bare tsc rebuild leaving a stale buildSha), and no build step required
  // for the smoke test.
  return resolvePath(dirname(here), '..', 'src', 'cli.ts');
};

const waitForHttpOk = async (url: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`HTTP ${String(res.status)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Timed out waiting for ${url} to respond ok: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
};

const readBridgeKeyWithRetry = async (vaultRoot: string, timeoutMs: number): Promise<string> => {
  const path = join(vaultRoot, '_BAC', '.config', 'bridge.key');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(path, 'utf8').trim();
      if (raw.length > 0) return raw;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Bridge key never appeared at ${path}`);
};

const startCompanion = async (
  label: string,
  vaultRoot: string,
  port: number,
  logPath: string,
  extraEnv: Record<string, string>,
): Promise<CompanionHandle> => {
  const logFd = openSync(logPath, 'a');
  const proc = spawn(
    process.execPath,
    [companionEntrypoint(), '--vault', vaultRoot, '--port', String(port)],
    {
      env: {
        ...process.env,
        SIDETRACK_INSTANCE_LABEL: `resolver-acceptance-${label}`,
        SIDETRACK_HTTP_LOG: '1',
        ...extraEnv,
      },
      stdio: ['ignore', logFd, logFd],
      // New process group so a stop() can signal the whole tree (the
      // companion may spawn its own connections reconcile-child under
      // SIDETRACK_CONNECTIONS_CHILD) without hunting descendants by hand.
      detached: true,
    },
  );
  closeSync(logFd);
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  proc.on('error', (error) => {
    console.error(`[resolver-acceptance] companion ${label} process error:`, error);
  });
  await waitForHttpOk(`${baseUrl}/v1/version`, 30_000);
  const bridgeKey = await readBridgeKeyWithRetry(vaultRoot, 5_000);
  return { label, proc, port, baseUrl, vaultRoot, logPath, bridgeKey };
};

const stopCompanion = async (handle: CompanionHandle): Promise<void> => {
  if (handle.proc.pid === undefined || handle.proc.exitCode !== null) return;
  try {
    process.kill(-handle.proc.pid, 'SIGTERM');
  } catch {
    handle.proc.kill('SIGTERM');
  }
  const deadline = Date.now() + 15_000; // mirrors SIDETRACK_SHUTDOWN_GRACE_MS default
  while (handle.proc.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (handle.proc.exitCode === null) {
    try {
      if (handle.proc.pid !== undefined) process.kill(-handle.proc.pid, 'SIGKILL');
    } catch {
      handle.proc.kill('SIGKILL');
    }
  }
};

// ---------------------------------------------------------------------------
// HTTP probes
// ---------------------------------------------------------------------------

interface ProbeOutcome {
  readonly ms: number;
  readonly status: number;
  readonly workstreamId: string | undefined;
  readonly action: string | undefined;
}

const resolveOnce = async (
  handle: CompanionHandle,
  canonicalUrl: string,
  eventCandidates: boolean,
): Promise<ProbeOutcome> => {
  const query = eventCandidates ? '?dryRun=true&eventCandidates=1' : '?dryRun=true';
  const url = `${handle.baseUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve${query}`;
  const start = performance.now();
  const res = await fetch(url, { headers: { 'x-bac-bridge-key': handle.bridgeKey } });
  const ms = performance.now() - start;
  let workstreamId: string | undefined;
  let action: string | undefined;
  try {
    const body = (await res.json()) as {
      readonly data?: { readonly decision?: { readonly workstreamId?: string; readonly action?: string } };
    };
    workstreamId = body.data?.decision?.workstreamId;
    action = body.data?.decision?.action;
  } catch {
    // non-JSON / error body — leave workstreamId/action undefined
  }
  return { ms, status: res.status, workstreamId, action };
};

const fetchProjectionUrls = async (handle: CompanionHandle): Promise<readonly string[]> => {
  const res = await fetch(`${handle.baseUrl}/v1/visits/projection`, {
    headers: { 'x-bac-bridge-key': handle.bridgeKey },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { readonly data?: { readonly byCanonicalUrl?: Record<string, unknown> } };
  const byCanonicalUrl = body.data?.byCanonicalUrl ?? {};
  return Object.keys(byCanonicalUrl);
};

// Deterministic, evenly-spaced sample (not a prefix) so a probe run is
// representative of the whole URL population instead of whatever order the
// projection map happened to serialize in.
const stratifiedSample = <T>(items: readonly T[], count: number): readonly T[] => {
  if (items.length <= count) return items;
  const step = items.length / count;
  const out: T[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(items[Math.floor(index * step)] as T);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

interface LatencyStats {
  readonly n: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  readonly statusCounts: Record<string, number>;
}

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
};

const latencyStatsOf = (outcomes: readonly ProbeOutcome[]): LatencyStats => {
  const sorted = [...outcomes.map((o) => o.ms)].sort((a, b) => a - b);
  const statusCounts: Record<string, number> = {};
  for (const outcome of outcomes) {
    const key = String(outcome.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  return {
    n: outcomes.length,
    p50: sorted.length === 0 ? null : Math.round(percentile(sorted, 50) * 10) / 10,
    p95: sorted.length === 0 ? null : Math.round(percentile(sorted, 95) * 10) / 10,
    p99: sorted.length === 0 ? null : Math.round(percentile(sorted, 99) * 10) / 10,
    max: sorted.length === 0 ? null : Math.round((sorted[sorted.length - 1] as number) * 10) / 10,
    statusCounts,
  };
};

// ---------------------------------------------------------------------------
// Log-line mining (throttled marks, so counts are "at least this many
// distinct throttle windows saw a truncation", not an exact tally).
// ---------------------------------------------------------------------------

const scanLog = (
  logPath: string,
): {
  readonly stallCount: number;
  readonly totalStallMs: number;
  readonly maxStallMs: number;
  readonly subgraphTruncatedMarks: number;
  readonly candidateWindowTruncatedMarks: number;
} => {
  let text = '';
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    return {
      stallCount: 0,
      totalStallMs: 0,
      maxStallMs: 0,
      subgraphTruncatedMarks: 0,
      candidateWindowTruncatedMarks: 0,
    };
  }
  let stallCount = 0;
  let totalStallMs = 0;
  let maxStallMs = 0;
  let subgraphTruncatedMarks = 0;
  let candidateWindowTruncatedMarks = 0;
  for (const line of text.split('\n')) {
    const stallMatch = /\[api\.stall\] eventLoopBlockedMs=(\d+(?:\.\d+)?)/u.exec(line);
    if (stallMatch?.[1] !== undefined) {
      stallCount += 1;
      const ms = Number(stallMatch[1]);
      totalStallMs += ms;
      if (ms > maxStallMs) maxStallMs = ms;
    }
    if (line.includes('[resolver.subgraph.truncated]')) subgraphTruncatedMarks += 1;
    if (line.includes('[resolver.candidate-window.truncated]')) candidateWindowTruncatedMarks += 1;
  }
  return { stallCount, totalStallMs, maxStallMs, subgraphTruncatedMarks, candidateWindowTruncatedMarks };
};

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

const fmtMs = (ms: number | null): string => (ms === null ? '—' : `${ms.toFixed(1)}ms`);

const renderTable = (report: Report): string => {
  const lines: string[] = [];
  lines.push('# Resolver acceptance harness report');
  lines.push('');
  lines.push(`generatedAt: ${report.manifest.generatedAt}`);
  lines.push(`vault: ${report.manifest.vaultPath}`);
  lines.push(
    `events=${String(report.manifest.eventCount ?? '—')} nodes=${String(report.manifest.nodeCount ?? '—')} ` +
      `edges=${String(report.manifest.edgeCount ?? '—')} candidateUrls=${String(report.manifest.candidateUrlCount)}`,
  );
  lines.push(`machine: ${report.manifest.machineClass.cpuModel} (${String(report.manifest.machineClass.cpuCount)} cpus), bun ${report.manifest.bunVersion}`);
  lines.push('');
  lines.push('| class | n | p50 | p95 | p99 | max |');
  lines.push('|---|---|---|---|---|---|');
  for (const [name, stats] of [
    ['cold', report.results.cold],
    ['warm', report.results.warm],
    ['eventCandidate', report.results.eventCandidate],
  ] as const) {
    lines.push(
      `| ${name} | ${String(stats.n)} | ${fmtMs(stats.p50)} | ${fmtMs(stats.p95)} | ${fmtMs(stats.p99)} | ${fmtMs(stats.max)} |`,
    );
  }
  lines.push('');
  lines.push(
    `event-loop stalls: count=${String(report.eventLoop.stallCount)} totalBlockedMs=${String(Math.round(report.eventLoop.totalStallMs))} maxBlockedMs=${String(Math.round(report.eventLoop.maxStallMs))}`,
  );
  lines.push(
    `resolver-cache rows: before=${String(report.cacheHitRatio.resolverCacheRowsBefore ?? '—')} after=${String(report.cacheHitRatio.resolverCacheRowsAfter ?? '—')} delta=${String(report.cacheHitRatio.delta ?? '—')}`,
  );
  lines.push(
    `truncation marks: subgraph=${String(report.truncation.subgraphTruncatedMarks)} candidateWindow=${String(report.truncation.candidateWindowTruncatedMarks)}`,
  );
  lines.push(
    `decision drift: compared=${String(report.decisionDrift.comparedCount)} differing=${String(report.decisionDrift.differingCount)} (${report.decisionDrift.comparedCount === 0 ? 'n/a' : `${((report.decisionDrift.differingCount / report.decisionDrift.comparedCount) * 100).toFixed(1)}%`})`,
  );
  if (report.decisionDrift.differingUrls.length > 0) {
    lines.push(`  differing URLs: ${report.decisionDrift.differingUrls.join(', ')}`);
  }
  if (report.deviations.length > 0) {
    lines.push('');
    lines.push('deviations:');
    for (const deviation of report.deviations) lines.push(`  - ${deviation}`);
  }
  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

interface Manifest {
  readonly generatedAt: string;
  readonly vaultPath: string;
  readonly vaultIdentity: {
    readonly files: readonly { readonly path: string; readonly sizeBytes: number; readonly sha256_16: string | null }[];
    readonly totalSizeBytes: number;
  };
  readonly eventCount: number | null;
  readonly nodeCount: number | null;
  readonly edgeCount: number | null;
  readonly candidateUrlCount: number;
  readonly enabledLanesFromEnv: Record<string, string>;
  readonly machineClass: { readonly cpuModel: string; readonly cpuCount: number };
  readonly bunVersion: string;
}

interface Report {
  readonly manifest: Manifest;
  readonly probeDesign: {
    readonly coldCount: number;
    readonly warmCount: number;
    readonly eventCandidateCount: number;
    readonly timeBudgetMs: number;
  };
  readonly results: { readonly cold: LatencyStats; readonly warm: LatencyStats; readonly eventCandidate: LatencyStats };
  readonly eventLoop: { readonly stallCount: number; readonly totalStallMs: number; readonly maxStallMs: number };
  readonly cacheHitRatio: {
    readonly resolverCacheRowsBefore: number | null;
    readonly resolverCacheRowsAfter: number | null;
    readonly delta: number | null;
  };
  readonly truncation: { readonly subgraphTruncatedMarks: number; readonly candidateWindowTruncatedMarks: number };
  readonly decisionDrift: {
    readonly comparedCount: number;
    readonly differingCount: number;
    readonly differingUrls: readonly string[];
    readonly note: string;
  };
  readonly deviations: readonly string[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const RELEVANT_ENV_KEYS = [
  'SIDETRACK_EVENT_STORE',
  'SIDETRACK_ATTRIBUTION_ARM',
  'SIDETRACK_ATTRIBUTION_V1_SHADOW',
  'SIDETRACK_GUESS_LANES',
  'SIDETRACK_NEW_LABEL_HINT',
  'SIDETRACK_CONNECTIONS_GAP_SEAL',
  'SIDETRACK_CONNECTIONS_DOUBLE_BUFFER',
  'SIDETRACK_CONNECTIONS_CHILD',
  'SIDETRACK_RESOLVER_SUBGRAPH_NODE_BUDGET',
  'SIDETRACK_RESOLVER_SUBGRAPH_EDGE_BUDGET',
  'SIDETRACK_RESOLVER_HUB_DEGREE_CAP',
  'SIDETRACK_RESOLVER_CANDIDATE_TIMELINE_WINDOW',
] as const;

const enabledLanesFromEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of RELEVANT_ENV_KEYS) {
    const value = process.env[key];
    out[key] = value === undefined ? '(default)' : value;
  }
  return out;
};

const buildManifest = async (vaultRoot: string, candidateUrlCount: number): Promise<Manifest> => {
  const identityFiles = [
    join(vaultRoot, '_BAC', 'connections', 'event-store.db'),
    connectionsDbPathFor(vaultRoot),
  ];
  const files: { path: string; sizeBytes: number; sha256_16: string | null }[] = [];
  for (const path of identityFiles) {
    try {
      const size = (await stat(path)).size;
      files.push({ path: relative(vaultRoot, path), sizeBytes: size, sha256_16: await sha256Of(path) });
    } catch {
      // file may legitimately not exist yet (fresh vault)
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    vaultPath: vaultRoot,
    vaultIdentity: { files, totalSizeBytes: await dirSizeBytes(vaultRoot) },
    eventCount: rowCountBestEffort(eventStoreDbPathFor(vaultRoot), 'events'),
    nodeCount: rowCountBestEffort(connectionsDbPathFor(vaultRoot), 'connections_scope_nodes'),
    edgeCount: rowCountBestEffort(connectionsDbPathFor(vaultRoot), 'connections_scope_edges'),
    candidateUrlCount,
    enabledLanesFromEnv: enabledLanesFromEnv(),
    machineClass: { cpuModel: cpus()[0]?.model ?? 'unknown', cpuCount: cpus().length },
    bunVersion: typeof Bun !== 'undefined' ? Bun.version : (process.versions.bun ?? 'unknown'),
  };
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  assertNotLiveVaultPath(args.vault);
  if (!existsSync(args.vault)) {
    throw new Error(`--vault path does not exist: ${args.vault}`);
  }

  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + args.timeBudgetMs;
  const deviations: string[] = [];

  const workDir = await mkdtemp(join(tmpdir(), 'resolver-acceptance-'));
  const copyA = join(workDir, 'instance-a');
  const copyB = join(workDir, 'instance-b');
  console.log(`[resolver-acceptance] copying vault → ${copyA}`);
  await copyVaultTree(args.vault, copyA);
  console.log(`[resolver-acceptance] copying vault → ${copyB}`);
  await copyVaultTree(args.vault, copyB);

  let handleA: CompanionHandle | undefined;
  let handleB: CompanionHandle | undefined;

  try {
    const portA = await getFreePort();
    console.log(`[resolver-acceptance] starting instance A (production budgets) on :${String(portA)}`);
    handleA = await startCompanion('a', copyA, portA, join(workDir, 'instance-a.log'), {});

    const resolverCacheRowsBefore = rowCountBestEffort(
      resolverCacheDbPathFor(copyA),
      'connections_resolver_cache',
    );

    const candidateUrls = await fetchProjectionUrls(handleA);
    const manifest = await buildManifest(copyA, candidateUrls.length);

    const coldTargets = stratifiedSample(candidateUrls, args.coldCount);
    const eventCandidateTargets = stratifiedSample(
      candidateUrls.filter((url) => !coldTargets.includes(url)),
      args.eventCandidateCount,
    );

    console.log(`[resolver-acceptance] cold resolves × ${String(coldTargets.length)}`);
    const coldOutcomes: ProbeOutcome[] = [];
    for (const url of coldTargets) {
      coldOutcomes.push(await resolveOnce(handleA, url, false));
    }

    console.log(`[resolver-acceptance] warm repeats × ${String(coldTargets.length)}`);
    const warmOutcomes: ProbeOutcome[] = [];
    for (const url of coldTargets) {
      warmOutcomes.push(await resolveOnce(handleA, url, false));
    }

    let eventCandidateOutcomes: ProbeOutcome[] = [];
    if (Date.now() > deadlineMs) {
      deviations.push('Skipped event-candidate probes: time budget exceeded before this phase.');
    } else {
      console.log(`[resolver-acceptance] event-candidate resolves × ${String(eventCandidateTargets.length)}`);
      for (const url of eventCandidateTargets) {
        eventCandidateOutcomes.push(await resolveOnce(handleA, url, true));
      }
    }

    const resolverCacheRowsAfter = rowCountBestEffort(
      resolverCacheDbPathFor(copyA),
      'connections_resolver_cache',
    );

    let differingUrls: string[] = [];
    let comparedCount = 0;
    let driftNote = 'Instance B not run (time budget exceeded).';
    if (Date.now() > deadlineMs) {
      deviations.push('Skipped decision-drift comparison (instance B): time budget exceeded.');
    } else {
      const portB = await getFreePort();
      console.log(`[resolver-acceptance] starting instance B (budgets disabled) on :${String(portB)}`);
      handleB = await startCompanion('b', copyB, portB, join(workDir, 'instance-b.log'), {
        SIDETRACK_RESOLVER_SUBGRAPH_NODE_BUDGET: '0',
        SIDETRACK_RESOLVER_SUBGRAPH_EDGE_BUDGET: '0',
        SIDETRACK_RESOLVER_HUB_DEGREE_CAP: '0',
        SIDETRACK_RESOLVER_CANDIDATE_TIMELINE_WINDOW: '0',
      });
      console.log(`[resolver-acceptance] decision-drift resolves × ${String(coldTargets.length)}`);
      const productionByUrl = new Map(coldTargets.map((url, index) => [url, coldOutcomes[index]]));
      for (const url of coldTargets) {
        const unlimited = await resolveOnce(handleB, url, false);
        const production = productionByUrl.get(url);
        if (production === undefined) continue;
        comparedCount += 1;
        if (production.workstreamId !== unlimited.workstreamId || production.action !== unlimited.action) {
          differingUrls.push(url);
        }
      }
      driftNote =
        'Compares instance A (production budgets) vs instance B (SIDETRACK_RESOLVER_SUBGRAPH_NODE_BUDGET/' +
        'EDGE_BUDGET/HUB_DEGREE_CAP/CANDIDATE_TIMELINE_WINDOW=0) on independent vault copies, same URLs, cold both sides.';
    }

    const logStatsA = scanLog(handleA.logPath);

    const report: Report = {
      manifest,
      probeDesign: {
        coldCount: coldTargets.length,
        warmCount: warmOutcomes.length,
        eventCandidateCount: eventCandidateOutcomes.length,
        timeBudgetMs: args.timeBudgetMs,
      },
      results: {
        cold: latencyStatsOf(coldOutcomes),
        warm: latencyStatsOf(warmOutcomes),
        eventCandidate: latencyStatsOf(eventCandidateOutcomes),
      },
      eventLoop: {
        stallCount: logStatsA.stallCount,
        totalStallMs: logStatsA.totalStallMs,
        maxStallMs: logStatsA.maxStallMs,
      },
      cacheHitRatio: {
        resolverCacheRowsBefore,
        resolverCacheRowsAfter,
        delta:
          resolverCacheRowsBefore === null || resolverCacheRowsAfter === null
            ? null
            : resolverCacheRowsAfter - resolverCacheRowsBefore,
      },
      truncation: {
        subgraphTruncatedMarks: logStatsA.subgraphTruncatedMarks,
        candidateWindowTruncatedMarks: logStatsA.candidateWindowTruncatedMarks,
      },
      decisionDrift: { comparedCount, differingCount: differingUrls.length, differingUrls, note: driftNote },
      deviations,
    };

    await mkdir(dirname(args.manifestOut), { recursive: true });
    await Bun.write(args.manifestOut, `${JSON.stringify(report, null, 2)}\n`);
    console.log('');
    console.log(renderTable(report));
    console.log('');
    console.log(`[resolver-acceptance] wrote JSON report to ${args.manifestOut}`);
  } finally {
    if (handleA !== undefined) await stopCompanion(handleA);
    if (handleB !== undefined) await stopCompanion(handleB);
    if (!args.keepCopies) {
      await rm(workDir, { recursive: true, force: true });
    } else {
      console.log(`[resolver-acceptance] keeping working copies at ${workDir}`);
    }
  }
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('[resolver-acceptance] failed:', error);
    process.exitCode = 1;
  });
}

export {
  buildManifest,
  connectionsDbPathFor,
  latencyStatsOf,
  parseArgs,
  percentile,
  renderTable,
  rowCountBestEffort,
  scanLog,
  stratifiedSample,
};
