// In-flight HTTP request registry — the attribution the stall watchdog lacked.
//
// THE GAP. eventLoopMonitor prints
//   [api.stall] eventLoopBlockedMs=3008 thresholdMs=250 ... note=single-tick max
// with NO indication of WHICH route held the thread. Every investigation of a
// companion stall (2026-06-20 live-browsing downtime, 2026-07-28 batch-resolve)
// therefore started by GUESSING the offending endpoint and re-deriving it from
// SIDETRACK_HTTP_LOG timings — and endpoint-guessing has failed ~5 times in
// this repo's history (see the CPU-runaway investigation notes). The blocked
// thread is by definition inside SOME handler; this registry is the cheapest
// possible way to name it.
//
// THE SHAPE. Module-level, synchronous, allocation-light: the HTTP dispatch
// registers a route label on entry and completes it in a `finally`. The monitor
// asks for the longest-running entries when it decides to print a stall line.
// No timers, no subscriptions, nothing to start or stop.
//
// ATTRIBUTION IS A SNAPSHOT AT DETECTION TIME, not a causal proof. The watchdog
// notices a stall on the tick AFTER the block ends, so:
//   - a route still running when the stall is noticed (the multi-second
//     batch-resolve case, which is the one we care about) is attributed;
//   - a route that blocked and FINISHED inside the same tick shows `none`.
// That asymmetry is deliberate and honest — it never invents a culprit. A
// `none` on a repeated stall is itself a finding: the blocker was not an HTTP
// handler (drain, materializer, GC).
//
// PRIVACY. The stored string is the ROUTE PATTERN (`GET:/v1/visits/{canonicalUrl}/resolve`),
// derived from the compiled RegExp in the route table — the request URL never
// reaches this module, so a canonical URL (PII) cannot leak into a log line by
// construction. Same posture as the SIDETRACK_HTTP_LOG line, which strips
// url.search for exactly this reason, except stronger: that one still logs the
// pathname, which for the resolve routes CONTAINS the encoded URL.
//
// ZERO imports on purpose (see eventLoopYield.ts): eventLoopMonitor imports
// this directly, and this must never be able to pull the HTTP layer into the
// runtime layer.

/** One in-flight request, as seen by a caller of `snapshotInflight`. */
export interface InflightRequest {
  /** Route PATTERN label, e.g. `POST:/v1/visits/batch-resolve`. Never a URL. */
  readonly route: string;
  /** How long the request has been running, in ms. */
  readonly ageMs: number;
}

/**
 * Hard cap on concurrently-tracked requests. The companion is a single-user
 * loopback daemon; 512 simultaneous in-flight requests is already pathological.
 * The cap exists so a hypothetical `complete()` leak (a dispatch path that
 * returns without its `finally`) degrades into "attribution stops working"
 * rather than an unbounded Map — a diagnostic must never become the outage.
 */
const MAX_TRACKED = 512;

/** Default number of entries `snapshotInflight` / the log line will return. */
const DEFAULT_SNAPSHOT_LIMIT = 3;

interface Entry {
  readonly route: string;
  readonly startedMs: number;
}

const inflight = new Map<number, Entry>();
let nextId = 1;
let droppedOverCap = 0;

/**
 * Register a request as in-flight. Returns the id to hand `completeInflight`.
 *
 * Returns 0 ("not tracked") when the cap is hit; `completeInflight(0)` is a
 * no-op, so callers need no special case. Wall-clock `Date.now()` rather than
 * `performance.now()` to match the SIDETRACK_HTTP_LOG timings an operator
 * correlates these lines against.
 */
export const registerInflight = (route: string): number => {
  if (inflight.size >= MAX_TRACKED) {
    droppedOverCap += 1;
    return 0;
  }
  const id = nextId;
  nextId += 1;
  inflight.set(id, { route, startedMs: Date.now() });
  return id;
};

/** Mark a request finished. Safe to call with 0, twice, or with a stale id. */
export const completeInflight = (id: number): void => {
  if (id === 0) return;
  inflight.delete(id);
};

/**
 * The longest-running in-flight requests, oldest first, capped at `limit`.
 * Bounded output by construction: a caller can never make this print the whole
 * table into a log line.
 */
export const snapshotInflight = (
  limit: number = DEFAULT_SNAPSHOT_LIMIT,
): readonly InflightRequest[] => {
  if (limit <= 0 || inflight.size === 0) return [];
  const now = Date.now();
  return [...inflight.values()]
    .map((entry) => ({ route: entry.route, ageMs: Math.max(0, now - entry.startedMs) }))
    .sort((left, right) =>
      right.ageMs !== left.ageMs
        ? right.ageMs - left.ageMs
        : left.route < right.route
          ? -1
          : left.route > right.route
            ? 1
            : 0,
    )
    .slice(0, limit);
};

/**
 * Render the in-flight set for a one-line log field: `route:ageMs|route:ageMs`,
 * or the literal `none` when nothing is running.
 *
 * FORMAT CONTRACT: the label itself is space- and colon-free apart from the
 * single `METHOD:` prefix (see `routeLabelFromPattern`), so the age is always
 * the TRAILING `:<n>ms` — split on the last colon to parse. No spaces, so the
 * surrounding `key=value` log line stays greppable/awk-able.
 */
export const formatInflightForLog = (limit: number = DEFAULT_SNAPSHOT_LIMIT): string => {
  const entries = snapshotInflight(limit);
  if (entries.length === 0) return 'none';
  return entries.map((entry) => `${entry.route}:${String(entry.ageMs)}ms`).join('|');
};

/** How many registrations were dropped because the cap was hit (leak signal). */
export const droppedInflightRegistrations = (): number => droppedOverCap;

/** Current tracked count — for tests and for a future /v1/status field. */
export const inflightCount = (): number => inflight.size;

/** Test seam: module-level state is process-global, so tests must reset it. */
export const __resetInflightRegistry = (): void => {
  inflight.clear();
  nextId = 1;
  droppedOverCap = 0;
};

// ---- route label derivation -------------------------------------------

const labelCache = new Map<string, string>();

/**
 * Derive a stable, PII-free label from a route's compiled pattern.
 *
 * The route table (http/server.ts) stores only `{ method, pattern: RegExp }` —
 * there is no template string to reuse — so the label is reconstructed from
 * `RegExp.source`:
 *
 *   /^\/v1\/visits\/(?<canonicalUrl>[^/]+)\/resolve$/u  ->  GET:/v1/visits/{canonicalUrl}/resolve
 *   /^\/v1\/threads\/[A-Za-z0-9_-]+\/archive$/          ->  POST:/v1/threads/{param}/archive
 *   /^\/v1\/status$/                                    ->  GET:/v1/status
 *
 * Deriving from the PATTERN (not the request URL) is the load-bearing part: a
 * canonical URL can never reach the label, so no stall line can leak browsing
 * history. The final whitelist pass also guarantees the label contains no
 * spaces and no colons beyond the `METHOD:` prefix, which the log format above
 * depends on.
 *
 * Memoized on (method, source): the route table is a fixed finite list, so the
 * cache is bounded by the number of routes and this runs once per route ever.
 */
export const routeLabelFromPattern = (method: string, pattern: RegExp): string => {
  const cacheKey = `${method}\u0000${pattern.source}`;
  const cached = labelCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const path = pattern.source
    .replace(/^\^/u, '')
    .replace(/\$$/u, '')
    // Named capture groups carry the parameter's name — keep it, it is the
    // most useful part of the label (`{canonicalUrl}` vs a bare `{param}`).
    .replace(/\(\?<([A-Za-z0-9_]+)>[^)]*\)/gu, '{$1}')
    // Any other group, and any bare character class (`[A-Za-z0-9_-]+`), is an
    // unnamed path parameter.
    .replace(/\([^)]*\)/gu, '{param}')
    .replace(/\[[^\]]*\][+*?]?/gu, '{param}')
    .replace(/\\\//gu, '/')
    .replace(/\\([.\-+])/gu, '$1')
    // Whitelist pass — anything the rewrites above did not account for (stray
    // regex metacharacters, and critically any space or colon) is dropped, so
    // the format contract holds no matter what a future route pattern looks
    // like.
    .replace(/[^A-Za-z0-9/_\-.{}]/gu, '');
  const label = `${method}:${path}`;
  labelCache.set(cacheKey, label);
  return label;
};
