// End-to-end resolve canary (DEBUGGING_DOCTRINE §1, standing debt list).
//
// Every reliability incident of 2026-07-21..24 was invisible until someone
// manually tailed SIDETRACK_HTTP_LOG: the single most user-felt metric —
// resolve latency (the panel's attribution / suggestions fill) — had no
// standing probe. This module is that probe. Once per interval it runs the
// SAME resolve core the panel's batch-resolve handler invokes internally
// (NOT an HTTP self-call — that would depend on the loopback socket, the
// auth gate, and the serial request queue, none of which are what we want
// to measure, and any of which would make the probe flaky) against a stable
// known URL from the served graph, timing it and folding the outcome into a
// rolling TIME-BOUNDED window.
//
// The window is the decay mechanism (DEBUGGING_DOCTRINE §7, round-3 health
// pattern): p50/p95/max are computed only over samples inside the window, so
// a burst of slow resolves flips the health status non-ok, and as fresh fast
// samples arrive and the slow ones age past the window the status returns to
// ok on its own — there is no latch to get permanently stuck.
//
// Boundary contract: this module owns NO I/O of its own. The runtime injects
// two ports —
//   - pickUrl():    resolve a stable canary URL from the served graph, or
//                   null for an empty vault (→ the canary stays idle, never
//                   records a synthetic sample).
//   - resolveOnce(url): run the panel's single-URL resolve core; resolves on
//                   success, rejects on failure. Duration is measured here.
// Both are provided by companion.ts (built from the same connectionsStore +
// resolveUrlAttribution the batch-resolve route uses). This keeps the timing
// logic pure and unit-testable with fake ports and a fake clock.
//
// Observability: a vaultRoot-keyed registry lets /v1/system/health read the
// running canary's snapshot without threading a new field through the HTTP
// config (mirrors the module-level systemHealthCache the same route already
// keeps). FREEZE-SAFE: observability only; no serving consumer reads it.

export interface ResolveCanarySample {
  // Epoch ms the resolve completed (used for window pruning).
  readonly atMs: number;
  // Wall-clock duration of the resolve core, ms.
  readonly durationMs: number;
  // False when resolveOnce rejected (an errored probe still records a
  // sample so a run of failures is visible as errorCount, not silence).
  readonly ok: boolean;
}

// The health-surfaced view. All latency fields are null when the window is
// empty (idle / empty vault) so the UI can distinguish "no probe yet" from
// "a real zero".
export interface ResolveCanarySnapshot {
  // Number of samples currently inside the window.
  readonly sampleCount: number;
  // Percentiles / max over the in-window sample durations, null when empty.
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
  // Count of failed (ok:false) samples currently inside the window.
  readonly errorCount: number;
  // Epoch ms of the most recent sample, or null when idle.
  readonly lastSampleAtMs: number | null;
  // The pinned canary URL, or null while the vault is empty / not yet
  // picked. Not the URL itself for privacy on the health surface — just
  // whether a probe target exists — see health assembly (it is not
  // serialized into the response body).
  readonly hasTarget: boolean;
}

const EMPTY_SNAPSHOT: ResolveCanarySnapshot = {
  sampleCount: 0,
  p50Ms: null,
  p95Ms: null,
  maxMs: null,
  errorCount: 0,
  lastSampleAtMs: null,
  hasTarget: false,
};

// Nearest-rank percentile over an ASCENDING-sorted array. p in [0,100].
// Self-contained so the module carries no cross-package dependency.
const percentileAsc = (sortedAsc: readonly number[], p: number): number => {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0] ?? 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index] ?? 0;
};

// Pure rolling window. Kept separate from the timer so the folding /
// pruning / percentile logic is unit-testable with no async at all.
export class ResolveCanaryWindow {
  readonly #windowMs: number;
  readonly #maxSamples: number;
  #samples: ResolveCanarySample[] = [];
  #hasTarget = false;

  constructor(options: { readonly windowMs: number; readonly maxSamples: number }) {
    this.#windowMs = Math.max(1, options.windowMs);
    this.#maxSamples = Math.max(1, options.maxSamples);
  }

  // Record whether a probe target currently exists (drives hasTarget on the
  // snapshot). Set false when the vault is empty so the surface can say
  // "canary idle" rather than implying a broken probe.
  setHasTarget(hasTarget: boolean): void {
    this.#hasTarget = hasTarget;
  }

  // Fold one sample and prune anything older than the window (and cap the
  // count so a pathological interval never grows the array unbounded —
  // DEBUGGING_DOCTRINE §8, every buffer is bounded).
  record(sample: ResolveCanarySample): void {
    this.#samples.push(sample);
    this.#prune(sample.atMs);
  }

  #prune(nowMs: number): void {
    const cutoff = nowMs - this.#windowMs;
    // Drop expired samples (kept in insertion order; timer records
    // monotonically so a simple filter from the front is enough).
    if (this.#samples.length > 0 && this.#samples[0]!.atMs < cutoff) {
      this.#samples = this.#samples.filter((s) => s.atMs >= cutoff);
    }
    if (this.#samples.length > this.#maxSamples) {
      this.#samples = this.#samples.slice(this.#samples.length - this.#maxSamples);
    }
  }

  // Compute the snapshot over the samples still inside the window as of
  // nowMs. Callers pass the clock so pruning is consistent with the caller's
  // notion of "now" (the health route and tests share one clock).
  snapshot(nowMs: number): ResolveCanarySnapshot {
    this.#prune(nowMs);
    if (this.#samples.length === 0) {
      return { ...EMPTY_SNAPSHOT, hasTarget: this.#hasTarget };
    }
    const durationsAsc = this.#samples.map((s) => s.durationMs).sort((a, b) => a - b);
    const errorCount = this.#samples.reduce((n, s) => (s.ok ? n : n + 1), 0);
    const lastSampleAtMs = this.#samples.reduce((max, s) => Math.max(max, s.atMs), 0);
    return {
      sampleCount: this.#samples.length,
      p50Ms: Math.round(percentileAsc(durationsAsc, 50)),
      p95Ms: Math.round(percentileAsc(durationsAsc, 95)),
      maxMs: durationsAsc[durationsAsc.length - 1] ?? null,
      errorCount,
      lastSampleAtMs,
      hasTarget: this.#hasTarget,
    };
  }
}

// The canary p95 threshold (ms) above which the health surface reports the
// reliability section non-ok. Default 5000ms — a resolve that routinely takes
// >5s is the exact user-felt "panel spins forever" symptom the incident week
// produced. Env-tunable. A failed probe (errorCount>0) is also non-ok
// regardless of latency (see resolveCanaryStatus).
export const resolveCanaryThresholdMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env['SIDETRACK_RESOLVE_CANARY_P95_THRESHOLD_MS'];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 5000;
};

// Health status for the resolve canary. `ok` when the window is idle (no
// probe target / no samples yet — absence of signal is not a failure), when
// the p95 is under the threshold AND no in-window probe failed. `degraded`
// when the p95 breaches the threshold or any in-window probe errored. The
// window pruning gives this its decay: once fresh fast samples arrive and the
// slow/errored ones age out, it returns to `ok` with no manual reset.
export const resolveCanaryStatus = (
  snapshot: ResolveCanarySnapshot,
  thresholdMs: number,
): 'ok' | 'degraded' => {
  if (snapshot.sampleCount === 0) return 'ok';
  if (snapshot.errorCount > 0) return 'degraded';
  if (snapshot.p95Ms !== null && snapshot.p95Ms > thresholdMs) return 'degraded';
  return 'ok';
};

export interface ResolveCanaryPorts {
  // Resolve a stable canary URL from the served graph. Returns null when the
  // vault has no candidate (empty vault) → the canary stays idle. Pinning is
  // the canary's job, not the port's: the port may re-pick each call, but the
  // canary caches the first non-null result to amortize the pick's cost.
  readonly pickUrl: () => Promise<string | null>;
  // Run the panel's single-URL resolve core. Resolves on success (the return
  // value is ignored — only success/failure + duration matter); rejects on
  // failure. MUST be internally bounded by the caller if it can hang.
  readonly resolveOnce: (canonicalUrl: string) => Promise<unknown>;
}

export interface ResolveCanaryOptions {
  readonly ports: ResolveCanaryPorts;
  // Tick cadence, ms. Default 60_000. Env-tunable at the wiring site.
  readonly intervalMs?: number;
  // Rolling window, ms. Default 10 min so a handful of ticks are always in
  // view even at the default cadence.
  readonly windowMs?: number;
  // Hard cap on retained samples (bound, §8). Default 200.
  readonly maxSamples?: number;
  // Injected clock + timers for deterministic tests.
  readonly now?: () => number;
  readonly setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
  // Called (best-effort) when a tick throws in an unexpected place; wiring
  // may log it. Never rethrows into the timer.
  readonly onError?: (error: unknown) => void;
}

export interface ResolveCanary {
  // Start the periodic probe. Idempotent. The runtime gates the call so the
  // canary never starts under test.
  readonly start: () => void;
  // Stop + release the timer (teardown).
  readonly stop: () => void;
  // Run exactly one probe cycle now (pick URL if needed → resolve → record).
  // Exposed so tests drive deterministic cycles without real timers, and so
  // the first sample lands immediately at start rather than one interval
  // later.
  readonly tick: () => Promise<void>;
  // Current window snapshot as of now().
  readonly snapshot: () => ResolveCanarySnapshot;
  // The pinned URL (null until first successful pick), for diagnostics/tests.
  readonly pinnedUrl: () => string | null;
}

export const createResolveCanary = (options: ResolveCanaryOptions): ResolveCanary => {
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? 60_000;
  const window = new ResolveCanaryWindow({
    windowMs: options.windowMs ?? 10 * 60_000,
    maxSamples: options.maxSamples ?? 200,
  });
  const setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h));

  let pinnedUrl: string | null = null;
  let handle: ReturnType<typeof setInterval> | null = null;
  // Single-flight: a slow resolve must never let ticks pile up (§8 — the
  // probe is itself a producer that must be deduplicated).
  let inFlight = false;

  const resolvePinnedUrl = async (): Promise<string | null> => {
    if (pinnedUrl !== null) return pinnedUrl;
    const picked = await options.ports.pickUrl();
    if (picked !== null && picked.length > 0) {
      pinnedUrl = picked;
    }
    window.setHasTarget(pinnedUrl !== null);
    return pinnedUrl;
  };

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const url = await resolvePinnedUrl();
      if (url === null) {
        // Empty vault → idle. Never fabricate a sample.
        return;
      }
      const startedAt = now();
      let ok = true;
      try {
        await options.ports.resolveOnce(url);
      } catch {
        ok = false;
      }
      const atMs = now();
      window.record({ atMs, durationMs: Math.max(0, atMs - startedAt), ok });
    } catch (error) {
      // pickUrl threw, or something unexpected. Never let the timer die.
      options.onError?.(error);
    } finally {
      inFlight = false;
    }
  };

  return {
    start: () => {
      if (handle !== null) return;
      handle = setIntervalFn(() => {
        void tick();
      }, intervalMs);
      // Do not keep the process alive for the probe alone.
      if (typeof (handle as { unref?: () => void }).unref === 'function') {
        (handle as { unref?: () => void }).unref?.();
      }
      // Land a first sample promptly instead of one interval late.
      void tick();
    },
    stop: () => {
      if (handle !== null) {
        clearIntervalFn(handle);
        handle = null;
      }
    },
    tick,
    snapshot: () => window.snapshot(now()),
    pinnedUrl: () => pinnedUrl,
  };
};

// --- vaultRoot-keyed registry ------------------------------------------
//
// The health route reads the running canary's snapshot for its vaultRoot
// without a new HTTP-config field (the config interface lives outside the
// health-assembly region; the route already keeps module-level maps like
// systemHealthCache). companion.ts registers the started canary and
// unregisters it on teardown. Scoped + observable, not ambient global state:
// the only writer is the runtime composition root, and the key is the vault
// the canary probes.

const canaryRegistry = new Map<string, ResolveCanary>();

export const registerResolveCanary = (vaultRoot: string, canary: ResolveCanary): void => {
  canaryRegistry.set(vaultRoot, canary);
};

export const unregisterResolveCanary = (vaultRoot: string): void => {
  canaryRegistry.delete(vaultRoot);
};

export const getResolveCanary = (vaultRoot: string): ResolveCanary | undefined =>
  canaryRegistry.get(vaultRoot);

// Test-only: clear the registry so a suite that registers a canary does not
// leak it into another suite in the same process.
export const __clearResolveCanaryRegistryForTest = (): void => {
  canaryRegistry.clear();
};
