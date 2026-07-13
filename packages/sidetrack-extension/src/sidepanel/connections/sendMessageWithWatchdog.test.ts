import { describe, expect, it, vi } from 'vitest';

import { sendMessageWithWatchdog } from './sendMessageWithWatchdog';

// The invariant these tests pin down: whatever happens to the message,
// onSettle runs EXACTLY ONCE. Every side-panel action button clears its
// busy state inside onSettle, so "settles exactly once" == "busy never
// gets stuck ON" — the reported "Delete text spins forever" failure.

const fakeRuntime = (
  behavior:
    | { readonly kind: 'respond'; readonly response: unknown }
    | { readonly kind: 'lastError'; readonly message: string }
    | { readonly kind: 'never' }
    | { readonly kind: 'throw'; readonly message: string },
): {
  sendMessage: (message: unknown, callback: (response: unknown) => void) => void;
  lastError?: { readonly message?: string } | undefined;
} => {
  const runtime: {
    sendMessage: (message: unknown, callback: (response: unknown) => void) => void;
    lastError?: { readonly message?: string } | undefined;
  } = {
    sendMessage: (_message, callback) => {
      if (behavior.kind === 'respond') {
        callback(behavior.response);
      } else if (behavior.kind === 'lastError') {
        runtime.lastError = { message: behavior.message };
        callback(undefined);
      } else if (behavior.kind === 'throw') {
        throw new Error(behavior.message);
      }
      // 'never' — callback intentionally not invoked (the hang scenario).
    },
  };
  return runtime;
};

describe('sendMessageWithWatchdog — busy always settles', () => {
  it('settles with the response on success', () => {
    const onSettle = vi.fn();
    sendMessageWithWatchdog({ type: 'x' }, onSettle, {
      runtime: fakeRuntime({ kind: 'respond', response: { ok: true } }),
    });
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith({ response: { ok: true }, error: null });
  });

  it('settles with the lastError message (message channel closed)', () => {
    const onSettle = vi.fn();
    sendMessageWithWatchdog({ type: 'x' }, onSettle, {
      runtime: fakeRuntime({ kind: 'lastError', message: 'The message port closed.' }),
    });
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle.mock.calls[0]?.[0]).toEqual({
      response: undefined,
      error: 'The message port closed.',
    });
  });

  it('settles with an error when sendMessage throws synchronously (context invalidated)', () => {
    const onSettle = vi.fn();
    sendMessageWithWatchdog({ type: 'x' }, onSettle, {
      runtime: fakeRuntime({ kind: 'throw', message: 'Extension context invalidated.' }),
    });
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle.mock.calls[0]?.[0].error).toBe('Extension context invalidated.');
  });

  it('THE ROOT-CAUSE CASE: settles via the watchdog when the callback NEVER fires', () => {
    vi.useFakeTimers();
    try {
      const onSettle = vi.fn();
      sendMessageWithWatchdog({ type: 'sidetrack.pageContent.delete' }, onSettle, {
        runtime: fakeRuntime({ kind: 'never' }),
        watchdogMs: 1_000,
        timeoutMessage: 'busy — try again',
      });
      // Before the watchdog: still pending (busy would still be ON).
      expect(onSettle).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      // After the watchdog: settled with an error → busy clears + message shows.
      expect(onSettle).toHaveBeenCalledTimes(1);
      expect(onSettle.mock.calls[0]?.[0]).toEqual({
        response: undefined,
        error: 'busy — try again',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never double-settles: a late callback after the watchdog is ignored', () => {
    vi.useFakeTimers();
    try {
      // Holder object defeats TS control-flow narrowing (a bare `let`
      // assigned only inside the callback narrows to `never` at the fire
      // site below).
      const held: { cb: ((response: unknown) => void) | null } = { cb: null };
      const runtime = {
        sendMessage: (_message: unknown, callback: (response: unknown) => void) => {
          held.cb = callback; // hold it; fire it AFTER the watchdog
        },
        lastError: undefined as { readonly message?: string } | undefined,
      };
      const onSettle = vi.fn();
      sendMessageWithWatchdog({ type: 'x' }, onSettle, { runtime, watchdogMs: 500 });
      vi.advanceTimersByTime(500);
      expect(onSettle).toHaveBeenCalledTimes(1); // watchdog fired
      // Companion answers late — must NOT settle a second time.
      held.cb?.({ ok: true });
      expect(onSettle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the watchdog timer once the real response wins the race', () => {
    const clearTimeoutFn = vi.fn();
    const setTimeoutFn = vi.fn(() => 42);
    const onSettle = vi.fn();
    sendMessageWithWatchdog({ type: 'x' }, onSettle, {
      runtime: fakeRuntime({ kind: 'respond', response: { ok: true } }),
      setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
      clearTimeoutFn: clearTimeoutFn as unknown as typeof clearTimeout,
    });
    expect(clearTimeoutFn).toHaveBeenCalledWith(42);
  });
});
