// Reverse-shadow deferral — get the incumbent-resolver re-run off the serve
// path (perf/resolver-subgraph-budget, 2026-08-16). Sibling of
// http/resolverCacheDefer.ts; read that module's header for the fuller
// "why deferral is safe" template this one follows.
//
// THE EVIDENCE. armedResolve.ts's reverse shadow (SIDETRACK_ATTRIBUTION_V1_SHADOW,
// default ON) reruns the FULL incumbent graph-resolver (PPR + similarity +
// cluster + fusion + policy) synchronously, once per miss URL, purely to
// record an agreement tally against the vote arm that actually serves.
// Measured ~223ms/URL on the batch-resolve route; for a batch of N miss URLs
// that is N * ~223ms of pure shadow overhead stacked onto the served work,
// entirely inside the request's own tick, on top of the traversal cost
// snapshot.ts's budgets (see there) already address.
//
// WHY DEFERRAL IS SAFE — this is the whole argument, so it is written out:
//   1. The reverse shadow's only observable effect is `recordArmShadow` — an
//      in-process O(1) counter increment (armShadow.ts). Nothing on the
//      served response path reads it back: it is a lifetime running total
//      surfaced through a drain-flushed vault-file gauge
//      (_BAC/system/attribution-arm-shadow.json), not a per-request field.
//      Moving WHEN it increments (later, off the request's tick) does not
//      change WHETHER it increments — every sample this queue accepts is
//      counted exactly once, just asynchronously.
//   2. The deferred compute's input, ResolveUrlAttributionInput, is a
//      snapshot carrying in-memory node/edge arrays plus a plain events
//      array — no live sqlite handle, no generation-swap risk. Unlike
//      resolverCacheDefer's writer, it needs no late-bound "resolve the live
//      store at flush time" indirection: it is safe to hold across an
//      arbitrary amount of wall clock as-is.
//   3. The latency canary (runtime/companion.ts) already passes
//      skipReverseShadow: true, so it never reaches armedResolve's shadow
//      branch and never enqueues here — its measured cost is unaffected
//      either way, matching the existing contract in armedResolve.ts's
//      module doc ("the health gauge reflects the shadow-free served cost").
//
// WHEN IT DRAINS. Mirrors resolverCacheDefer: the HTTP dispatch calls
// scheduleReverseShadowFlush() in its `finally`, i.e. AFTER the response has
// been written, so the deferred PPR run lands on a tick the client is no
// longer waiting on. The fallback timer exists only for "companion went idle
// with a queued shadow sample still pending" and re-arms while any request
// is in flight, so it can never reintroduce the cost we just removed.
//
// KILL SWITCH: this module has none of its own — SIDETRACK_ATTRIBUTION_V1_SHADOW=0
// already turns the whole reverse shadow off upstream (armedResolve.ts never
// calls queueReverseShadow when the flag is off), so there is nothing here to
// separately disable.

import { recordArmShadow } from './armShadow.js';
import { workstreamOf } from './serve.js';
import { resolveUrlAttribution, type ResolveUrlAttributionInput } from '../tabsession/resolver.js';
import { yieldToEventLoop } from '../runtime/eventLoopYield.js';
import { inflightCount } from '../runtime/inflightRegistry.js';

interface PendingShadow {
  readonly resolverInput: ResolveUrlAttributionInput;
  // The vote arm's own workstream (already computed, cheaply, by the caller
  // BEFORE enqueueing) — the deferred job only needs to compute the
  // INCUMBENT side and compare.
  readonly votedWorkstreamId: string | null;
}

/**
 * Cap on queued shadow samples. A batch is ~25 urls and drains on the next
 * response, so this is never approached in practice; it bounds memory for a
 * pathological producer (or a drain that never gets a turn) instead of
 * growing until the companion is OOM-killed. Overflow drops the NEW sample —
 * it only costs the agreement tally one missed data point, never a served
 * response.
 */
const MAX_PENDING = 1024;

/**
 * Safety-net delay. The primary drain is the dispatch `finally`; this only
 * catches "one last batch, then no traffic at all". Long enough that a
 * normally busy companion always drains via the response path first.
 */
const FALLBACK_FLUSH_MS = 2_000;

// FIFO queue, oldest first — order has no correctness meaning for an
// aggregate counter, but FIFO keeps the drain's yield cadence predictable.
const pending: PendingShadow[] = [];
let flushInFlight: Promise<void> | null = null;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
let droppedOverflow = 0;
let computeFailures = 0;

/**
 * Queue one reverse-shadow sample for after-the-response. Never throws,
 * never awaits, never runs the incumbent resolver on the caller's tick.
 */
export const queueReverseShadow = (
  resolverInput: ResolveUrlAttributionInput,
  votedWorkstreamId: string | null,
): void => {
  if (pending.length >= MAX_PENDING) {
    droppedOverflow += 1;
    return;
  }
  pending.push({ resolverInput, votedWorkstreamId });
  armFallbackFlush();
};

const armFallbackFlush = (): void => {
  if (fallbackTimer !== null) return;
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    if (pending.length === 0) return;
    // A request is running: re-arm rather than drain. The entire point of
    // this module is that the incumbent compute is not on a request's tick,
    // and a fallback that ignored that would quietly undo it.
    if (inflightCount() > 0) {
      armFallbackFlush();
      return;
    }
    void flushReverseShadows();
  }, FALLBACK_FLUSH_MS);
  // Never hold the process open for a best-effort shadow sample.
  fallbackTimer.unref?.();
};

/**
 * Ask for a drain. Call AFTER the response has been sent. Cheap no-op when
 * the queue is empty (the common case — the shadow flag off, or a batch with
 * zero misses), so the dispatch path can call it unconditionally.
 */
export const scheduleReverseShadowFlush = (): void => {
  if (pending.length === 0 || flushInFlight !== null) return;
  setImmediate(() => {
    void flushReverseShadows();
  });
};

const drainPendingShadows = async (): Promise<void> => {
  while (pending.length > 0) {
    const next = pending.shift();
    if (next === undefined) return;
    try {
      const incumbent = resolveUrlAttribution(next.resolverInput);
      recordArmShadow(workstreamOf(incumbent) === next.votedWorkstreamId);
    } catch (error) {
      // A failed shadow compute costs one missed sample, nothing more. It
      // must NEVER propagate: this runs detached from any request, so a
      // throw here would surface as an unhandled rejection and (under some
      // Bun versions) take the process with it — same discipline as
      // resolverCacheDefer's write-failure handling.
      computeFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[reverse-shadow] deferred compute failed: ${message}`);
    }
    // Between samples, not just between batches: N queued incumbent PPR runs
    // must not reassemble into the single long tick this module exists to
    // break up.
    if (pending.length > 0) await yieldToEventLoop();
  }
};

/**
 * Drain the queue now. Single-flight — a second caller joins the running
 * drain instead of starting a competing one. Awaited by tests and by
 * shutdown; production calls `scheduleReverseShadowFlush` instead.
 */
export const flushReverseShadows = async (): Promise<void> => {
  while (flushInFlight !== null) {
    await flushInFlight;
  }
  if (pending.length === 0) return;
  const run = drainPendingShadows();
  flushInFlight = run;
  try {
    await run;
  } finally {
    flushInFlight = null;
  }
};

/** Queue depth — for tests and for a future /v1/status field. */
export const pendingReverseShadowCount = (): number => pending.length;

/** Diagnostics: samples dropped on overflow and computes that threw. */
export const reverseShadowDeferStats = (): {
  readonly pending: number;
  readonly droppedOverflow: number;
  readonly computeFailures: number;
} => ({ pending: pending.length, droppedOverflow, computeFailures });

/** Test seam: module-level state is process-global, so tests must reset it. */
export const __resetReverseShadowDeferQueue = (): void => {
  pending.length = 0;
  flushInFlight = null;
  droppedOverflow = 0;
  computeFailures = 0;
  if (fallbackTimer !== null) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
};
