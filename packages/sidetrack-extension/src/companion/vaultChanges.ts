// SSE consumer for the companion's `/v1/vault/changes` stream.
//
// Browsers attached to the companion observe vault writes via this
// stream and route per-event callbacks to subscribers that register a
// `relPathPrefix`. The first subscriber opens the connection; the
// last unsubscribe closes it. Reconnect uses bounded exponential
// backoff. On every successful reconnect each subscriber's optional
// `onReconcile` hook fires with the last seen event timestamp, so
// projections that missed events while the connection was down can
// catch up via a since-style read.

export interface VaultChangeEvent {
  readonly type: 'created' | 'modified' | 'deleted';
  readonly relPath: string;
  readonly at: string;
}

export interface VaultChangesSubscription {
  readonly prefix: string;
  readonly onEvent: (event: VaultChangeEvent) => void;
  // Called whenever the connection (re)opens, with the last known
  // event timestamp the subscriber has seen via `onEvent`. Returning
  // a promise lets the subscriber back-fill state from the companion
  // before further events arrive — the client doesn't await it.
  readonly onReconcile?: (since: string | null) => Promise<void> | void;
}

export type VaultChangesStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

export interface VaultChangesClient {
  readonly subscribe: (sub: VaultChangesSubscription) => () => void;
  readonly status: () => VaultChangesStatus;
  readonly stop: () => Promise<void>;
}

export interface VaultChangesOptions {
  readonly resolveCompanion: () =>
    | { readonly url: string; readonly bridgeKey: string }
    | null
    | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly random?: () => number;
}

const DEFAULT_MIN_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

const isVaultChangeEvent = (value: unknown): value is VaultChangeEvent => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.relPath !== 'string') return false;
  if (typeof entry.at !== 'string') return false;
  if (entry.type !== 'created' && entry.type !== 'modified' && entry.type !== 'deleted') {
    return false;
  }
  return true;
};

const parseEventBlock = (block: string): VaultChangeEvent | null => {
  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join('\n')) as unknown;
    return isVaultChangeEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// Read SSE frames off a fetch ReadableStream, yielding parsed events.
// Comment lines (starting with `:`) and unknown frame types are
// skipped silently — the server's heartbeat is one of these.
export async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<VaultChangeEvent, void, void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const event = parseEventBlock(block);
      if (event !== null) {
        yield event;
      }
      separator = buffer.indexOf('\n\n');
    }
  }
}

export const createVaultChangesClient = (options: VaultChangesOptions): VaultChangesClient => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const minBackoffMs = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const random = options.random ?? Math.random;

  const subscribers = new Set<VaultChangesSubscription>();
  let status: VaultChangesStatus = 'idle';
  let abort: AbortController | null = null;
  let stopRequested = false;
  let consecutiveFailures = 0;
  let lastKnownAt: string | null = null;
  let runner: Promise<void> | null = null;

  const setStatus = (next: VaultChangesStatus): void => {
    status = next;
  };

  const dispatch = (event: VaultChangeEvent): void => {
    if (event.at > (lastKnownAt ?? '')) {
      lastKnownAt = event.at;
    }
    for (const sub of subscribers) {
      if (event.relPath.startsWith(sub.prefix)) {
        try {
          sub.onEvent(event);
        } catch {
          // Subscriber errors must not crash the dispatcher; the
          // subscriber is responsible for its own observability.
        }
      }
    }
  };

  const reconcileAll = (): void => {
    for (const sub of subscribers) {
      try {
        const result = sub.onReconcile?.(lastKnownAt);
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => undefined);
        }
      } catch {
        // Same: don't let one subscriber's reconcile failure stall
        // the others.
      }
    }
  };

  const computeBackoff = (): number => {
    const exponential = minBackoffMs * 2 ** Math.max(0, consecutiveFailures - 1);
    const capped = Math.min(exponential, maxBackoffMs);
    const jitter = 1 + (random() * 2 - 1) * 0.25;
    return Math.round(capped * jitter);
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const connectOnce = async (): Promise<void> => {
    const config = options.resolveCompanion();
    if (config === null || config === undefined || config.url.length === 0) {
      throw new Error('Companion is not configured.');
    }
    abort = new AbortController();
    setStatus('connecting');
    const response = await fetchImpl(`${config.url.replace(/\/$/, '')}/v1/vault/changes`, {
      headers: {
        accept: 'text/event-stream',
        'x-bac-bridge-key': config.bridgeKey,
      },
      signal: abort.signal,
    });
    if (!response.ok) {
      throw new Error(`Vault changes request failed: ${String(response.status)}`);
    }
    if (response.body === null) {
      throw new Error('Vault changes response had no body.');
    }
    setStatus('connected');
    consecutiveFailures = 0;
    reconcileAll();
    const reader = response.body.getReader();
    const onAbort = (): void => {
      void reader.cancel().catch(() => undefined);
    };
    abort.signal.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const event of parseSseStream(reader)) {
        dispatch(event);
      }
    } finally {
      abort.signal.removeEventListener('abort', onAbort);
      try {
        await reader.cancel();
      } catch {
        // The reader may already be closed when the connection drops
        // — cancel() can throw in that case; ignore.
      }
    }
  };

  const run = async (): Promise<void> => {
    while (!stopRequested && subscribers.size > 0) {
      try {
        await connectOnce();
      } catch (error) {
        // stopRequested may have flipped while connectOnce was
        // pending; the next while-iteration check will exit cleanly,
        // so we just sleep + continue here.
        consecutiveFailures += 1;
        setStatus(consecutiveFailures > 1 ? 'reconnecting' : 'error');
        await sleep(computeBackoff());
        if (
          error instanceof Error &&
          error.message === 'Companion is not configured.'
        ) {
          // Keep retrying — settings may arrive at any time. The
          // backoff already applied so the loop doesn't busy-spin.
          continue;
        }
        continue;
      }
      // Connection closed cleanly (server shut the stream); loop
      // back and reconnect unless stop was requested.
      if (subscribers.size > 0) {
        consecutiveFailures += 1;
        setStatus('reconnecting');
        await sleep(computeBackoff());
      }
    }
    setStatus('idle');
    abort = null;
    runner = null;
  };

  const ensureRunning = (): void => {
    if (runner !== null) return;
    stopRequested = false;
    runner = run();
  };

  const subscribe = (sub: VaultChangesSubscription): (() => void) => {
    subscribers.add(sub);
    ensureRunning();
    return () => {
      subscribers.delete(sub);
      if (subscribers.size === 0) {
        void stop();
      }
    };
  };

  const stop = async (): Promise<void> => {
    stopRequested = true;
    abort?.abort();
    if (runner !== null) {
      await runner;
    }
    setStatus('idle');
  };

  return {
    subscribe,
    status: () => status,
    stop,
  };
};
