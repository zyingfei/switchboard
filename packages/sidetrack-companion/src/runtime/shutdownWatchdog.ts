// SIGTERM/SIGINT shutdown watchdog.
//
// Observed live (2026-08-15/16, twice): SIGTERM closed the HTTP listener,
// then graceful shutdown hung FOREVER — a background lane kept appending
// new accepted events, so the contract-runner drain companion.ts's close()
// awaits never converged (see the root-cause note on close() in
// runtime/companion.ts). The process never exited, held the recall
// process lock, and the next companion boot refused to start with
// "Another companion (pid N) already owns the recall index". Operator
// recovery both times required SIGKILL.
//
// companion.ts's close() now stops every event-producing lane BEFORE
// draining, which fixes the specific hang that was observed. This module
// is the second, independent layer: a bounded watchdog so ANY future
// close() regression — a different lane, a wedged child process, a
// reconcile fork that never exits — degrades to a loud, bounded failure
// instead of an unrecoverable hang.
//
// Contract:
//   - First SIGINT/SIGTERM: start close() and arm a graceMs timer.
//   - close() resolves before the timer fires -> clean process.exit(0).
//   - close() is still running when the timer fires -> log one line
//     naming what's still pending (from getDiagnostics()), release what
//     we can, and process.exit(1).
//   - A second signal of EITHER kind while a shutdown is already in
//     flight -> skip the grace period entirely, log, and exit(1)
//     immediately (an operator sending SIGTERM twice wants out now).
//
// Kept dependency-injected (close/getDiagnostics/log/exit/timers) so the
// state machine is unit-testable without spawning a real process or
// calling the real process.exit — see shutdownWatchdog.test.ts.

export interface ShutdownDiagnosticsSnapshot {
  readonly stage: string;
  readonly pendingMaterializers: readonly string[];
  readonly recallRebuildInFlight: boolean;
}

export interface ShutdownWatchdogDeps {
  /** Runs the real graceful shutdown (closes the HTTP listener, drains
   * lanes/materializers, releases the recall lock, etc). */
  readonly close: (signal: NodeJS.Signals) => Promise<void>;
  /** Best-effort snapshot of where close() has gotten to. Returns null if
   * the runtime hasn't started far enough to have one (e.g. a very early
   * signal during boot). */
  readonly getDiagnostics: () => ShutdownDiagnosticsSnapshot | null;
  /** Grace period in ms before the watchdog force-exits. */
  readonly graceMs: number;
  readonly log: (line: string) => void;
  readonly exit: (code: number) => void;
  /** Best-effort extra teardown run only on the watchdog-timeout or
   * double-signal paths (e.g. SIGKILL a child the graceful path didn't
   * get to). Never awaited — must not itself hang. */
  readonly forceRelease?: () => void;
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface ShutdownWatchdogController {
  readonly handleSignal: (signal: NodeJS.Signals) => void;
  /** True once the first signal has been received. Exposed for tests. */
  readonly isShuttingDown: () => boolean;
}

const DEFAULT_GRACE_MS = 15_000;

/** Parses SIDETRACK_SHUTDOWN_GRACE_MS. Any non-finite/non-positive value
 * (unset, garbage, 0, negative) falls back to the 15s default — 0 does NOT
 * mean "unbounded"; a watchdog with no bound isn't a watchdog. */
export const resolveShutdownGraceMs = (
  raw: string | undefined,
  fallbackMs: number = DEFAULT_GRACE_MS,
): number => {
  if (raw === undefined) return fallbackMs;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallbackMs;
};

export const formatWatchdogTimeoutLine = (
  signal: NodeJS.Signals,
  graceMs: number,
  diagnostics: ShutdownDiagnosticsSnapshot | null,
): string => {
  if (diagnostics === null) {
    return (
      `[shutdown] watchdog: graceful shutdown after ${signal} did not complete within ` +
      `${String(graceMs)}ms (no diagnostics available) — forcing exit`
    );
  }
  const pending =
    diagnostics.pendingMaterializers.length > 0
      ? diagnostics.pendingMaterializers.join(', ')
      : 'none';
  return (
    `[shutdown] watchdog: graceful shutdown after ${signal} did not complete within ` +
    `${String(graceMs)}ms — stuck at stage="${diagnostics.stage}" ` +
    `pendingMaterializers=[${pending}] recallRebuildInFlight=${String(diagnostics.recallRebuildInFlight)} ` +
    '— forcing exit'
  );
};

export const formatDoubleSignalLine = (signal: NodeJS.Signals): string =>
  `[shutdown] received ${signal} again while a shutdown was already in progress — forcing immediate exit`;

export const createShutdownWatchdog = (deps: ShutdownWatchdogDeps): ShutdownWatchdogController => {
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  let shuttingDown = false;
  let watchdogHandle: ReturnType<typeof setTimeout> | null = null;
  let exited = false;

  const clearWatchdog = (): void => {
    if (watchdogHandle !== null) {
      clearTimer(watchdogHandle);
      watchdogHandle = null;
    }
  };

  const forceExit = (code: number): void => {
    if (exited) return;
    exited = true;
    clearWatchdog();
    deps.exit(code);
  };

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      deps.log(formatDoubleSignalLine(signal));
      deps.forceRelease?.();
      forceExit(1);
      return;
    }
    shuttingDown = true;

    watchdogHandle = setTimer(() => {
      watchdogHandle = null;
      deps.log(formatWatchdogTimeoutLine(signal, deps.graceMs, deps.getDiagnostics()));
      deps.forceRelease?.();
      forceExit(1);
    }, deps.graceMs);

    deps
      .close(signal)
      .then(() => {
        forceExit(0);
      })
      .catch((error: unknown) => {
        deps.log(
          `[shutdown] close() threw during ${signal} shutdown: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        deps.forceRelease?.();
        forceExit(1);
      });
  };

  return { handleSignal, isShuttingDown: () => shuttingDown };
};
