// Stale-while-revalidate + single-flight cache for the resolve family
// (/v1/tabsessions/:id/resolve, /v1/visits/:url/resolve dry-run, and the
// per-item path of /v1/visits/batch-resolve).
//
// WHY (the recurring resolve-flood, CLASS B): the previous resolve cache
// keyed each entry on `<url>|<connectionsGraphSig>|<query>`. Ingest batches
// land ~every minute; each drain rotates the graph signature, so EVERY
// cached resolve became a cold miss on the next poll. The extension polls
// ~every 15s with ~20 visible cards, so on each drain the whole visible set
// recomputed cold (5-13s each) concurrently on the single Bun loop → convoy
// → 45s client timeouts. Between drains the same resolves were warm
// (90-160ms). The panel already displays whatever it last polled between
// drains, so a slightly-stale resolve is EXACTLY what the user already sees.
//
// FIX: cache per (url + query), IGNORING the graph sig for the serve
// decision. On a request:
//   - entry exists  → serve it IMMEDIATELY. If its `sigAtCompute` is stale
//                      vs the current sig, kick a bounded background refresh
//                      for THAT key (request-triggered; never a proactive
//                      whole-cache recompute on drain).
//   - no entry (true cold) → compute inline as before.
// The served candidates/scores/decisions are UNCHANGED — only the
// freshness/blocking semantics of the cached response change.
//
// SINGLE-FLIGHT: concurrent same-key requests AND the background refresh
// share ONE computation. Background refreshes are bounded to a small global
// concurrency (queue the rest, newest-first with per-key dedupe) so a drain
// can never convoy the loop with N distinct-key recomputes.
//
// This module is deliberately transport-agnostic and side-effect-free apart
// from its own in-memory maps: the graph-signature source and the clock are
// injected so the whole SWR behaviour is unit-testable with fake timers.

export type ResolveResult = readonly [number, unknown];
export type ResolveFreshness = 'fresh' | 'stale-revalidating';

export interface ResolveSwrEntry {
  readonly value: ResolveResult;
  readonly sigAtCompute: string;
  computedAtMs: number;
}

export interface ResolveSwrServed {
  readonly result: ResolveResult;
  readonly freshness: ResolveFreshness;
}

export interface ResolveSwrCacheOptions {
  readonly ttlMs: number;
  /** Max in-flight background refreshes across all keys (1-2). */
  readonly maxBackgroundRefresh: number;
  /** Hard cap on resident entries; oldest-by-compute evicted past this. */
  readonly maxEntries: number;
  readonly now: () => number;
}

/**
 * A stale-while-revalidate cache keyed per serve-key (url+query), tracking
 * the graph signature each entry was computed under so staleness can trigger
 * a bounded background refresh without changing WHAT is served.
 */
export class ResolveSwrCache {
  private readonly entries = new Map<string, ResolveSwrEntry>();
  /** Single-flight: one in-flight compute per serve-key (inline OR bg). */
  private readonly inFlight = new Map<string, Promise<ResolveResult>>();
  /** Serve-keys queued for a background refresh (newest-first, deduped). */
  private readonly refreshQueue: string[] = [];
  private readonly pendingSig = new Map<string, string>();
  /** Latest builder per queued serve-key (reads live state at run time). */
  private readonly builders = new Map<string, () => Promise<ResolveResult>>();
  private activeBackground = 0;

  private readonly ttlMs: number;
  private readonly maxBackgroundRefresh: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ResolveSwrCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxBackgroundRefresh = Math.max(1, Math.floor(options.maxBackgroundRefresh));
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries));
    this.now = options.now;
  }

  /**
   * Serve a resolve for `serveKey` under the current graph `sig`.
   *
   * - Entry present & fresh (sig matches, within TTL): return it, freshness
   *   'fresh'.
   * - Entry present but stale (sig differs) and within TTL: return the stale
   *   value IMMEDIATELY with freshness 'stale-revalidating', and enqueue a
   *   bounded background refresh for this key.
   * - No entry, or entry past TTL: compute inline (single-flight), store, and
   *   return freshness 'fresh'.
   *
   * `build` MUST produce the same bytes the pre-SWR inline path produced; the
   * cache is a pure memo — eviction/refresh can only change hit-rate, never
   * the served bytes for a given (serveKey, sig).
   */
  async serve(
    serveKey: string,
    sig: string,
    build: () => Promise<ResolveResult>,
  ): Promise<ResolveSwrServed> {
    const entry = this.entries.get(serveKey);
    const nowMs = this.now();
    if (entry !== undefined && nowMs - entry.computedAtMs < this.ttlMs) {
      if (entry.sigAtCompute === sig) {
        return { result: entry.value, freshness: 'fresh' };
      }
      // Stale vs current graph — serve stale now, refresh in background for
      // THIS key only (request-triggered, never a whole-cache recompute).
      this.enqueueRefresh(serveKey, sig, build);
      return { result: entry.value, freshness: 'stale-revalidating' };
    }
    // True cold (or TTL-expired): compute inline, sharing one flight.
    const result = await this.computeSingleFlight(serveKey, sig, build);
    return { result, freshness: 'fresh' };
  }

  /**
   * Batch variant: serve ONLY if a non-expired entry already exists, never
   * compute inline. Returns undefined for a true-cold key so the caller can
   * fall through to its own (batched) inline compute path.
   *
   * - Entry present & sig matches: freshness 'fresh'.
   * - Entry present but stale (sig differs): serve stale + enqueue a bounded
   *   background refresh via `buildRefresh`.
   * - No entry / TTL-expired: return undefined.
   */
  serveStaleOnly(
    serveKey: string,
    sig: string,
    buildRefresh: () => Promise<ResolveResult>,
  ): ResolveSwrServed | undefined {
    const entry = this.entries.get(serveKey);
    if (entry === undefined || this.now() - entry.computedAtMs >= this.ttlMs) return undefined;
    if (entry.sigAtCompute === sig) return { result: entry.value, freshness: 'fresh' };
    this.enqueueRefresh(serveKey, sig, buildRefresh);
    return { result: entry.value, freshness: 'stale-revalidating' };
  }

  /**
   * Seed an entry from an already-computed result (e.g. a batch item that
   * resolved inline). Only 200s are stored — mirrors the compute path.
   */
  prime(serveKey: string, sig: string, value: ResolveResult): void {
    if (value[0] !== 200) return;
    this.entries.set(serveKey, { value, sigAtCompute: sig, computedAtMs: this.now() });
    this.evictIfNeeded();
  }

  /** Drop cached + queued state for keys matching `predicate` (user decisions). */
  invalidate(predicate: (serveKey: string) => boolean): void {
    for (const key of [...this.entries.keys()]) {
      if (predicate(key)) this.entries.delete(key);
    }
    for (const key of [...this.pendingSig.keys()]) {
      if (predicate(key)) this.pendingSig.delete(key);
    }
    for (let i = this.refreshQueue.length - 1; i >= 0; i -= 1) {
      const key = this.refreshQueue[i];
      if (key !== undefined && predicate(key)) this.refreshQueue.splice(i, 1);
    }
  }

  /** Test/diagnostic hooks. */
  size(): number {
    return this.entries.size;
  }
  activeBackgroundCount(): number {
    return this.activeBackground;
  }
  queuedRefreshCount(): number {
    return this.refreshQueue.length;
  }
  peek(serveKey: string): ResolveSwrEntry | undefined {
    return this.entries.get(serveKey);
  }

  private computeSingleFlight(
    serveKey: string,
    sig: string,
    build: () => Promise<ResolveResult>,
  ): Promise<ResolveResult> {
    const existing = this.inFlight.get(serveKey);
    if (existing !== undefined) return existing;
    const compute = (async (): Promise<ResolveResult> => {
      try {
        const result = await build();
        // Only pin successful resolves; errors/empties are cheap and must
        // not be cached (mirrors the pre-SWR cachedRoute contract).
        if (result[0] === 200) {
          this.entries.set(serveKey, {
            value: result,
            sigAtCompute: sig,
            computedAtMs: this.now(),
          });
          this.evictIfNeeded();
        }
        return result;
      } finally {
        this.inFlight.delete(serveKey);
      }
    })();
    this.inFlight.set(serveKey, compute);
    return compute;
  }

  private enqueueRefresh(serveKey: string, sig: string, build: () => Promise<ResolveResult>): void {
    // If a compute for this key is already in flight, it will store a fresh
    // entry on completion — no need to enqueue another.
    if (this.inFlight.has(serveKey)) return;
    // Record the newest requested sig; if already queued just refresh the sig
    // target (dedupe) rather than stacking duplicate work.
    const alreadyQueued = this.pendingSig.has(serveKey);
    this.pendingSig.set(serveKey, sig);
    if (!alreadyQueued) {
      // newest-first: a burst of drains prioritises the most-recently-touched
      // card the user is looking at.
      this.refreshQueue.unshift(serveKey);
    }
    // Stash the builder keyed by serveKey so the drainer can invoke it. The
    // builder closes over the current request's context, which is fine: the
    // resolve build reads live store/log state at run time, so any recent
    // builder for this key produces the current-graph result.
    this.builders.set(serveKey, build);
    this.pump();
  }

  private pump(): void {
    while (this.activeBackground < this.maxBackgroundRefresh && this.refreshQueue.length > 0) {
      const serveKey = this.refreshQueue.shift();
      if (serveKey === undefined) break;
      const sig = this.pendingSig.get(serveKey);
      const build = this.builders.get(serveKey);
      this.pendingSig.delete(serveKey);
      this.builders.delete(serveKey);
      if (sig === undefined || build === undefined) continue;
      // If an inline/other compute already claimed this key, skip.
      if (this.inFlight.has(serveKey)) continue;
      this.activeBackground += 1;
      void this.computeSingleFlight(serveKey, sig, build)
        .catch(() => undefined)
        .finally(() => {
          this.activeBackground -= 1;
          // A slot freed — drain the next queued refresh.
          this.pump();
        });
    }
  }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) return;
    // First drop TTL-expired entries, then hard-cap by evicting oldest.
    const nowMs = this.now();
    for (const [k, v] of this.entries) {
      if (nowMs - v.computedAtMs >= this.ttlMs) this.entries.delete(k);
    }
    if (this.entries.size <= this.maxEntries) return;
    const oldestFirst = [...this.entries.entries()].sort(
      (a, b) => a[1].computedAtMs - b[1].computedAtMs,
    );
    for (const [k] of oldestFirst.slice(0, oldestFirst.length - this.maxEntries)) {
      this.entries.delete(k);
    }
  }
}
