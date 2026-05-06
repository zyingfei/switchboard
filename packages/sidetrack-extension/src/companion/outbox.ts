// Generic outbox for browser → companion writes that must keep the
// extension working when the companion is offline.
//
// Each item is wrapped with `{id, queuedAt, attempts, nextAttemptAt,
// payload}`. The `id` is a fresh UUID, suitable for use as an
// `Idempotency-Key` header on retries. The drain caller receives the
// full wrapper so it can forward the id; the underlying payload type
// stays under the caller's control.

export interface OutboxItem<TPayload> {
  readonly id: string;
  readonly queuedAt: string;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly payload: TPayload;
}

export interface OutboxStorage {
  readonly get: <TValue>(key: string, fallback: TValue) => Promise<TValue>;
  readonly set: (values: Record<string, unknown>) => Promise<void>;
}

export interface DrainOptions {
  // Ignore each item's backoff timer. Use on user-initiated reconnect
  // paths where we have a fresh positive signal that the companion
  // is up; failures still re-arm the backoff for the next pass.
  readonly ignoreBackoff?: boolean;
}

export interface DrainResult {
  readonly sent: number;
  readonly remaining: number;
}

export type OverflowPolicy =
  // For telemetry-style payloads (capture queue): silently evict the
  // oldest item when the cap is reached. Old data is acceptable to
  // lose.
  | { readonly kind: 'drop-oldest' }
  // For user-authored payloads (review drafts): refuse the new write
  // and surface the failure to the caller. The cap should be sized
  // generously so this only triggers in pathological cases. NEVER
  // silently lose user-authored work.
  | { readonly kind: 'reject-when-full' };

// What to do with an item that has exhausted its retry budget. The
// drain loop applies one of these per outbox.
export type RetryExhaustionPolicy =
  // Drop the item silently and bump the dropped counter. Right for
  // capture telemetry — the next capture has the same data.
  | { readonly kind: 'drop' }
  // Keep the item queued forever, capping the per-item attempts at
  // the configured `maxAttempts` to throttle backoff but never
  // discarding. Right for user-authored content — losing a comment
  // because the network was down for a week is unacceptable.
  | { readonly kind: 'retain' };

export class OutboxFullError extends Error {
  constructor(
    readonly storageKey: string,
    readonly capacity: number,
  ) {
    super(
      `Outbox '${storageKey}' is at capacity (${String(capacity)}). ` +
        'Drain it before enqueueing more events.',
    );
  }
}

export interface OutboxConfig<TPayload> {
  readonly storageKey: string;
  readonly droppedKey: string;
  readonly migrate: (raw: unknown) => OutboxItem<TPayload> | null;
  readonly defaultStorage?: OutboxStorage;
  readonly defaultLimit?: number;
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly jitterRatio?: number;
  readonly overflowPolicy?: OverflowPolicy;
  readonly retryExhaustionPolicy?: RetryExhaustionPolicy;
}

export interface Outbox<TPayload> {
  readonly enqueue: (
    payload: TPayload,
    storage?: OutboxStorage,
    limit?: number,
  ) => Promise<{ readonly queue: readonly OutboxItem<TPayload>[]; readonly evicted: number }>;
  readonly drain: (
    send: (item: OutboxItem<TPayload>) => Promise<void>,
    storage?: OutboxStorage,
    now?: Date,
    random?: () => number,
    opts?: DrainOptions,
  ) => Promise<DrainResult>;
  readonly read: (storage?: OutboxStorage) => Promise<readonly OutboxItem<TPayload>[]>;
  readonly readDropped: (storage?: OutboxStorage) => Promise<number>;
  readonly clear: (storage?: OutboxStorage) => Promise<void>;
  readonly computeNextAttempt: (attempts: number, now: Date, random?: () => number) => string;
}

export const chromeStoragePort: OutboxStorage = {
  async get(key, fallback) {
    const result = await chrome.storage.local.get({ [key]: fallback });
    return result[key] as typeof fallback;
  },
  async set(values) {
    await chrome.storage.local.set(values);
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// Generic shape migration shared by every outbox. Concrete migrations
// stack their payload-shape check on top of this — see `queue.ts`.
export const baseOutboxItemShape = (
  value: unknown,
): { id: string; queuedAt: string; attempts: number; nextAttemptAt: string; payload: unknown } | null => {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.queuedAt !== 'string') {
    return null;
  }
  // Legacy entries stored the payload under `event`; new entries use
  // `payload`. Accept either so older queues survive an extension
  // upgrade without the migration silently dropping their work.
  const payload =
    'payload' in value ? value.payload : 'event' in value ? value.event : undefined;
  if (payload === undefined) {
    return null;
  }
  const attempts =
    typeof value.attempts === 'number' && Number.isFinite(value.attempts)
      ? Math.max(0, Math.floor(value.attempts))
      : 0;
  const nextAttemptAt =
    typeof value.nextAttemptAt === 'string' && value.nextAttemptAt.length > 0
      ? value.nextAttemptAt
      : value.queuedAt;
  return { id: value.id, queuedAt: value.queuedAt, attempts, nextAttemptAt, payload };
};

export const createOutbox = <TPayload>(config: OutboxConfig<TPayload>): Outbox<TPayload> => {
  const limit = config.defaultLimit ?? 1_000;
  const maxAttempts = config.maxAttempts ?? 12;
  const baseBackoffMs = config.baseBackoffMs ?? 2_000;
  const maxBackoffMs = config.maxBackoffMs ?? 5 * 60 * 1_000;
  const jitterRatio = config.jitterRatio ?? 0.25;
  const defaultStorage = config.defaultStorage ?? chromeStoragePort;

  const computeNextAttempt = (
    attempts: number,
    now: Date,
    random: () => number = Math.random,
  ): string => {
    const clamped = Math.max(0, Math.floor(attempts));
    const exponential = baseBackoffMs * 2 ** Math.max(0, clamped - 1);
    const capped = Math.min(exponential, maxBackoffMs);
    const jitter = 1 + (random() * 2 - 1) * jitterRatio;
    return new Date(now.getTime() + Math.round(capped * jitter)).toISOString();
  };

  const read = async (
    storage: OutboxStorage = defaultStorage,
  ): Promise<readonly OutboxItem<TPayload>[]> => {
    const raw = await storage.get<readonly unknown[]>(config.storageKey, []);
    return raw
      .map((entry) => config.migrate(entry))
      .filter((entry): entry is OutboxItem<TPayload> => entry !== null);
  };

  const readDropped = async (storage: OutboxStorage = defaultStorage): Promise<number> =>
    await storage.get<number>(config.droppedKey, 0);

  const clear = async (storage: OutboxStorage = defaultStorage): Promise<void> => {
    await storage.set({ [config.storageKey]: [] });
  };

  const overflowPolicy = config.overflowPolicy ?? { kind: 'drop-oldest' };
  const retryExhaustionPolicy = config.retryExhaustionPolicy ?? { kind: 'drop' };

  const enqueue = async (
    payload: TPayload,
    storage: OutboxStorage = defaultStorage,
    overrideLimit: number = limit,
  ): Promise<{ readonly queue: readonly OutboxItem<TPayload>[]; readonly evicted: number }> => {
    const current = await read(storage);
    if (current.length >= overrideLimit && overflowPolicy.kind === 'reject-when-full') {
      throw new OutboxFullError(config.storageKey, overrideLimit);
    }
    const queuedAt = new Date().toISOString();
    const next: OutboxItem<TPayload>[] = [
      ...current,
      {
        id: crypto.randomUUID(),
        queuedAt,
        attempts: 0,
        nextAttemptAt: queuedAt,
        payload,
      },
    ];
    const evicted =
      overflowPolicy.kind === 'drop-oldest' ? Math.max(0, next.length - overrideLimit) : 0;
    const kept = evicted > 0 ? next.slice(evicted) : next;
    if (evicted > 0) {
      await storage.set({ [config.droppedKey]: (await readDropped(storage)) + evicted });
    }
    await storage.set({ [config.storageKey]: kept });
    return { queue: kept, evicted };
  };

  const drain = async (
    send: (item: OutboxItem<TPayload>) => Promise<void>,
    storage: OutboxStorage = defaultStorage,
    now: Date = new Date(),
    random: () => number = Math.random,
    opts: DrainOptions = {},
  ): Promise<DrainResult> => {
    const queue = await read(storage);
    let sent = 0;
    let dropped = 0;
    let changed = false;
    const nextQueue: OutboxItem<TPayload>[] = [];

    for (const item of queue) {
      if (opts.ignoreBackoff !== true && Date.parse(item.nextAttemptAt) > now.getTime()) {
        nextQueue.push(item);
        continue;
      }
      try {
        await send(item);
        sent += 1;
        changed = true;
      } catch {
        const attempts = item.attempts + 1;
        changed = true;
        if (attempts > maxAttempts) {
          if (retryExhaustionPolicy.kind === 'drop') {
            dropped += 1;
          } else {
            // 'retain': cap attempts at maxAttempts so backoff stays
            // bounded (computeNextAttempt clamps to maxBackoffMs at
            // that point) but the item stays queued forever — losing
            // user-authored content because the network was down for
            // a week is not acceptable. UI surfaces it as "n unsynced
            // (last error …)".
            nextQueue.push({
              ...item,
              attempts: maxAttempts,
              nextAttemptAt: computeNextAttempt(maxAttempts, now, random),
            });
          }
        } else {
          nextQueue.push({
            ...item,
            attempts,
            nextAttemptAt: computeNextAttempt(attempts, now, random),
          });
        }
      }
    }

    if (dropped > 0) {
      await storage.set({ [config.droppedKey]: (await readDropped(storage)) + dropped });
    }
    if (changed) {
      await storage.set({ [config.storageKey]: nextQueue });
    }
    return { sent, remaining: nextQueue.length };
  };

  return {
    enqueue,
    drain,
    read,
    readDropped,
    clear,
    computeNextAttempt,
  };
};
