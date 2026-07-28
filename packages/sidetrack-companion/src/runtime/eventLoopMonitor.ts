// Event-loop stall monitor.
//
// Wraps `perf_hooks.monitorEventLoopDelay` + `eventLoopUtilization()`
// and exposes a synchronous snapshot suitable for /v1/status. The
// goal is to make "the API didn't respond" diagnosable from a single
// JSON read: if `loop.lastStallMs > 1000` after a /v1/status call
// finally lands, the user/operator can prove the main thread was
// pinned by some sync CPU work — even when no log line was emitted.
//
// Stall accounting is approximate: monitorEventLoopDelay samples the
// delay between scheduled tick fires. A 500 ms blocked CPU phase
// becomes a 500 ms-ish max sample. We persist the max-since-last-
// read and clear on read so a long-tail spike isn't masked by the
// next non-blocked window's stats.
//
// The logged lines carry `inflight=` — the route patterns still running
// when the stall/busy window was noticed (see inflightRegistry.ts). The
// magnitude alone was never actionable: it proved the thread was pinned
// but not by what, so the answer always had to be re-derived from the
// SIDETRACK_HTTP_LOG timings by hand.

import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';

// Self-attribution for the stall/busy lines. Imported DIRECTLY (not injected)
// because inflightRegistry has zero imports of its own — there is no cycle to
// create — and because a diagnostic that has to be wired up is a diagnostic
// that will be missing on the box where it is needed.
import { formatInflightForLog } from './inflightRegistry.js';

export interface EventLoopSnapshot {
  /** Sampling resolution in ms (=histogram resolution). */
  readonly resolutionMs: number;
  /** Max recorded delay since the last `snapshot()` call, in ms. */
  readonly maxRecentStallMs: number;
  /** Wall-clock timestamp of the last stall >= warnThresholdMs. */
  readonly lastStallAt?: string;
  /** Magnitude of the last stall >= warnThresholdMs, in ms. */
  readonly lastStallMs?: number;
  /** Lifetime stall count (>= warnThresholdMs). */
  readonly stallCount: number;
  /** Wall-clock timestamp of the most recent sustained-busy window. */
  readonly lastBusyWindowAt?: string;
  /** Lifetime count of sustained-busy windows (utilization above threshold). */
  readonly busyWindowCount: number;
  /** P50 of all-time samples, in ms. */
  readonly p50Ms: number;
  /** P99 of all-time samples, in ms. */
  readonly p99Ms: number;
  /** Fraction of time the loop was busy [0, 1]. */
  readonly utilization: number;
}

export interface EventLoopMonitor {
  readonly snapshot: () => EventLoopSnapshot;
  readonly stop: () => void;
}

export interface EventLoopMonitorOptions {
  /** Sampling resolution. Smaller = finer measurement, more overhead. */
  readonly resolutionMs?: number;
  /** Threshold above which a sample counts as a stall (logged + tracked). */
  readonly warnThresholdMs?: number;
  /** Utilization above which a tick window is logged as `[api.busy]`. */
  readonly sustainedUtilizationThreshold?: number;
  /** Logger hook — defaults to a one-line `console.warn`. */
  readonly logger?: (line: string) => void;
}

export const startEventLoopMonitor = (options: EventLoopMonitorOptions = {}): EventLoopMonitor => {
  const resolutionMs = options.resolutionMs ?? 20;
  const warnThresholdMs = options.warnThresholdMs ?? 250;
  // Sustained-high utilization is the other failure mode: many sub-
  // 250 ms CPU ticks back to back. The single-tick max never trips
  // `warnThresholdMs` but the cumulative effect pins HTTP accepting
  // anyway. Flag a sustained-busy window when utilization stays above
  // this value over the previous tick interval.
  const sustainedUtilizationThreshold = options.sustainedUtilizationThreshold ?? 0.8;
  const log =
    options.logger ??
    ((line: string) => {
      console.warn(line);
    });

  const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();

  let lastStallAt: string | undefined;
  let lastStallMs: number | undefined;
  let stallCount = 0;
  let lastBusyWindowAt: string | undefined;
  let busyWindowCount = 0;
  let utilizationBaseline = performance.eventLoopUtilization();

  // Sampling tick: read the running max and clear so the next window
  // is a fresh measurement. Anything above warnThresholdMs becomes a
  // logged stall. Separately, if the loop ran near-100% busy for the
  // entire tick window, emit a `[api.busy]` line — that's what
  // produces a multi-second pile-up of small ticks that look fine
  // sample-by-sample but starve incoming HTTP connections.
  const tickMs = Math.max(resolutionMs * 5, 100);
  const interval = setInterval(() => {
    const maxNs = histogram.max;
    histogram.reset();
    const maxMs = maxNs / 1e6;
    if (maxMs >= warnThresholdMs) {
      lastStallAt = new Date().toISOString();
      lastStallMs = Math.round(maxMs);
      stallCount += 1;
      // WHICH ROUTE. Until this field existed the line named a magnitude and
      // nothing else, so every stall investigation started by guessing the
      // endpoint — and guessing has failed repeatedly here. `inflight=` lists
      // the three longest-running requests AT DETECTION TIME as
      // `<METHOD:/route/{pattern}>:<ageMs>ms`, pipe-separated, or `none`.
      //
      // Read it as a suspect list, not a proof: the histogram reports a stall
      // on the tick AFTER the block, so a handler that blocked and RETURNED
      // inside that tick is already gone and shows `none`. The case this is
      // built for is the opposite one — a multi-second route (batch-resolve)
      // that is still running while the watchdog fires, which is exactly the
      // stall shape the panel reports as a timeout.
      log(
        `[api.stall] eventLoopBlockedMs=${String(lastStallMs)} thresholdMs=${String(warnThresholdMs)} resolutionMs=${String(resolutionMs)} inflight=${formatInflightForLog(3)} note=single-tick max blocked time`,
      );
    }
    const elu = performance.eventLoopUtilization(utilizationBaseline);
    utilizationBaseline = performance.eventLoopUtilization();
    if (elu.utilization >= sustainedUtilizationThreshold) {
      lastBusyWindowAt = new Date().toISOString();
      busyWindowCount += 1;
      // Same attribution on the sustained-busy line. This is the failure mode
      // where NO single tick trips the stall threshold but the loop never
      // idles, so the suspect list is if anything more useful here: a route
      // that appears on consecutive busy windows is the convoy.
      log(
        `[api.busy] utilization=${elu.utilization.toFixed(3)} windowMs=${String(Math.round(elu.idle + elu.active))} activeMs=${String(Math.round(elu.active))} idleMs=${String(Math.round(elu.idle))} inflight=${formatInflightForLog(3)} note=main thread near-100% busy; HTTP accept queue likely stalling`,
      );
    }
  }, tickMs);
  interval.unref();

  // Track a rolling baseline so /v1/status can show p50/p99 even when
  // the histogram has been reset by the tick loop. We aggregate into a
  // separate persistent histogram that we never reset.
  const lifetime: IntervalHistogram = monitorEventLoopDelay({ resolution: resolutionMs });
  lifetime.enable();

  let lastUtilizationBase = performance.eventLoopUtilization();

  return {
    snapshot(): EventLoopSnapshot {
      // The recent window: histogram has been reset by the interval
      // tick, but during the gap since the last tick `max` accumulates
      // again. Read it without resetting so callers can chain reads.
      const maxRecentMs = histogram.max / 1e6;
      const current = performance.eventLoopUtilization(lastUtilizationBase);
      lastUtilizationBase = performance.eventLoopUtilization();
      const result: EventLoopSnapshot = {
        resolutionMs,
        maxRecentStallMs: Math.round(maxRecentMs),
        stallCount,
        busyWindowCount,
        p50Ms: Math.round(lifetime.percentile(50) / 1e6),
        p99Ms: Math.round(lifetime.percentile(99) / 1e6),
        utilization: Number(current.utilization.toFixed(4)),
        ...(lastStallAt === undefined ? {} : { lastStallAt }),
        ...(lastStallMs === undefined ? {} : { lastStallMs }),
        ...(lastBusyWindowAt === undefined ? {} : { lastBusyWindowAt }),
      };
      return result;
    },
    stop(): void {
      clearInterval(interval);
      histogram.disable();
      lifetime.disable();
    },
  };
};
