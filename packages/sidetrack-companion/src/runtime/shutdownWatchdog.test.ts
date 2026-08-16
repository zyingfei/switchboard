import { describe, expect, it, vi } from 'vitest';

import {
  createShutdownWatchdog,
  formatDoubleSignalLine,
  formatWatchdogTimeoutLine,
  resolveShutdownGraceMs,
  type ShutdownDiagnosticsSnapshot,
} from './shutdownWatchdog.js';

// Manual timer harness — the controller only ever arms ONE timer at a
// time (the watchdog deadline), so a single-slot fake is enough and
// keeps these tests synchronous/deterministic without pulling in a
// fake-timers library.
const makeTimerHarness = (): {
  readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  readonly fire: () => void;
  readonly armedMs: () => number | null;
  readonly isCleared: () => boolean;
} => {
  let cb: (() => void) | null = null;
  let ms: number | null = null;
  let cleared = false;
  const token = {} as ReturnType<typeof setTimeout>;
  return {
    setTimer: (fn, delayMs) => {
      cb = fn;
      ms = delayMs;
      cleared = false;
      return token;
    },
    clearTimer: (handle) => {
      if (handle === token) cleared = true;
    },
    fire: () => {
      if (!cleared) cb?.();
    },
    armedMs: () => ms,
    isCleared: () => cleared,
  };
};

const flushMicrotasks = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

describe('resolveShutdownGraceMs', () => {
  it('defaults to 15000ms when unset', () => {
    expect(resolveShutdownGraceMs(undefined)).toBe(15_000);
  });

  it('parses a positive override', () => {
    expect(resolveShutdownGraceMs('5000')).toBe(5000);
  });

  it('falls back to the default on 0, negative, or non-numeric input — 0 is NOT unbounded', () => {
    expect(resolveShutdownGraceMs('0')).toBe(15_000);
    expect(resolveShutdownGraceMs('-100')).toBe(15_000);
    expect(resolveShutdownGraceMs('not-a-number')).toBe(15_000);
    expect(resolveShutdownGraceMs('')).toBe(15_000);
  });

  it('floors a fractional override', () => {
    expect(resolveShutdownGraceMs('1234.9')).toBe(1234);
  });

  it('honors a caller-supplied fallback', () => {
    expect(resolveShutdownGraceMs(undefined, 999)).toBe(999);
    expect(resolveShutdownGraceMs('bogus', 999)).toBe(999);
  });
});

describe('formatWatchdogTimeoutLine', () => {
  it('names the stuck stage and every pending materializer', () => {
    const diagnostics: ShutdownDiagnosticsSnapshot = {
      stage: 'draining-contract-runner',
      pendingMaterializers: ['connections', 'recall'],
      recallRebuildInFlight: true,
    };
    const line = formatWatchdogTimeoutLine('SIGTERM', 15_000, diagnostics);
    expect(line).toContain('SIGTERM');
    expect(line).toContain('15000ms');
    expect(line).toContain('stage="draining-contract-runner"');
    expect(line).toContain('connections, recall');
    expect(line).toContain('recallRebuildInFlight=true');
  });

  it('degrades gracefully when no diagnostics snapshot is available', () => {
    const line = formatWatchdogTimeoutLine('SIGTERM', 15_000, null);
    expect(line).toContain('no diagnostics available');
    expect(line).toContain('SIGTERM');
  });
});

describe('formatDoubleSignalLine', () => {
  it('names the repeated signal', () => {
    expect(formatDoubleSignalLine('SIGTERM')).toContain('SIGTERM');
    expect(formatDoubleSignalLine('SIGTERM')).toContain('again');
  });
});

describe('createShutdownWatchdog', () => {
  it('a clean close() before the grace timer clears the watchdog and exits 0', async () => {
    const harness = makeTimerHarness();
    const exit = vi.fn();
    const log = vi.fn();
    let resolveClose: () => void = () => undefined;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const controller = createShutdownWatchdog({
      graceMs: 15_000,
      close: () => closePromise,
      getDiagnostics: () => null,
      log,
      exit,
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
    });

    controller.handleSignal('SIGTERM');
    expect(controller.isShuttingDown()).toBe(true);
    expect(harness.armedMs()).toBe(15_000);

    resolveClose();
    await flushMicrotasks();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    // The watchdog timer must be cleared so it can never ALSO fire and
    // double-call exit later.
    expect(harness.isCleared()).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it('force-exits 1 and logs the stuck stage + pending materializers when the grace timer fires first (the SIGTERM-hang scenario)', () => {
    const harness = makeTimerHarness();
    const exit = vi.fn();
    const log = vi.fn();
    const forceRelease = vi.fn();
    // Never resolves — models the pre-fix bug: awaitIdle() spinning
    // forever because a lane kept re-marking a materializer dirty.
    const neverResolves = new Promise<void>(() => undefined);
    const controller = createShutdownWatchdog({
      graceMs: 15_000,
      close: () => neverResolves,
      getDiagnostics: () => ({
        stage: 'draining-contract-runner',
        pendingMaterializers: ['connections'],
        recallRebuildInFlight: false,
      }),
      log,
      exit,
      forceRelease,
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
    });

    controller.handleSignal('SIGTERM');
    harness.fire();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(forceRelease).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    const [line] = log.mock.calls[0] as [string];
    expect(line).toContain('connections');
    expect(line).toContain('draining-contract-runner');
  });

  it('a second signal while a shutdown is already in flight skips the grace period and force-exits immediately', () => {
    const harness = makeTimerHarness();
    const exit = vi.fn();
    const log = vi.fn();
    const forceRelease = vi.fn();
    const neverResolves = new Promise<void>(() => undefined);
    const controller = createShutdownWatchdog({
      graceMs: 15_000,
      close: () => neverResolves,
      getDiagnostics: () => null,
      log,
      exit,
      forceRelease,
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
    });

    controller.handleSignal('SIGTERM');
    expect(exit).not.toHaveBeenCalled();

    controller.handleSignal('SIGTERM');

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(forceRelease).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some((call) => String(call[0]).includes('again'))).toBe(true);
    // The original watchdog timer must be torn down too — otherwise it
    // could fire later and call exit() a second time.
    expect(harness.isCleared()).toBe(true);

    // A THIRD signal must not call exit again (idempotent past the
    // first force-exit).
    controller.handleSignal('SIGTERM');
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('a rejecting close() force-exits 1 and logs the error instead of hanging silently', async () => {
    const harness = makeTimerHarness();
    const exit = vi.fn();
    const log = vi.fn();
    const controller = createShutdownWatchdog({
      graceMs: 15_000,
      close: () => Promise.reject(new Error('boom')),
      getDiagnostics: () => null,
      log,
      exit,
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
    });

    controller.handleSignal('SIGTERM');
    await flushMicrotasks();

    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.some((call) => String(call[0]).includes('boom'))).toBe(true);
    expect(harness.isCleared()).toBe(true);
  });

  it('SIGINT and SIGTERM share the same in-flight-shutdown gate', () => {
    const harness = makeTimerHarness();
    const exit = vi.fn();
    const log = vi.fn();
    const neverResolves = new Promise<void>(() => undefined);
    const controller = createShutdownWatchdog({
      graceMs: 15_000,
      close: () => neverResolves,
      getDiagnostics: () => null,
      log,
      exit,
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
    });

    controller.handleSignal('SIGTERM');
    controller.handleSignal('SIGINT');

    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.some((call) => String(call[0]).includes('SIGINT'))).toBe(true);
  });
});
