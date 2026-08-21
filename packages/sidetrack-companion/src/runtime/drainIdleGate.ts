// F9 — idle I/O floor (docs/plans/2026-08-15-foundation-program.md).
//
// ROOT CAUSE (measured — see the F9 landing note for the instrumented
// fixture): `BROWSER_TIMELINE_OBSERVED` (src/timeline/events.ts) is a
// `HANDLES`-classified, `urgent: true` event inside
// src/sync/contract/connectionsMaterializer.ts's `onAccepted` — every
// occurrence bypasses the 30s `DRAIN_MIN_INTERVAL_MS` floor entirely (the
// urgent path skips it, connectionsMaterializer.ts's
// `startDrainWhenIntervalElapsed`) and forces `progressOnlyDirty = false`,
// which rules out the cheap in-process `tryAdvanceNoGraphBacklog` path —
// so the drain falls to `shouldUseWorker()` and forks a full reconcile
// child (`SIDETRACK_CONNECTIONS_CHILD` defaults '1'). At idle, an open tab
// emits one `BROWSER_TIMELINE_OBSERVED` per ~30s dwell window even when
// nothing about the page has changed since the last observation — each one
// independently forks a child that opens the event-store + connections-
// generation databases and does a full reconcile pass for zero new graph
// content. `ENGAGEMENT_INTERVAL_OBSERVED` (src/engagement/events.ts) is
// already correctly routed through `CONTENT_LANE_ONLY_HANDLES` inside that
// file (a cheap in-process progress advance, never a fork) — it is
// included here anyway because deferring it also reduces the frequency of
// that cheap-but-nonzero progress-write path, and the task's own framing
// named it as a suspect; the measured win is dominated by
// BROWSER_TIMELINE_OBSERVED.
//
// FIX — this module, NOT a change to connectionsMaterializer.ts (off
// limits per the task's binding constraint; also the internal debounce
// there is a black box this gate does not need to understand to be
// correct). `createDrainIdleGate` wraps a `Materializer` and intercepts
// `onAccepted` BEFORE the wrapped materializer ever sees a "trickle" event:
// such events are buffered (never dropped) and released — replayed to the
// inner materializer's own `onAccepted`, in original order, so every
// incremental fold/invalidation-key/debounce-arm the materializer would
// normally do on arrival still happens, just later — the moment EITHER a
// non-trickle ("content-bearing") event arrives for the same materializer,
// or `SIDETRACK_DRAIN_IDLE_INTERVAL_MS` elapses since the first buffered
// event, whichever comes first. This satisfies the Materializer contract's
// own correctness rule #8 (materializer.ts): a missed/delayed in-memory
// notification is always recoverable via the materializer's own `catchUp`
// durable-state scan, so withholding the notification for a bounded window
// is not a "drop" — the deferred events are already durable in the event
// log the moment `EventLog.appendClient*` accepted them; this gate only
// delays the WAKE-UP signal telling the connections materializer to look.
//
// `handles` is passed through UNCHANGED (still the union including the
// trickle types) — the sync-contract runner (`runner.ts`) only calls
// `onAccepted` for a type in `handles`, so narrowing it would silently
// drop trickle events instead of deferring them.
//
// NOVELTY EXCEPTION — found by a real regression, not predicted up front.
// A blanket type-based defer of EVERY BROWSER_TIMELINE_OBSERVED breaks the
// documented freshness contract for the case that actually matters: the
// FIRST observation of a genuinely new page must still surface promptly
// (companion.test.ts's resolve-canary boot test seeds exactly one
// BROWSER_TIMELINE_OBSERVED and expects it to materialize a graph node
// within seconds — a real, load-bearing behavior, not incidental). The
// wasteful case this gate targets is specifically the REPEAT: the same
// open tab re-observed every ~30s with nothing new to report. `NoveltyKey`
// lets a caller supply a per-event key (e.g. canonicalUrl); the first
// occurrence of a key is always treated as content-bearing (forwarded
// immediately, exactly like today), and only REPEATS of an
// already-seen key are deferred. A type with no extractor (or an
// extractor returning undefined for a given event) is deferred
// unconditionally — this is `ENGAGEMENT_INTERVAL_OBSERVED`'s case: it
// never gated node materialization to begin with (already content-lane-
// only inside the protected file), so it has no novelty exception to
// preserve.

import type { AcceptedEvent } from '../sync/causal.js';
import type { AcceptedEventContext, Materializer } from '../sync/contract/materializer.js';

export const DRAIN_IDLE_GATE_ENV = 'SIDETRACK_DRAIN_IDLE_GATE';
export const DRAIN_IDLE_INTERVAL_MS_ENV = 'SIDETRACK_DRAIN_IDLE_INTERVAL_MS';

// Default matches the task brief: batch/defer trickle-only drains for up to
// 15 minutes of true idle before forcing a flush anyway, so a vault that
// never sees a content-bearing event still gets its graph refreshed on a
// bounded cadence rather than starving indefinitely.
export const DEFAULT_DRAIN_IDLE_INTERVAL_MS = 15 * 60_000;

export const DEFAULT_MAX_NOVELTY_KEYS = 20_000;

const parsePositiveInt = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
};

/** Absent/non-'0' = ON, matching this repo's established kill-switch
 *  convention (e.g. SIDETRACK_INPLACE_PUBLISH). `=0` reverts to today's
 *  behavior byte-for-byte: every event forwards to the inner materializer
 *  immediately, same as no gate existed. */
export const drainIdleGateEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[DRAIN_IDLE_GATE_ENV] !== '0';

export const resolveDrainIdleIntervalMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const parsed = parsePositiveInt(env[DRAIN_IDLE_INTERVAL_MS_ENV]);
  return parsed ?? DEFAULT_DRAIN_IDLE_INTERVAL_MS;
};

export interface DrainIdleGateOptions {
  /** Event types this gate withholds from the inner materializer's
   *  `onAccepted` until a flush. Any type NOT in this set is forwarded
   *  immediately (today's behavior), AND triggers an immediate flush of
   *  whatever is currently buffered first, so real activity always sees a
   *  fresh graph. */
  readonly trickleTypes: ReadonlySet<string>;
  /** See module header, "NOVELTY EXCEPTION". Optional: a trickle event
   *  whose key (per this function) has not been seen before by this gate
   *  is forwarded immediately instead of deferred, and its key is
   *  remembered. Returning undefined for a given event defers it
   *  unconditionally (same as omitting this option entirely). */
  readonly noveltyKeyForEvent?: (event: AcceptedEvent) => string | undefined;
  /** Upper bound on remembered novelty keys (oldest evicted first) — a
   *  bounded cache, not a full duplicate of the materializer's own durable
   *  "have I seen this URL" state. Default is generous for a single
   *  process lifetime's worth of distinct URLs while staying well clear of
   *  this repo's memory-ratchet scrutiny (~20k short strings is low
   *  single-digit MB). */
  readonly maxNoveltyKeys?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam — overrides setTimeout so fake timers can drive the flush
   *  without a real 15-minute wait. */
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}

export interface DrainIdleGate {
  readonly materializer: Materializer;
  /** Number of events currently buffered, withheld from the inner
   *  materializer. Test/diagnostic seam. */
  readonly pendingCount: () => number;
  /** Cancels the idle flush timer without flushing. Mirrors this repo's
   *  existing materializer teardown contract ("cancel scheduled work; an
   *  in-flight drain finishes, but no new pass fires afterwards") — any
   *  events still buffered at shutdown are already durable in the event
   *  log and are recovered by the inner materializer's own `catchUp` on
   *  next boot (contract rule #8), so teardown does not force a flush. */
  readonly teardown: () => void;
}

/** Wrap `inner` so trickle-classified events are batched instead of
 *  triggering the inner materializer's own per-event drain scheduling one
 *  at a time. See module header for the full rationale. */
export const createDrainIdleGate = (
  inner: Materializer,
  options: DrainIdleGateOptions,
): DrainIdleGate => {
  const env = options.env ?? process.env;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const maxNoveltyKeys = options.maxNoveltyKeys ?? DEFAULT_MAX_NOVELTY_KEYS;

  let buffer: ReadonlyArray<{ readonly event: AcceptedEvent; readonly ctx: AcceptedEventContext }> =
    [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const seenNoveltyKeys = new Set<string>();

  const rememberNoveltyKey = (key: string): void => {
    if (seenNoveltyKeys.has(key)) return;
    if (seenNoveltyKeys.size >= maxNoveltyKeys) {
      const oldest = seenNoveltyKeys.values().next().value;
      if (oldest !== undefined) seenNoveltyKeys.delete(oldest);
    }
    seenNoveltyKeys.add(key);
  };

  const clearFlushTimer = (): void => {
    if (flushTimer !== null) {
      clearTimeoutFn(flushTimer);
      flushTimer = null;
    }
  };

  const flush = (reason: 'idle-interval' | 'content-event'): void => {
    clearFlushTimer();
    if (buffer.length === 0) return;
    const events = buffer;
    buffer = [];
    console.warn(`[drain.flush] reason=${reason} events=${String(events.length)}`);
    for (const { event, ctx } of events) inner.onAccepted(event, ctx);
  };

  const armFlushTimer = (): void => {
    if (flushTimer !== null || disposed) return;
    flushTimer = setTimeoutFn(() => {
      flushTimer = null;
      flush('idle-interval');
    }, resolveDrainIdleIntervalMs(env));
    flushTimer.unref?.();
  };

  const onAccepted: Materializer['onAccepted'] = (event, ctx) => {
    if (disposed) {
      inner.onAccepted(event, ctx);
      return;
    }
    if (!drainIdleGateEnabled(env) || !options.trickleTypes.has(event.type)) {
      // Content-bearing (or gate disabled): flush anything buffered first
      // so ordering relative to this event is preserved, then forward.
      flush('content-event');
      inner.onAccepted(event, ctx);
      return;
    }
    const noveltyKey = options.noveltyKeyForEvent?.(event);
    if (noveltyKey !== undefined && !seenNoveltyKeys.has(noveltyKey)) {
      // First sighting of this key (e.g. a genuinely new URL) — treat like
      // any other content-bearing event so freshness is never worse than
      // today's behavior for the case that actually matters.
      rememberNoveltyKey(noveltyKey);
      flush('content-event');
      inner.onAccepted(event, ctx);
      return;
    }
    buffer = [...buffer, { event, ctx }];
    console.warn(
      `[drain.deferred] type=${event.type} pending=${String(buffer.length)} idleIntervalMs=${String(
        resolveDrainIdleIntervalMs(env),
      )}`,
    );
    armFlushTimer();
  };

  const materializer: Materializer = {
    name: inner.name,
    handles: inner.handles,
    onAccepted,
    catchUp: (eventLog) => inner.catchUp(eventLog),
    awaitIdle: () => inner.awaitIdle(),
    health: () => inner.health(),
  };

  return {
    materializer,
    pendingCount: () => buffer.length,
    teardown: () => {
      disposed = true;
      clearFlushTimer();
    },
  };
};
