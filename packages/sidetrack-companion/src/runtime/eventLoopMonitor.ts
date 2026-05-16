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

import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'node:perf_hooks';

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
      log(
        `[api.stall] eventLoopBlockedMs=${String(lastStallMs)} thresholdMs=${String(warnThresholdMs)} resolutionMs=${String(resolutionMs)} note=single-tick max blocked time`,
      );
    }
    const elu = performance.eventLoopUtilization(utilizationBaseline);
    utilizationBaseline = performance.eventLoopUtilization();
    if (elu.utilization >= sustainedUtilizationThreshold) {
      lastBusyWindowAt = new Date().toISOString();
      busyWindowCount += 1;
      log(
        `[api.busy] utilization=${elu.utilization.toFixed(3)} windowMs=${String(Math.round(elu.idle + elu.active))} activeMs=${String(Math.round(elu.active))} idleMs=${String(Math.round(elu.idle))} note=main thread near-100% busy; HTTP accept queue likely stalling`,
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
