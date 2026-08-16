// Statement-level SQL budget — the detection layer for the 2026-08-16
// "connections reconcile child hangs forever" incident (see
// src/connections/snapshot.replaceScopeRows.perf.test.ts for the full
// forensics). ONE call — `deleteOrphanEdges.run()` inside
// SqliteConnectionsStore#replaceScopeRows — ran for 30+ minutes because a
// trigger it fired (`trg_edges_index_au` / `trg_edges_index_ad`) resolved to
// a full `SCAN edges_index` per row touched on `edges`. The only way anyone
// found out was the reconcile child's 30-minute no-progress SIGKILL watchdog
// (connectionsReconcileChildClient.ts) — a coarse, blunt, LAST-resort signal
// that cost most of a day to diagnose because it carries zero attribution
// (which statement? which table? which plan?).
//
// THE GAP this closes: nothing between "the query runs" and "the watchdog
// kills the whole child 30 minutes later" ever looked at how long any ONE
// bun:sqlite call actually took. This module is that missing layer — a thin
// wrapper at the `.run()` / `.all()` / `.get()` call boundary that measures
// wall time and, when a statement blows its budget, logs WHICH statement,
// WHERE it was called from, and (past a much higher hard budget) WHAT PLAN
// it resolved to — surfacing a pathological statement in seconds, from its
// own first slow call, not 30 minutes later via a kill loop.
//
// NO INTERRUPTION. bun:sqlite has no `sqlite3_progress_handler` binding, so
// there is no way to abort a statement mid-execution from JS — and even if
// there were, killing a write mid-`BEGIN IMMEDIATE` transaction is exactly
// the kind of "half-applied mutation" risk this repo's incident history (see
// the M7 hang-safety notes in connectionsReconcileChildClient.ts) has
// learned to avoid outside of a full-process SIGKILL + transaction rollback.
// This module is DETECTION AND ATTRIBUTION ONLY: it can only log after the
// call returns control to JS. For a statement that is itself pathologically
// slow (the incident shape), that is still a dramatic improvement — the
// FIRST slow call in a loop (e.g. a trigger firing per row) alarms within
// SIDETRACK_SQL_BUDGET_MS, long before the loop could ever reach 30 minutes.
//
// ADOPTION. `src/connections/snapshot.ts` (the incident site) is the first
// caller — see its `replaceScopeRows`, `#persistProjectionAccumulatorWrite`,
// `cacheResolverResult` / `getCachedResolverResult`, and the resolver
// subgraph reads. Other bun:sqlite-backed stores (page-content, page-
// evidence, idempotency, …) can adopt this module incrementally by wrapping
// their own `db.query(sql)` calls with `budgetedStatement` — nothing here is
// specific to the connections store.
//
// ZERO overhead goal on the fast (non-slow) path: two `performance.now()`
// reads, a numeric env parse, and a comparison — no allocation, no async, no
// stack capture. Measured in sqlBudget.test.ts (target: under 2µs/call).
//
// ZERO imports on purpose (see eventLoopYield.ts / inflightRegistry.ts for
// the same convention in this directory): this sits below every store, so it
// must never be able to pull anything else into the dependency graph.

/** Minimal bun:sqlite `Statement` shape this module depends on — matches the
 *  local `SqliteStatement` interface in snapshot.ts structurally (duck-typed,
 *  no import needed either direction). */
export interface SqlBudgetStatement {
  readonly run: (...params: readonly unknown[]) => unknown;
  readonly get: (...params: readonly unknown[]) => unknown;
  readonly all: (...params: readonly unknown[]) => readonly unknown[];
}

/** Minimal bun:sqlite `Database` shape this module depends on. */
export interface SqlBudgetDb {
  readonly query: (sql: string) => SqlBudgetStatement;
}

const DEFAULT_SQL_BUDGET_MS = 1000;
const DEFAULT_SQL_BUDGET_HARD_MS = 60_000;

// How the FIRST breach at a given call site always logs immediately (the
// incident's own shape — a trigger firing per row — needs the very first
// occurrence to surface, not the Nth); subsequent breaches at the same site
// within this window are counted but not re-logged, so a statement stuck in
// a tight loop cannot flood the log. Not env-tunable on purpose: it is a
// log-hygiene knob, not a detection-semantics knob (SIDETRACK_SQL_BUDGET_MS
// / _HARD_MS are the ones an operator actually needs to tune).
const LOG_THROTTLE_MS = 5_000;

const numericEnvMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

/** Re-read every call (no caching) — matches the established convention for
 *  these env-tunable budgets (see connectionsReconcileChildClient.ts's
 *  `noProgressTimeoutMs`). Tests can flip the env var between calls; the
 *  cost of re-parsing a short numeric string is far under the 2µs/call
 *  budget this module targets. */
export const sqlBudgetMs = (): number =>
  numericEnvMs('SIDETRACK_SQL_BUDGET_MS', DEFAULT_SQL_BUDGET_MS);
export const sqlBudgetHardMs = (): number =>
  numericEnvMs('SIDETRACK_SQL_BUDGET_HARD_MS', DEFAULT_SQL_BUDGET_HARD_MS);

interface SiteState {
  /** Every breach over the soft budget, whether or not it was logged. */
  slowCount: number;
  /** Every breach over the hard budget, whether or not EXPLAIN ran. */
  hardCount: number;
  lastLoggedAtMs: number;
  lastMs: number;
}

// Module-scoped (process lifetime) — same pattern as
// connectionsReconcileChildClient.ts's diagnostics counters. Bounded key
// space: one entry per DISTINCT call-site label, not per statement
// invocation, so this cannot grow unbounded on a hot path.
const siteStates = new Map<string, SiteState>();

/** Test/diagnostics seam. Snapshot of one site's counters, or all sites. */
export interface SqlBudgetSiteSnapshot {
  readonly site: string;
  readonly slowCount: number;
  readonly hardCount: number;
  readonly lastMs: number;
}

export const sqlBudgetDiagnostics = (): readonly SqlBudgetSiteSnapshot[] =>
  [...siteStates.entries()].map(([site, state]) => ({
    site,
    slowCount: state.slowCount,
    hardCount: state.hardCount,
    lastMs: state.lastMs,
  }));

/** Test seam — clears all counters/throttle state between test cases. Never
 *  called from production code. */
export const resetSqlBudgetDiagnostics = (): void => {
  siteStates.clear();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Best-effort EXPLAIN QUERY PLAN row -> one human-readable line. bun:sqlite
 *  returns {id, parent, notused, detail} rows; `detail` carries the
 *  SCAN/SEARCH text the plan-lint suite greps for. */
const explainRowDetail = (row: unknown): string => {
  if (!isRecord(row)) return String(row);
  const detail = row['detail'];
  return typeof detail === 'string' ? detail : JSON.stringify(row);
};

/** Runs EXPLAIN QUERY PLAN for `sql` on the SAME handle, AFTER the slow
 *  statement already completed (never before/during — this never touches
 *  the statement that just ran). Unbound placeholders in `sql` are planned
 *  as NULL by SQLite, which is sufficient for shape (SCAN vs SEARCH); best-
 *  effort — any failure (e.g. a statement EXPLAIN QUERY PLAN can't parse
 *  standalone) is swallowed and logged as a plan-error line, never thrown. */
const explainAfterSlowStatement = (db: SqlBudgetDb, site: string, sql: string): void => {
  try {
    const rows = db.query(`EXPLAIN QUERY PLAN ${sql}`).all();
    const plan = rows.map(explainRowDetail).join(' | ');
    console.warn(`[sql.slow.explain] site=${site} plan=${plan}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[sql.slow.explain] site=${site} plan-error=${message}`);
  }
};

const recordSlow = (db: SqlBudgetDb, site: string, sql: string, dtMs: number): void => {
  let state = siteStates.get(site);
  if (state === undefined) {
    state = { slowCount: 0, hardCount: 0, lastLoggedAtMs: 0, lastMs: 0 };
    siteStates.set(site, state);
  }
  state.slowCount += 1;
  state.lastMs = dtMs;
  const isHard = dtMs >= sqlBudgetHardMs();
  if (isHard) state.hardCount += 1;

  const nowMs = Date.now();
  const dueToLog = nowMs - state.lastLoggedAtMs >= LOG_THROTTLE_MS;
  if (!dueToLog) return;
  state.lastLoggedAtMs = nowMs;

  try {
    console.warn(`[sql.slow] ms=${String(Math.round(dtMs))} site=${site} sql=${sql.slice(0, 120)}`);
  } catch {
    // Logging must never break the caller — the query already completed.
  }
  if (isHard) explainAfterSlowStatement(db, site, sql);
};

/** Wraps a single call (`run`/`get`/`all`) with the timing check. Exported
 *  for callers that already hold a prepared `SqlBudgetStatement` and want to
 *  budget one specific method without re-wrapping the whole statement (rare;
 *  prefer `budgetedStatement` below for the common case). */
export const sqlBudgeted = <T>(db: SqlBudgetDb, site: string, sql: string, fn: () => T): T => {
  const startedAtMs = performance.now();
  const result = fn();
  const dtMs = performance.now() - startedAtMs;
  if (dtMs >= sqlBudgetMs()) recordSlow(db, site, sql, dtMs);
  return result;
};

/** Drop-in replacement for `db.query(sql)`: prepares the statement once (no
 *  per-call overhead beyond the timing check) and returns a same-shaped
 *  `SqlBudgetStatement` whose `run`/`get`/`all` are each individually timed
 *  and attributed to `site`. Typical call-site diff is one line:
 *    const stmt = db.query(SQL)              ->  const stmt = budgetedStatement(db, 'site.label', SQL)
 *  `site` should be a stable, human-chosen `<store>.<method>.<statement>`
 *  label — see snapshot.ts's call sites for the convention. */
export const budgetedStatement = (
  db: SqlBudgetDb,
  site: string,
  sql: string,
): SqlBudgetStatement => {
  const stmt = db.query(sql);
  return {
    run: (...params: readonly unknown[]) => sqlBudgeted(db, site, sql, () => stmt.run(...params)),
    get: (...params: readonly unknown[]) => sqlBudgeted(db, site, sql, () => stmt.get(...params)),
    all: (...params: readonly unknown[]) => sqlBudgeted(db, site, sql, () => stmt.all(...params)),
  };
};
