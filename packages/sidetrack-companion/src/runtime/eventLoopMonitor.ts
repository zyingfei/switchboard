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

export const startEventLoopMonitor = (
  options: EventLoopMonitorOptions = {},
): EventLoopMonitor => {
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
  // entire tick window, track that — but collapse consecutive busy
  // windows into one "busy started" + one "busy ended" log pair so a
  // 60-second pinned phase doesn't produce 600 lines of repetition.
  const tickMs = Math.max(resolutionMs * 5, 100);
  // Throttled `[api.busy]` reporter state. Logging every 100 ms during
  // a sustained-busy phase produced ~600 lines per minute of
  // repetition that drowned out the actual signal in /tmp/runtime.log.
  // Instead: log once when the busy window opens, once when it closes
  // (with cumulative stats), and one periodic heartbeat every 5 s
  // while sustained-busy is still active so operators know it's still
  // pinned without flooding.
  const busyHeartbeatMs = 5_000;
  let busyOpenAtMs: number | null = null;
  let busyOpenStallStartUtil = 0;
  let busyCumulativeActiveMs = 0;
  let busyLastHeartbeatAtMs = 0;
  let busyMaxUtilization = 0;
  let busyTickCount = 0;
  const closeBusyWindow = (): void => {
    if (busyOpenAtMs === null) return;
    const durationMs = Date.now() - busyOpenAtMs;
    log(
      `[api.busy.end] durationMs=${String(durationMs)} maxUtilization=${busyMaxUtilization.toFixed(3)} cumulativeActiveMs=${String(Math.round(busyCumulativeActiveMs))} ticks=${String(busyTickCount)}`,
    );
    busyOpenAtMs = null;
    busyOpenStallStartUtil = 0;
    busyCumulativeActiveMs = 0;
    busyMaxUtilization = 0;
    busyTickCount = 0;
  };
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
      const now = Date.now();
      if (busyOpenAtMs === null) {
        busyOpenAtMs = now;
        busyLastHeartbeatAtMs = now;
        busyOpenStallStartUtil = elu.utilization;
        busyCumulativeActiveMs = 0;
        busyMaxUtilization = elu.utilization;
        busyTickCount = 0;
        // Count this window's lifetime once at open, not per tick.
        busyWindowCount += 1;
        log(
          `[api.busy.start] utilization=${elu.utilization.toFixed(3)} threshold=${String(sustainedUtilizationThreshold)} note=main thread sustained-busy; HTTP accept queue likely stalling`,
        );
      }
      busyCumulativeActiveMs += elu.active;
      busyMaxUtilization = Math.max(busyMaxUtilization, elu.utilization);
      busyTickCount += 1;
      if (now - busyLastHeartbeatAtMs >= busyHeartbeatMs) {
        busyLastHeartbeatAtMs = now;
        log(
          `[api.busy.tick] elapsedMs=${String(now - busyOpenAtMs)} maxUtilization=${busyMaxUtilization.toFixed(3)} cumulativeActiveMs=${String(Math.round(busyCumulativeActiveMs))} ticks=${String(busyTickCount)} note=still busy`,
        );
      }
      // Silence the unused-binding lint without shipping reflection
      // code into the hot path.
      void busyOpenStallStartUtil;
    } else if (busyOpenAtMs !== null) {
      closeBusyWindow();
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
