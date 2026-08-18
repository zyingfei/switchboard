#!/usr/bin/env bun
// Read-amplification harness (perf/read-amplification, 2026-08-17).
//
// LIVE EVIDENCE this responds to: kernel disk-IO counters (proc_pid_rusage)
// showed the daily test companion reading 46.2 GB in ~45 minutes of boot
// catch-up + first unfrozen topic run + embed backlog (writes were only
// 1.5 GB — the write side was already fixed). Hypothesis: bun:sqlite
// connections default to a 2MB page cache (`cache_size = -2000`) and
// `mmap_size = 0` against a ~1GB event-store.db and a ~437MB connections
// generation db, so repeated scans cold-read from disk on almost every
// pass. See src/storage/sqliteCachePragmas.ts for the fix this harness
// measures.
//
// Two subcommands (kept separate so the SAME seeded backlog can be cloned
// fresh — via `cp -Rc`, an instant APFS COW clone — for each measured
// trial; re-seeding per trial would make trials incomparable and re-using
// one seeded copy across trials would let the first trial's catch-up
// consume the backlog the second trial needed):
//
//   bun run scripts/read-amplification-harness.ts seed \
//     --source <vault-COPY> --out <seed-base-dir> --backlog 4000
//
//   bun run scripts/read-amplification-harness.ts run \
//     --seed-base <seed-base-dir> --manifest <out.json> --label tuned \
//     [--resolve-count 40] [--settle-ms 45000] [--keep-copy]
//
// `run` clones --seed-base into its own scratch dir (never mutates it),
// starts ONE real companion process (child_process.spawn, not an
// in-process import — must be the real boot path), and attributes kernel
// disk-IO bytes to four phases via a process-TREE rusage tracker (the
// connections materializer reconcile runs in a forked child by default,
// cli.ts: SIDETRACK_CONNECTIONS_CHILD='1' unless a test opts out — a
// parent-pid-only measurement would silently drop most of the
// connections-generation-db read volume):
//   1. boot       — process spawn → first /v1/version 200 (drains the
//                   seeded backlog's catch-up-critical path; NOT the full
//                   backlog since serve-stale reads never await catch-up).
//   1b. healthPoll — N GET /v1/system/health calls, BEFORE settle (so no
//                   drain-time artifact exists yet to short-circuit a live
//                   compute) — isolates workGraphHealth.ts's
//                   readEventsForHealth, the columnar-scan-routing task's
//                   (perf/columnar-scan-routing, 2026-08-18) routed
//                   full-history health/feedback fold.
//   2. settle     — fixed wall-clock window with no HTTP traffic, letting
//                   the connections drain / topic pass / embed-lane
//                   background cycles run to (approximate) completion.
//   3. resolves   — N GET /v1/visits/:url/resolve calls against real
//                   projection URLs (stratified sample, mirrors
//                   scripts/resolver-acceptance.ts).
//
// `seed --days-back N --seal` (columnar scan routing, 2026-08-18) spreads
// the synthetic backlog across N closed calendar days (instead of all on
// "today") and pre-seals them via the built `seal --run` CLI subcommand, so
// a `run` cloned from that seed-base has real `_BAC/seal/*.parquet`
// segments on disk — the precondition for SIDETRACK_COLUMNAR_SCANS to route
// anything at all. `--days-back 0` (default) keeps today's exact prior
// behavior (single day, unsealable, columnar routing a structural no-op).
//
// Safety: refuses to run against the live daily vault path, same guard as
// resolver-acceptance.ts. Only ever reads --source/--seed-base; all
// writes go to its own scratch copies.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProcessTreeRusageTracker } from './lib/procRusage.js';

// ---------------------------------------------------------------------------
// Shared filesystem / process helpers (duplicated from
// scripts/resolver-acceptance.ts rather than imported — that script does
// not export them, and this repo's convention is to keep small scripts
// self-contained rather than force a cross-script coupling for a few
// dozen lines; see e.g. recall-v2/store/sqlite.ts's own comment on the
// same tradeoff for `stripFragmentAndTrailingSlash`).
// ---------------------------------------------------------------------------

const copyVaultTree = async (source: string, dest: string): Promise<void> => {
  await mkdir(dirname(dest), { recursive: true });
  const clone = spawnSync('cp', ['-Rc', source, dest], { stdio: 'ignore' });
  if (clone.status !== 0) {
    const plain = spawnSync('cp', ['-R', source, dest], { stdio: 'ignore' });
    if (plain.status !== 0) {
      throw new Error(`Failed to copy vault tree from ${source} to ${dest}`);
    }
  }
  await rm(join(dest, '_BAC', 'recall', '.lock'), { force: true });
  await rm(join(dest, '_BAC', 'connections', 'current.publish.lock'), { force: true });
};

// Matches scripts/resolver-acceptance.ts's own guard exactly: only the
// DAILY vault is blocked. `~/.sidetrack-vault-test` is the documented
// read-only source for exactly this kind of benchmarking (see
// docs/DEBUGGING_DOCTRINE.md / repo memory — "Always use the TEST
// browser"); this script only ever COPIES it (`cp -Rc`), never writes to
// it, so sourcing from it while its own live companion runs is safe.
const assertNotLiveVaultPath = (vaultPath: string): void => {
  const liveVaultPath = resolvePath(join(homedir(), '.sidetrack-vault'));
  if (resolvePath(vaultPath) === liveVaultPath) {
    throw new Error(
      `Refusing to run: path points at the live daily vault (${liveVaultPath}). Point this at a COPY.`,
    );
  }
};

const getFreePort = async (): Promise<number> =>
  new Promise((resolveP, rejectP) => {
    const server = createServer();
    server.on('error', rejectP);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolveP(address.port);
        else rejectP(new Error('Could not allocate an ephemeral port.'));
      });
    });
  });

interface CompanionHandle {
  readonly proc: ChildProcess;
  readonly pid: number;
  readonly port: number;
  readonly baseUrl: string;
  readonly vaultRoot: string;
  readonly logPath: string;
  readonly bridgeKey: string;
}

// MUST be the BUILT dist entrypoint, not src/cli.ts. Verified empirically
// (2026-08-17): the connections reconcile child (sync/contract/
// connectionsReconcileChildClient.ts's `defaultEntryPath`) resolves its
// fork target relative to `import.meta.url` + a literal `.js` suffix
// (`connectionsReconcileChild.entry.js`) — a file that exists in dist/
// but NOT next to the .ts source. Running the harness against
// src/cli.ts produced a silent-looking (but logged) `[connections]
// catchUp failed: reconcile child entry not found at
// .../connectionsReconcileChild.entry.js` on every catch-up, meaning the
// connections-generation-db read path this harness exists to measure
// never ran at all. `bun run build` (in this package) before invoking
// `run` regenerates dist/.
const companionEntrypoint = (): string => {
  const here = fileURLToPath(import.meta.url);
  const distEntry = resolvePath(dirname(here), '..', 'dist', 'cli.js');
  if (!existsSync(distEntry)) {
    throw new Error(
      `Built entrypoint not found at ${distEntry} — run \`bun run build\` in packages/sidetrack-companion first ` +
        '(the harness must run the same dist/ the reconcile child\'s fork target resolves against).',
    );
  }
  return distEntry;
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
    `Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
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
      env: { ...process.env, SIDETRACK_INSTANCE_LABEL: 'read-amp-harness', SIDETRACK_HTTP_LOG: '1', ...extraEnv },
      stdio: ['ignore', logFd, logFd],
      detached: true,
    },
  );
  closeSync(logFd);
  if (proc.pid === undefined) throw new Error('Companion spawn did not yield a pid.');
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  proc.on('error', (error) => {
    console.error('[read-amp-harness] companion process error:', error);
  });
  await waitForHttpOk(`${baseUrl}/v1/version`, 30_000);
  const bridgeKey = await readBridgeKeyWithRetry(vaultRoot, 5_000);
  return { proc, pid: proc.pid, port, baseUrl, vaultRoot, logPath, bridgeKey };
};

const stopCompanion = async (handle: CompanionHandle): Promise<void> => {
  if (handle.proc.exitCode !== null) return;
  try {
    process.kill(-handle.pid, 'SIGTERM');
  } catch {
    handle.proc.kill('SIGTERM');
  }
  const deadline = Date.now() + 15_000;
  while (handle.proc.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (handle.proc.exitCode === null) {
    try {
      process.kill(-handle.pid, 'SIGKILL');
    } catch {
      handle.proc.kill('SIGKILL');
    }
  }
};

const fetchProjectionUrls = async (handle: CompanionHandle): Promise<readonly string[]> => {
  const res = await fetch(`${handle.baseUrl}/v1/visits/projection`, {
    headers: { 'x-bac-bridge-key': handle.bridgeKey },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { readonly data?: { readonly byCanonicalUrl?: Record<string, unknown> } };
  return Object.keys(body.data?.byCanonicalUrl ?? {});
};

const stratifiedSample = <T>(items: readonly T[], count: number): readonly T[] => {
  if (items.length <= count) return items;
  const step = items.length / count;
  const out: T[] = [];
  for (let index = 0; index < count; index += 1) out.push(items[Math.floor(index * step)] as T);
  return out;
};

const resolveOnce = async (handle: CompanionHandle, canonicalUrl: string): Promise<{ readonly ms: number; readonly status: number }> => {
  const url = `${handle.baseUrl}/v1/visits/${encodeURIComponent(canonicalUrl)}/resolve?dryRun=true`;
  const start = performance.now();
  const res = await fetch(url, { headers: { 'x-bac-bridge-key': handle.bridgeKey } });
  const ms = performance.now() - start;
  return { ms, status: res.status };
};

// ---------------------------------------------------------------------------
// Backlog seeding — writes AcceptedEvent JSONL lines DIRECTLY to a new,
// synthetic replica's log shard (no companion process involved), so the
// events are genuine on-disk backlog the NEXT boot's catch-up must drain —
// this is what makes the `boot` phase measure real catch-up work instead
// of an already-synced no-op. Envelope shape matches the one
// runtime/companion.test.ts posts to /v1/timeline/events (the documented
// "edge-event import path" full-AcceptedEvent shape) — same fields,
// written straight to the shard file bun:sqlite's own JSONL reader
// (sync/eventLog.ts's `isAcceptedEvent`) expects, since there's no running
// server yet to POST to.
// ---------------------------------------------------------------------------

const SEED_REPLICA_ID = 'harness-seed';
const BROWSER_TIMELINE_OBSERVED = 'browser.timeline.observed';
const USER_FLOW_REJECTED = 'user.flow.rejected';

// `daysBack` (columnar scan routing, 2026-08-18) — when omitted/0, behavior
// is BYTE-IDENTICAL to before (all `count` events on "today", one shard,
// timeline-only): every existing caller/test keeps working unchanged. When
// > 0, spreads `count` timeline events evenly across `daysBack` CLOSED
// calendar days ending YESTERDAY (never "today" — matches
// eventSeal.ts's runEventSealPass, which never seals the open day), one
// shard file per day, so `seal --run` (sealSeedBase below) has real
// multi-day history to seal. Also writes one USER_FLOW_REJECTED event per
// day — a real feedback type (src/feedback/events.ts), the same shape
// workGraphHealth.ts's readEventsForHealth folds — so the columnar-routed
// health-fold consumer has real matching rows spanning sealed history to
// read, not an empty type-scoped scan that would be cheap either way.
const seedBacklog = (
  vaultRoot: string,
  count: number,
  options: { readonly daysBack?: number } = {},
): void => {
  const daysBack = Math.max(0, Math.floor(options.daysBack ?? 0));
  const dir = join(vaultRoot, '_BAC', 'log', SEED_REPLICA_ID);
  mkdirSync(dir, { recursive: true });

  if (daysBack === 0) {
    const day = new Date().toISOString().slice(0, 10);
    const lines: string[] = [];
    const baseMs = Date.now() - count * 1000;
    for (let i = 1; i <= count; i += 1) {
      lines.push(JSON.stringify(timelineEvent(i, baseMs + i * 1000)));
    }
    writeFileSync(join(dir, `${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
    return;
  }

  // Spread across [daysBack .. 1] days ago, i.e. never today. Events per
  // day distributed evenly (remainder to the earliest days).
  const perDay = Math.floor(count / daysBack);
  let remainder = count - perDay * daysBack;
  let seq = 0;
  for (let daysAgo = daysBack; daysAgo >= 1; daysAgo -= 1) {
    const dayStartMs = Date.parse(
      `${new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T09:00:00.000Z`,
    );
    const day = new Date(dayStartMs).toISOString().slice(0, 10);
    const thisDayCount = perDay + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    const lines: string[] = [];
    // One feedback-type event per day FIRST (distinct seq, still causally
    // valid — this seed writes directly to a synthetic replica's shard, no
    // ordering contract beyond strictly-increasing per-replica seq).
    seq += 1;
    lines.push(JSON.stringify(feedbackEvent(seq, dayStartMs, day)));
    for (let i = 0; i < thisDayCount; i += 1) {
      seq += 1;
      lines.push(JSON.stringify(timelineEvent(seq, dayStartMs + (i + 1) * 1000)));
    }
    writeFileSync(join(dir, `${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  }
};

const timelineEvent = (seq: number, acceptedAtMs: number): object => {
  const observedAt = new Date(acceptedAtMs).toISOString();
  const url = `https://harness.read-amp.test/seed/${String(seq)}`;
  return {
    clientEventId: `harness-seed-${String(seq)}`,
    dot: { replicaId: SEED_REPLICA_ID, seq },
    deps: {},
    aggregateId: observedAt.slice(0, 10),
    type: BROWSER_TIMELINE_OBSERVED,
    payload: {
      eventId: `harness-seed-${String(seq)}`,
      url,
      canonicalUrl: url,
      title: `Read-amp harness seed ${String(seq)}`,
      observedAt,
      transition: 'activated',
      provider: 'generic',
    },
    acceptedAtMs,
  };
};

const feedbackEvent = (seq: number, acceptedAtMs: number, day: string): object => ({
  clientEventId: `harness-seed-feedback-${String(seq)}`,
  dot: { replicaId: SEED_REPLICA_ID, seq },
  deps: {},
  aggregateId: `harness-seed-feedback-${day}`,
  type: USER_FLOW_REJECTED,
  payload: {
    payloadVersion: 1,
    relationKind: 'closest_visit',
    fromId: `harness-seed-from-${day}`,
    toId: `harness-seed-to-${day}`,
    reason: 'other',
  },
  acceptedAtMs,
});

// Pre-seals a `seed`d vault (columnar scan routing, 2026-08-18): spawns the
// BUILT `seal` CLI subcommand (same dist/ entrypoint contract as
// companionEntrypoint — the sealer's own DuckDB write path needs no
// reconcile-child fork, but this keeps ONE built-artifact contract for the
// whole script) with SIDETRACK_EVENT_STORE=1 SIDETRACK_EVENT_SEAL=1, so the
// seed-base a `run` clones from already has real `_BAC/seal/*.parquet`
// segments on disk — cloning (cp -Rc) then carries them forward into every
// trial, matching the seed/run split's own "seed once, clone per trial"
// design.
const sealSeedBase = (vaultRoot: string): void => {
  const result = spawnSync(
    process.execPath,
    [companionEntrypoint(), 'seal', '--vault', vaultRoot, '--run', '--json'],
    {
      env: { ...process.env, SIDETRACK_EVENT_STORE: '1', SIDETRACK_EVENT_SEAL: '1' },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(`seal --run failed (status=${String(result.status)}): ${result.stderr}`);
  }
  console.log(`[seed] sealed: ${result.stdout.trim()}`);
};

// ---------------------------------------------------------------------------
// Phase-attributed measurement
// ---------------------------------------------------------------------------

interface PhaseReading {
  readonly diskioBytesRead: number;
  readonly diskioBytesWritten: number;
  readonly peakResidentSizeBytes: number;
  readonly peakPhysFootprintBytes: number;
}

interface Phase {
  readonly name: string;
  readonly durationMs: number;
  readonly bytesRead: number;
  readonly bytesWritten: number;
}

const usage = `Usage:
  bun run scripts/read-amplification-harness.ts seed --source <vault-COPY> --out <dir> [--backlog 4000] [--days-back 0] [--seal]
  bun run scripts/read-amplification-harness.ts run --seed-base <dir> --manifest <out.json> --label <str> [--resolve-count 40] [--health-poll-count 5] [--settle-ms 45000] [--keep-copy]
`;

const argVal = (argv: readonly string[], flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

const runSeed = async (argv: readonly string[]): Promise<void> => {
  const source = argVal(argv, '--source');
  const out = argVal(argv, '--out');
  const backlog = Number(argVal(argv, '--backlog') ?? '4000');
  const daysBack = Number(argVal(argv, '--days-back') ?? '0');
  const seal = argv.includes('--seal');
  if (source === undefined || out === undefined) {
    process.stderr.write(usage);
    throw new Error('--source and --out are required.');
  }
  const resolvedSource = resolvePath(source);
  assertNotLiveVaultPath(resolvedSource);
  if (!existsSync(resolvedSource)) throw new Error(`--source does not exist: ${resolvedSource}`);
  const resolvedOut = resolvePath(out);
  await rm(resolvedOut, { recursive: true, force: true });
  console.log(`[seed] copying ${resolvedSource} -> ${resolvedOut}`);
  await copyVaultTree(resolvedSource, resolvedOut);
  console.log(
    `[seed] writing ${String(backlog)} synthetic backlog events` +
      (daysBack > 0 ? ` spread across ${String(daysBack)} closed days` : ' (today)'),
  );
  seedBacklog(resolvedOut, backlog, { daysBack });
  if (seal) {
    if (daysBack <= 0) {
      console.warn('[seed] --seal with --days-back=0 seals nothing (today is never sealed) — ignoring.');
    } else {
      console.log('[seed] sealing closed days via `seal --run`');
      sealSeedBase(resolvedOut);
    }
  }
  console.log(`[seed] done: ${resolvedOut}`);
};

const runMeasurement = async (argv: readonly string[]): Promise<void> => {
  const seedBase = argVal(argv, '--seed-base');
  const manifestOut = argVal(argv, '--manifest');
  const label = argVal(argv, '--label') ?? 'run';
  const resolveCount = Number(argVal(argv, '--resolve-count') ?? '40');
  const healthPollCount = Number(argVal(argv, '--health-poll-count') ?? '5');
  const settleMs = Number(argVal(argv, '--settle-ms') ?? '45000');
  const keepCopy = argv.includes('--keep-copy');
  if (seedBase === undefined || manifestOut === undefined) {
    process.stderr.write(usage);
    throw new Error('--seed-base and --manifest are required.');
  }
  const resolvedSeedBase = resolvePath(seedBase);
  if (!existsSync(resolvedSeedBase)) throw new Error(`--seed-base does not exist: ${resolvedSeedBase}`);

  const workDir = await mkdtemp(join(tmpdir(), 'read-amp-run-'));
  const vaultCopy = join(workDir, 'vault');
  console.log(`[${label}] cloning seed-base -> ${vaultCopy}`);
  await copyVaultTree(resolvedSeedBase, vaultCopy);

  let handle: CompanionHandle | undefined;
  // Tracked separately from `handle` (which needs a bridge key + full
  // wire-up) so a failure between spawn() and readiness still gets the
  // process killed in `finally` instead of leaking it.
  let spawnedProc: ChildProcess | undefined;
  const phases: Phase[] = [];
  let pollerStopped = false;
  let pollerLoop: Promise<void> | undefined;
  try {
    const port = await getFreePort();
    const spawnStart = performance.now();
    console.log(`[${label}] spawning companion on :${String(port)}`);

    // Spawn manually (not via startCompanion) so the rusage tracker can
    // attach to the pid the instant it exists — startCompanion's own
    // await-for-ready would otherwise hide boot-phase I/O that happens
    // between spawn() and the first successful /v1/version poll.
    const logPath = join(workDir, 'companion.log');
    const logFd = openSync(logPath, 'a');
    const proc = spawn(
      process.execPath,
      [companionEntrypoint(), '--vault', vaultCopy, '--port', String(port)],
      {
        env: { ...process.env, SIDETRACK_INSTANCE_LABEL: 'read-amp-harness', SIDETRACK_HTTP_LOG: '1' },
        stdio: ['ignore', logFd, logFd],
        detached: true,
      },
    );
    closeSync(logFd);
    if (proc.pid === undefined) throw new Error('spawn did not yield a pid');
    spawnedProc = proc;
    const tracker = createProcessTreeRusageTracker(proc.pid);

    // ONE continuous background poller for the whole companion lifetime
    // (spawn → shutdown), not a per-phase loop — phase boundaries just
    // snapshot tracker.totals() at the right moments. Polls aggressively
    // (400ms) because the connections reconcile child (SIDETRACK_
    // CONNECTIONS_CHILD, default on) forks/exits per drain cycle and a
    // wide gap could miss a whole short-lived child's counters (the
    // tracker folds an exited pid's LAST seen counters into the running
    // total, so a coarser poll systematically undercounts fast children).
    pollerLoop = (async () => {
      while (!pollerStopped) {
        tracker.poll();
        await new Promise((r) => setTimeout(r, 400));
      }
    })();

    const readingAt = (): PhaseReading => {
      const t = tracker.totals();
      return {
        diskioBytesRead: t.diskioBytesRead,
        diskioBytesWritten: t.diskioBytesWritten,
        peakResidentSizeBytes: t.peakResidentSizeBytes,
        peakPhysFootprintBytes: t.peakPhysFootprintBytes,
      };
    };

    // --- Phase 1: boot (spawn -> first /v1/version 200) ---
    const before1 = readingAt();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    await waitForHttpOk(`${baseUrl}/v1/version`, 60_000);
    const after1 = readingAt();
    phases.push({
      name: 'boot',
      durationMs: performance.now() - spawnStart,
      bytesRead: after1.diskioBytesRead - before1.diskioBytesRead,
      bytesWritten: after1.diskioBytesWritten - before1.diskioBytesWritten,
    });

    const bridgeKey = await readBridgeKeyWithRetry(vaultCopy, 5_000);
    handle = { proc, pid: proc.pid, port, baseUrl, vaultRoot: vaultCopy, logPath, bridgeKey };

    // --- Phase 1b: health poll (columnar scan routing, 2026-08-18) ---
    // GET /v1/system/health BEFORE settle, while no connections drain has
    // produced a fresh workGraphHealth artifact yet (systemRoutes.ts's
    // readWorkGraphHealthArtifact freshness check) — this forces each call
    // to go through a LIVE collectWorkGraphHealth compute, i.e. through
    // workGraphHealth.ts's readEventsForHealth, the routed consumer this
    // phase exists to isolate. Polling AFTER settle would mostly hit the
    // drain-time artifact cache instead and measure nothing.
    const before1b = readingAt();
    const healthPollStart = performance.now();
    const healthStatusCounts: Record<string, number> = {};
    for (let i = 0; i < healthPollCount; i += 1) {
      const res = await fetch(`${baseUrl}/v1/system/health`, {
        headers: { 'x-bac-bridge-key': bridgeKey },
      });
      const key = String(res.status);
      healthStatusCounts[key] = (healthStatusCounts[key] ?? 0) + 1;
    }
    const after1b = readingAt();
    phases.push({
      name: 'healthPoll',
      durationMs: performance.now() - healthPollStart,
      bytesRead: after1b.diskioBytesRead - before1b.diskioBytesRead,
      bytesWritten: after1b.diskioBytesWritten - before1b.diskioBytesWritten,
    });

    // --- Phase 2: settle (background catch-up / topic / embed lane) ---
    const before2 = readingAt();
    const settleStart = performance.now();
    await new Promise((r) => setTimeout(r, settleMs));
    const after2 = readingAt();
    phases.push({
      name: 'settle',
      durationMs: performance.now() - settleStart,
      bytesRead: after2.diskioBytesRead - before2.diskioBytesRead,
      bytesWritten: after2.diskioBytesWritten - before2.diskioBytesWritten,
    });

    // --- Phase 3: resolve burst ---
    const candidateUrls = await fetchProjectionUrls(handle);
    const targets = stratifiedSample(candidateUrls, resolveCount);
    const before3 = readingAt();
    const resolveStart = performance.now();
    const resolveOutcomes: { readonly ms: number; readonly status: number }[] = [];
    for (const url of targets) {
      resolveOutcomes.push(await resolveOnce(handle, url));
    }
    const after3 = readingAt();
    phases.push({
      name: 'resolves',
      durationMs: performance.now() - resolveStart,
      bytesRead: after3.diskioBytesRead - before3.diskioBytesRead,
      bytesWritten: after3.diskioBytesWritten - before3.diskioBytesWritten,
    });

    const finalTotals = tracker.totals();
    const totalBytesRead = phases.reduce((sum, p) => sum + p.bytesRead, 0);
    const totalBytesWritten = phases.reduce((sum, p) => sum + p.bytesWritten, 0);

    const report = {
      label,
      generatedAt: new Date().toISOString(),
      bunVersion: typeof Bun !== 'undefined' ? Bun.version : 'unknown',
      env: {
        SIDETRACK_SQLITE_CACHE_MB: process.env['SIDETRACK_SQLITE_CACHE_MB'] ?? '(default)',
        SIDETRACK_SQLITE_MMAP_MB: process.env['SIDETRACK_SQLITE_MMAP_MB'] ?? '(default)',
        SIDETRACK_EVENT_SEAL: process.env['SIDETRACK_EVENT_SEAL'] ?? '(default/off)',
        SIDETRACK_COLUMNAR_SCANS: process.env['SIDETRACK_COLUMNAR_SCANS'] ?? '(default/on)',
      },
      seedBase: resolvedSeedBase,
      resolveCount: targets.length,
      healthPollCount,
      healthStatusCounts,
      settleMs,
      phases,
      totals: {
        bytesRead: totalBytesRead,
        bytesWritten: totalBytesWritten,
        bytesReadMB: Math.round((totalBytesRead / 1e6) * 10) / 10,
        bytesWrittenMB: Math.round((totalBytesWritten / 1e6) * 10) / 10,
        peakResidentSizeMB: Math.round((finalTotals.peakResidentSizeBytes / 1e6) * 10) / 10,
        peakPhysFootprintMB: Math.round((finalTotals.peakPhysFootprintBytes / 1e6) * 10) / 10,
        livePidCount: finalTotals.livePidCount,
      },
      resolveStatusCounts: resolveOutcomes.reduce<Record<string, number>>((acc, o) => {
        const key = String(o.status);
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    };

    await mkdir(dirname(resolvePath(manifestOut)), { recursive: true });
    await Bun.write(resolvePath(manifestOut), `${JSON.stringify(report, null, 2)}\n`);
    console.log('');
    console.log(`[${label}] phases:`);
    for (const p of phases) {
      console.log(
        `  ${p.name.padEnd(10)} ${(p.durationMs / 1000).toFixed(1)}s  read=${(p.bytesRead / 1e6).toFixed(1)}MB  written=${(p.bytesWritten / 1e6).toFixed(1)}MB`,
      );
    }
    console.log(
      `  TOTAL      read=${report.totals.bytesReadMB}MB written=${report.totals.bytesWrittenMB}MB peakRSS=${report.totals.peakResidentSizeMB}MB peakPhysFootprint=${report.totals.peakPhysFootprintMB}MB livePids=${report.totals.livePidCount}`,
    );
    console.log(`[${label}] wrote ${resolvePath(manifestOut)}`);
  } finally {
    pollerStopped = true;
    if (pollerLoop !== undefined) await pollerLoop;
    if (handle !== undefined) {
      await stopCompanion(handle);
    } else if (spawnedProc !== undefined && spawnedProc.exitCode === null) {
      // Died/never became ready between spawn() and readiness — kill it
      // directly (no bridge key to build a full CompanionHandle for
      // stopCompanion, but the pid is enough).
      const pid = spawnedProc.pid;
      try {
        if (pid !== undefined) process.kill(-pid, 'SIGKILL');
      } catch {
        spawnedProc.kill('SIGKILL');
      }
    }
    if (!keepCopy) await rm(workDir, { recursive: true, force: true });
    else console.log(`[${label}] kept working copy at ${workDir}`);
  }
};

const main = async (): Promise<void> => {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand === 'seed') {
    await runSeed(rest);
  } else if (subcommand === 'run') {
    await runMeasurement(rest);
  } else {
    process.stderr.write(usage);
    throw new Error(`Unknown subcommand: ${String(subcommand)}`);
  }
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error('[read-amp-harness] failed:', error);
    process.exitCode = 1;
  });
}

export { seedBacklog, stratifiedSample };
