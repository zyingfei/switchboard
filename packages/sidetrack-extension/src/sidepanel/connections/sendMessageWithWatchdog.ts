// Defensive wrapper around chrome.runtime.sendMessage for side-panel
// action buttons whose "busy" state is cleared in the response callback.
//
// The reported failure: clicking "Delete text" on the current-tab card
// spun forever with no error. Root cause was an unbounded fetch in the
// background handler (a busy companion never responded, so the SW's
// handleRequest promise never settled and sendResponse was never called
// → this callback never fired → busy stuck ON). The companion client is
// now bounded (see pageContentClient.fetchWithTimeout), but the panel
// must ALSO be able to settle on its own so no future never-settling path
// can strand a button in the busy state again.
//
// This wrapper guarantees the completion handler runs EXACTLY ONCE, with
// EITHER the real response, a chrome.runtime.lastError, a synchronous
// throw from sendMessage, OR a client-side watchdog timeout — whichever
// comes first. Every caller therefore has a single place that always
// clears busy and surfaces a message; there is no path that leaves the
// button spinning silently.

export interface SendMessageOutcome {
  /** The response value (undefined when settled by watchdog/throw). */
  readonly response: unknown;
  /** A user-facing error message, or null on success. */
  readonly error: string | null;
}

// Default client-side ceiling. Comfortably longer than the background
// client's own per-request budget so, in the normal case, the real
// response (success OR a companion-error message) always wins the race;
// the watchdog only fires when the message channel itself never delivers.
const DEFAULT_WATCHDOG_MS = 20_000;

export const sendMessageWithWatchdog = (
  message: unknown,
  onSettle: (outcome: SendMessageOutcome) => void,
  options: {
    readonly watchdogMs?: number;
    readonly timeoutMessage?: string;
    // Injectable for tests; defaults to the real chrome runtime.
    readonly runtime?: {
      sendMessage: (message: unknown, callback: (response: unknown) => void) => void;
      readonly lastError?: { readonly message?: string } | undefined;
    };
    readonly setTimeoutFn?: typeof setTimeout;
    readonly clearTimeoutFn?: typeof clearTimeout;
  } = {},
): void => {
  const runtime: NonNullable<(typeof options)['runtime']> =
    options.runtime ?? chrome.runtime;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const timeoutMessage =
    options.timeoutMessage ?? 'The companion did not respond in time. Try again.';

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const settle = (outcome: SendMessageOutcome): void => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeoutFn(timer);
    onSettle(outcome);
  };

  timer = setTimeoutFn(() => {
    settle({ response: undefined, error: timeoutMessage });
  }, watchdogMs);

  try {
    runtime.sendMessage(message, (response: unknown) => {
      const lastError = runtime.lastError;
      if (lastError !== undefined) {
        settle({ response: undefined, error: lastError.message ?? 'Operation failed.' });
        return;
      }
      settle({ response, error: null });
    });
  } catch (error) {
    // sendMessage can throw synchronously (e.g. extension context
    // invalidated on reload). Settle immediately so busy never sticks.
    settle({
      response: undefined,
      error: error instanceof Error ? error.message : 'Operation failed.',
    });
  }
};
