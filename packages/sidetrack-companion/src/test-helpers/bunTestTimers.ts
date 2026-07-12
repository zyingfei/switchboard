// Bun-test-compatible replacements for the vitest timer/polling
// helpers that this package's suites depend on. `bun test` ships a
// vitest-compatible `vi` shim, but it only exposes the SYNCHRONOUS
// fake-timer surface (useFakeTimers / advanceTimersByTime /
// useRealTimers) — not vitest's async variants (advanceTimersByTimeAsync)
// nor vi.waitFor. These helpers rebuild just those two behaviors on
// top of the bun-supported primitives so the migrated suites stay
// meaningful under the declared `bun test` runner.
import { vi } from 'vitest';

// Flush the microtask queue a bounded number of times. Fake-timer
// callbacks in this codebase (e.g. the workGraph health scheduler)
// are async: firing a timer runs a `.then` chain that may resolve a
// promise, schedule a follow-up timer, or flip a guard flag. A single
// `await Promise.resolve()` only drains one microtask hop; async
// callbacks that await internally need several. The bound keeps a
// runaway promise loop from hanging the test.
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
};

// Async analogue of vitest's `vi.advanceTimersByTimeAsync`. bun's
// `vi.advanceTimersByTime` is synchronous — it fires every timer due
// within the window but does NOT yield to the microtask queue between
// them, so an async timer callback's continuation (and any timer it
// schedules) would otherwise not run until the next explicit await.
// Advancing the fake clock and then draining microtasks reproduces
// the vitest semantics the suites were written against: after the
// call returns, all timer callbacks due in `ms` have both fired and
// settled their synchronous-plus-microtask work.
export const advanceTimersByTimeAsync = async (ms: number): Promise<void> => {
  vi.advanceTimersByTime(ms);
  await flushMicrotasks();
};

// Local replacement for `vi.waitFor`: poll `assertion` on REAL timers
// until it stops throwing or the deadline elapses. Used by suites that
// wait on out-of-band effects (an SSE disconnect releasing a
// subscription) which no fake clock can drive. Rethrows the last
// assertion failure on timeout so the diagnostic points at the real
// expectation, not a generic "timed out".
export const pollUntil = async (
  assertion: () => void | Promise<void>,
  options?: { readonly timeoutMs?: number; readonly intervalMs?: number },
): Promise<void> => {
  const timeoutMs = options?.timeoutMs ?? 1_000;
  const intervalMs = options?.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) throw lastError;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, intervalMs);
      });
    }
  }
};
