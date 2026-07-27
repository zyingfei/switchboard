// Parent-side client for the connections reconcile child process.
//
// Mirrors connectionsReconcileWorker.ts but uses `child_process.fork`
// instead of `worker_threads.Worker`. Why fork over worker_thread:
// the reconcile path transitively loads native addons (onnxruntime-
// node, usearch, sharp). Instantiating those addons in two V8
// isolates inside the same process triggers fatal "HeapObject::
// SafeSizeFromMap" crashes in the concurrent major sweeper. Each
// child gets its own V8, so the conflict is structurally impossible.
//
// One child per drain (no resident process) keeps heap bounded: the
// materializer's buildConnectionsSnapshot allocates a lot for a big
// vault, and forking fresh per drain means the OS reclaims it cleanly
// on exit instead of letting it accumulate across thousands of drains.
//
// M7 — hang safety. The reconcile child settles the parent promise on
// message/error/exit only. A child stuck in a native-addon deadlock
// (usearch/onnx) posts nothing and never exits, so the promise never
// settles, the materializer's single-flight `running=true` guard stays
// latched forever, and drains stop permanently AND silently. Two
// hardening layers here:
//
//   1. Progress-aware timeout. A boot catch-up over a real vault can
//      legitimately run 30+ minutes, so a fixed total-duration timeout
//      would false-positive. Instead we time out on NO PROGRESS: every
//      heartbeat / progress message / stdout line resets a watchdog;
//      if the child goes silent for longer than the no-progress window
//      we SIGKILL it and settle with a typed error. The entry posts a
//      periodic heartbeat so a live-but-quiet phase still ticks.
//
//   2. Lifecycle cleanup. The live child is tracked in a module set;
//      on parent SIGTERM/SIGINT/exit we best-effort kill it. Its pid is
//      also written to a pidfile under `_BAC/connections/`, so a
//      `kill -9` of the PARENT (which skips our handlers) leaves a
//      discoverable orphan that still holds the current.db write lock —
//      the next boot detects and kills it before starting drains,
//      closing the two-writer race observed live this week.

import { setPriority } from 'node:os';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';

import { withBunSmolExecArgv } from '../../process/bunMemory.js';
import type { ReconcileWorkerJob, ReconcileWorkerResult } from './connectionsReconcileWorker.js';

let childScriptPath: string | undefined;

const markPostDrain = (label: string, startedAtMs: number): void => {
  const elapsedMs = Date.now() - startedAtMs;
  console.warn(`[connections-phase] post-drain.${label} dt=${String(elapsedMs)}ms`);
};

const defaultEntryPath = (): string => {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), 'connectionsReconcileChild.entry.js');
};

/** Test seam — point the harness at a different entry script. */
export const setReconcileChildScriptOverride = (path: string | undefined): void => {
  childScriptPath = path;
};

// ---------------------------------------------------------------------------
// Progress-aware timeout tuning.
//
// The watchdog fires only after the child has produced NO signal (no
// heartbeat, no progress message, no stdout) for this long. Default 10
// minutes: comfortably above the child's heartbeat cadence, below the
// point where a truly-wedged drain has silently parked the pipeline for
// an operator-noticeable stretch. Env-tunable for stress tests and for
// operators debugging a genuinely slow vault.
// ---------------------------------------------------------------------------
const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 10 * 60_000;

const noProgressTimeoutMs = (): number => {
  const raw = process.env['SIDETRACK_CONNECTIONS_CHILD_NOPROGRESS_MS'];
  if (raw === undefined) return DEFAULT_NO_PROGRESS_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_NO_PROGRESS_TIMEOUT_MS;
  return parsed;
};

// ---------------------------------------------------------------------------
// Drain diagnostics counters (module-scoped, process-lifetime). Surfaced
// via getReconcileChildDiagnostics() so a caller (drain diagnostics) or a
// future health assembly (canary lane) can read the timeout/orphan-kill
// rates without this module importing either. Absent==0 semantics.
// ---------------------------------------------------------------------------
export interface ReconcileChildDiagnostics {
  /** Children SIGKILLed by the no-progress watchdog. */
  readonly timeoutKills: number;
  /** Children killed by parent-death cleanup (SIGTERM/SIGINT/exit). */
  readonly parentDeathKills: number;
  /** Stale orphan children killed at boot from a prior run's pidfile. */
  readonly orphanKillsAtBoot: number;
  /** Timestamp (ms) of the most recent no-progress timeout, if any. */
  readonly lastTimeoutAtMs: number | undefined;
  /**
   * Concurrent reconcile requests that rode an in-flight child instead of
   * forking a rival (single-flight coalescing). This is belt-and-suspenders:
   * in the current single-materializer-per-process topology it stays 0 (the
   * materializer's module-scope `running` flag already single-flights catchUp
   * vs drain, and a rival parent for the same vault is blocked by the port
   * bind), so it is NOT the source of the measured boot double-CPU — that was
   * a prior-deploy orphan child (covered by the boot orphan sweep) and/or the
   * parent running its own heavy boot phases alongside the single child. A
   * non-zero value would only appear if a future refactor embedded a second
   * materializer for the same vault in one process.
   */
  readonly coalescedForks: number;
}

const diagnostics = {
  timeoutKills: 0,
  parentDeathKills: 0,
  orphanKillsAtBoot: 0,
  lastTimeoutAtMs: undefined as number | undefined,
  coalescedForks: 0,
};

export const getReconcileChildDiagnostics = (): ReconcileChildDiagnostics => ({
  timeoutKills: diagnostics.timeoutKills,
  parentDeathKills: diagnostics.parentDeathKills,
  orphanKillsAtBoot: diagnostics.orphanKillsAtBoot,
  lastTimeoutAtMs: diagnostics.lastTimeoutAtMs,
  coalescedForks: diagnostics.coalescedForks,
});

/** Test seam — reset counters between cases. */
export const resetReconcileChildDiagnostics = (): void => {
  diagnostics.timeoutKills = 0;
  diagnostics.parentDeathKills = 0;
  diagnostics.orphanKillsAtBoot = 0;
  diagnostics.lastTimeoutAtMs = undefined;
  diagnostics.coalescedForks = 0;
};

// ---------------------------------------------------------------------------
// Live-child registry + parent-death cleanup. Any child we fork is tracked
// here for the duration of its run; the process-exit handlers below kill
// whatever is still live so a graceful parent shutdown never orphans a
// child that holds the current.db write lock.
// ---------------------------------------------------------------------------
const liveChildren = new Set<ChildProcess>();

const killChild = (child: ChildProcess): void => {
  try {
    child.kill('SIGKILL');
  } catch {
    /* already exited */
  }
};

// ---------------------------------------------------------------------------
// Signal re-raise policy (opt-in).
//
// On SIGTERM/SIGINT this module's handler kills live children, then — ONLY
// if re-raise is enabled — removes itself and re-raises the signal to
// restore the default terminate-on-signal disposition. That re-raise is
// OFF by default and must be explicitly opted into by a programmatic
// embedding that has NO other shutdown handler (installing a SIGTERM `on`
// listener suppresses the default disposition, so without a re-raise the
// signal would be swallowed and the process would hang).
//
// Why not infer 'am I the sole listener?' from process.listenerCount: the
// CLI registers its graceful-shutdown handler with process.once (see
// cli.ts), and Node removes a once-wrapper from the listeners array BEFORE
// the wrapped fn returns. So during a real CLI SIGTERM, by the time this
// (later-registered) `on` handler runs, listenerCount already reads 1 —
// this handler MIS-READS itself as the sole listener, re-raises the signal
// SYNCHRONOUSLY, and terminates the process while the CLI's async
// `closeAll().finally(process.exit)` is still in flight, truncating the
// graceful DB-lock-release/flush. The heuristic is therefore unsound; a
// caller must instead declare its intent explicitly.
//
// The 'exit' handler below already kills children on EVERY graceful path
// (including the CLI's process.exit), so leaving re-raise off does not
// leak children.
// ---------------------------------------------------------------------------
let reRaiseSignalsOnParentDeath = false;

/**
 * Opt into re-raising SIGTERM/SIGINT after this module's cleanup runs.
 *
 * Call this ONLY from a programmatic embedding that installs no other
 * shutdown handler and needs the process to terminate on signal. Do NOT
 * call it when a CLI/host owns graceful shutdown (the default): re-raising
 * would race and truncate that host's async close.
 */
export const setReconcileChildReRaiseSignalsOnParentDeath = (enabled: boolean): void => {
  reRaiseSignalsOnParentDeath = enabled;
};

let parentHandlersInstalled = false;
const installParentDeathHandlers = (): void => {
  if (parentHandlersInstalled) return;
  parentHandlersInstalled = true;
  const cleanup = (): void => {
    for (const child of liveChildren) {
      diagnostics.parentDeathKills += 1;
      killChild(child);
    }
    liveChildren.clear();
  };
  // 'exit' runs on EVERY normal termination path — a bare process end, an
  // explicit `process.exit()`, and after any signal handler that calls
  // exit itself. It is synchronous and the reliable seam for the kill; a
  // `kill -9` bypasses it entirely, which is exactly what the boot
  // pidfile sweep exists to catch.
  process.on('exit', cleanup);
  // Signal handlers are a best-effort supplement. They always kill live
  // children; they re-raise the signal (restoring the default terminate
  // disposition) ONLY when a programmatic embedding has opted in via
  // setReconcileChildReRaiseSignalsOnParentDeath. Under the CLI (default)
  // re-raise stays off so we never race the CLI's graceful async shutdown.
  const makeSignalHandler = (signal: 'SIGTERM' | 'SIGINT'): (() => void) => {
    const handler = (): void => {
      cleanup();
      if (reRaiseSignalsOnParentDeath) {
        // Restore the default disposition by removing ourselves and
        // re-raising, otherwise the signal would be swallowed and a
        // handler-only process would hang.
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      }
    };
    return handler;
  };
  process.on('SIGTERM', makeSignalHandler('SIGTERM'));
  process.on('SIGINT', makeSignalHandler('SIGINT'));
};

// ---------------------------------------------------------------------------
// Orphan pidfile. The pidfile records the CURRENTLY-LIVE child's pid so a
// `kill -9` of the parent (which skips the handlers above) leaves a
// discoverable orphan. It lives beside the snapshot store under
// `_BAC/connections/` — the same directory the child writes current.db
// into, so it travels with the artifact it protects.
// ---------------------------------------------------------------------------
const connectionsDir = (vaultRoot: string): string => join(vaultRoot, '_BAC', 'connections');
const childPidfilePath = (vaultRoot: string): string =>
  join(connectionsDir(vaultRoot), '.reconcile-child.pid');

const isPidAlive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 is a permission probe: sends nothing, throws if the
    // process is gone (or owned by another user).
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const writeChildPidfile = (vaultRoot: string, pid: number): void => {
  try {
    mkdirSync(connectionsDir(vaultRoot), { recursive: true });
    writeFileSync(childPidfilePath(vaultRoot), `${String(pid)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Pidfile is best-effort safety, never the drain's critical path.
  }
};

const clearChildPidfile = (vaultRoot: string, pid: number): void => {
  try {
    const path = childPidfilePath(vaultRoot);
    if (!existsSync(path)) return;
    const current = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    // Only clear if it's still OUR child's pidfile — a newer drain may
    // have already overwritten it with its own child.
    if (current === pid) unlinkSync(path);
  } catch {
    /* nothing to clear */
  }
};

/**
 * Boot-time orphan sweep. If a prior companion was `kill -9`'d mid-drain
 * its child is still alive holding the current.db write lock. Detect it
 * from the pidfile and SIGKILL it BEFORE starting any drains, so the new
 * process is the sole writer. Idempotent; safe to call on every boot.
 */
export const cleanupOrphanReconcileChild = (
  vaultRoot: string,
): { readonly killed: boolean; readonly pid: number | undefined } => {
  const path = childPidfilePath(vaultRoot);
  let pid: number | undefined;
  try {
    if (!existsSync(path)) return { killed: false, pid: undefined };
    const parsed = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) pid = parsed;
  } catch {
    return { killed: false, pid: undefined };
  }
  // A stale pidfile whose pid is our own or already dead: just remove it.
  if (pid === undefined || pid === process.pid || !isPidAlive(pid)) {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
    return { killed: false, pid };
  }
  try {
    process.kill(pid, 'SIGKILL');
    diagnostics.orphanKillsAtBoot += 1;
  } catch {
    // Owned by another user or vanished between the probe and the kill.
  }
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
  return { killed: true, pid };
};

export const buildReconcileChildEnv = (
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => ({ ...source });

interface ReconcileChildMessage {
  readonly kind: 'reconcile';
  readonly vaultRoot: string;
  readonly seq: number;
}

// The child's heartbeat message. Distinct `kind` so the message handler
// never mistakes a progress tick for the final result.
interface ReconcileHeartbeatMessage {
  readonly kind: 'heartbeat';
}

const isHeartbeat = (raw: unknown): raw is ReconcileHeartbeatMessage =>
  typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'heartbeat';

/**
 * Fork a child process and run one reconcile pass. The promise resolves
 * with the child's result; the seq token round-trips so the caller can
 * ignore stale responses if a newer drain finished first.
 *
 * The promise ALWAYS settles: on message, error, exit, or — if the child
 * wedges silently — a no-progress watchdog timeout that SIGKILLs it.
 */
const forkReconcileChild = (job: ReconcileWorkerJob): Promise<ReconcileWorkerResult> =>
  new Promise<ReconcileWorkerResult>((resolve) => {
    const entry = childScriptPath ?? defaultEntryPath();
    if (!existsSync(entry)) {
      resolve({
        seq: job.seq,
        ok: false,
        error: `reconcile child entry not found at ${entry}`,
      });
      return;
    }
// The drain child is CPU-BOUND and long: it runs ONNX embedding for the visit
// -similarity corpus (visitSimilarity.ts embeds passage+query texts for every
// eligible visit), which on a real vault means minutes of full-core work —
// measured live 2026-07-27: connectionsReconcileChild at ~100% CPU for 11+
// minutes straight. At equal scheduling priority that starves the PARENT,
// whose only job is answering the panel: resolve p95 went to 17.5s against
// the extension's 15s timeout, and the user saw "Companion did not respond
// within 15s" during normal browsing.
//
// Serving beats batch. Dropping the child to background priority lets the OS
// preempt it whenever the parent has an HTTP request to answer; the drain
// still finishes (it is not throttled, just yielded), and on an otherwise
// idle machine it runs at the same speed because nothing competes.
//
// Best-effort by construction: os.setPriority can throw (unsupported
// platform, insufficient permission for negative values). A failure must
// never break a drain, so it is swallowed. SIDETRACK_DRAIN_NICE overrides the
// value; 0 disables the demotion entirely.
const DEFAULT_DRAIN_NICE = 10;

const lowerChildPriority = (pid: number): void => {
  const raw = process.env['SIDETRACK_DRAIN_NICE'];
  const parsed = raw === undefined ? DEFAULT_DRAIN_NICE : Number.parseInt(raw, 10);
  const nice = Number.isFinite(parsed) ? parsed : DEFAULT_DRAIN_NICE;
  if (nice === 0) return;
  try {
    setPriority(pid, nice);
  } catch {
    // Priority is an optimisation, never a correctness requirement.
  }
};

    installParentDeathHandlers();
    const child: ChildProcess = fork(entry, [], {
      env: buildReconcileChildEnv(),
      execArgv: withBunSmolExecArgv(process.execArgv),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    liveChildren.add(child);
    if (typeof child.pid === 'number') {
      writeChildPidfile(job.vaultRoot, child.pid);
      lowerChildPriority(child.pid);
    }

    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const clearWatchdog = (): void => {
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
        watchdog = undefined;
      }
    };
    // Reset on any sign of life. If the child stays silent past the
    // window we treat it as wedged and kill it.
    const bumpWatchdog = (): void => {
      if (settled) return;
      clearWatchdog();
      watchdog = setTimeout(onNoProgress, noProgressTimeoutMs());
      watchdog.unref?.();
    };

    const settle = (result: ReconcileWorkerResult): void => {
      if (settled) return;
      settled = true;
      clearWatchdog();
      liveChildren.delete(child);
      if (typeof child.pid === 'number') clearChildPidfile(job.vaultRoot, child.pid);
      // Best-effort terminate; ignore errors from an already-exited child.
      try {
        child.kill('SIGTERM');
      } catch {
        /* child already exited */
      }
      resolve(result);
    };

    function onNoProgress(): void {
      if (settled) return;
      diagnostics.timeoutKills += 1;
      diagnostics.lastTimeoutAtMs = Date.now();
      const pid = typeof child.pid === 'number' ? child.pid : -1;
      console.warn(
        `[reconcile.child] no-progress timeout after ${String(noProgressTimeoutMs())}ms; ` +
          `SIGKILL pid=${String(pid)} seq=${String(job.seq)}`,
      );
      // SIGKILL (not SIGTERM): a child wedged in a native-addon deadlock
      // is not running JS and will never honour a graceful signal.
      killChild(child);
      settle({
        seq: job.seq,
        ok: false,
        error: `reconcile child timed out (no progress for ${String(noProgressTimeoutMs())}ms); killed`,
      });
    }

    child.stdout?.on('data', (buf: Buffer) => {
      bumpWatchdog();
      process.stdout.write(`[reconcile.child] ${buf.toString('utf8')}`);
    });
    child.stderr?.on('data', (buf: Buffer) => {
      bumpWatchdog();
      process.stderr.write(`[reconcile.child] ${buf.toString('utf8')}`);
    });
    child.on('message', (raw: unknown) => {
      if (isHeartbeat(raw)) {
        bumpWatchdog();
        return;
      }
      const receivedAtMs = Date.now();
      const result = raw as ReconcileWorkerResult;
      if (result.ok && result.snapshotRevision !== undefined) {
        markPostDrain('ipc-message', receivedAtMs);
      }
      settle(result);
    });
    child.on('error', (err) => {
      settle({ seq: job.seq, ok: false, error: err.message });
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settle({
        seq: job.seq,
        ok: false,
        error: `reconcile child exited code=${String(code)} signal=${String(signal ?? '')} without posting result`,
      });
    });
    const message: ReconcileChildMessage = {
      kind: 'reconcile',
      vaultRoot: job.vaultRoot,
      seq: job.seq,
    };
    child.send(message);
    // Arm the watchdog once the fork is wired; the initial window covers
    // the spawn-to-first-heartbeat gap.
    bumpWatchdog();
  });

// ---------------------------------------------------------------------------
// Single-flight coalescing — belt-and-suspenders, NOT the root of the measured
// boot double-CPU. Two live reconcile children (both holding the current.db
// write lock) would saturate every core and starve the parent event loop. But
// in the current topology that pair cannot arise from ONE materializer: the
// module-scope `running` flag single-flights catchUp vs drain within an
// instance, so drainViaWorker is never entered concurrently from it; a rival
// parent for the same vault is blocked by the :17374 port bind; and an ORPHAN
// child from a prior kill-9 is SIGKILLed by sweepBootOrphanChildOnce before the
// first fork. So the measured "two children at ~95% CPU" was a prior-deploy
// orphan (the sweep covers it) and/or the single child pegging while the parent
// runs its own heavy boot phases — offenders #1/#2, not a rival fork. This
// guard is kept only for the future case where a second materializer for the
// same vault is embedded in one process. It coalesces per-vaultRoot: while a
// child is live, a concurrent request rides its promise instead of forking a
// rival. The winner's `seq` round-trips, and the materializer's own
// `seq <= lastWorkerDrainSeqCompleted` staleness check (drainViaWorker) drops
// the piggybacking caller's now-stale view exactly as it drops a superseded
// drain — so coalescing is invisible to correctness, it only removes the
// duplicate fork. Fan-out-on-failure: forkReconcileChild never rejects (it
// resolves `{ok:false}` on timeout/exit/error), so a rider inherits the
// winner's failure verbatim; both riders then set dirty=true in drainViaWorker
// and retry (a retry forks a FRESH child, since the map entry is cleared in
// `.finally`), so a transient single-child failure self-heals. Disable with
// SIDETRACK_RECONCILE_CHILD_SINGLE_FLIGHT=0 to restore independent forks.
// ---------------------------------------------------------------------------
const inFlightReconcileByVault = new Map<string, Promise<ReconcileWorkerResult>>();

const reconcileChildSingleFlightEnabled = (): boolean =>
  process.env['SIDETRACK_RECONCILE_CHILD_SINGLE_FLIGHT'] !== '0';

export const runReconcileInChild = (job: ReconcileWorkerJob): Promise<ReconcileWorkerResult> => {
  if (!reconcileChildSingleFlightEnabled()) return forkReconcileChild(job);
  const existing = inFlightReconcileByVault.get(job.vaultRoot);
  if (existing !== undefined) {
    diagnostics.coalescedForks += 1;
    // Return the in-flight child's result but stamp THIS caller's seq so the
    // materializer's stale-drain check keys off the seq it dispatched.
    return existing.then((result) => ({ ...result, seq: job.seq }));
  }
  const started = forkReconcileChild(job).finally(() => {
    if (inFlightReconcileByVault.get(job.vaultRoot) === started) {
      inFlightReconcileByVault.delete(job.vaultRoot);
    }
  });
  inFlightReconcileByVault.set(job.vaultRoot, started);
  return started;
};
