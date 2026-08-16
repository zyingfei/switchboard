// Phase-level budget checker — the second detection layer for the
// 2026-08-16 "connections reconcile child hangs forever" incident (see
// sqlBudget.ts's header for the full incident background).
//
// connectionsMaterializer.ts's `buildAndWrite` (its `mark()` closure, around
// line 3652) already timestamps every major phase of a drain and pushes
// `{ label, durationMs, totalMs }` onto a `phaseDurations` array — that's
// where the coarse, per-phase equivalent of the statement budget belongs.
//
// WIRING NOTE — why this isn't inside connectionsMaterializer.ts's mark():
// this change's operator directive is "do NOT touch
// src/sync/contract/connectionsMaterializer.ts" (see docs/plans/2026-08-15-
// foundation-program.md). `mark()` formats and emits its own
// `[connections-phase]` log line inline — it does not delegate to any
// shared logging/formatting utility this module could hook without editing
// that file. The one reachable seam is `collectMaterializerDiagnostics` in
// materializerDiagnostics.ts (NOT forbidden): connectionsMaterializer.ts
// already calls it exactly once per `buildAndWrite`, right before
// returning, passing the SAME raw `phaseDurations` array `mark()` built
// (see connectionsMaterializer.ts's `collectMaterializerDiagnostics({...,
// phaseDurations, ...})` call). `checkPhaseBudgetExceeded` below is wired in
// from there.
//
// TRADE-OFF, stated precisely: this fires once the WHOLE drain finishes (all
// phases), not the instant the slow phase's own `mark()` call would have
// fired. In practice this is not a regression for the incident shape: if a
// single phase is genuinely wedged inside one synchronous bun:sqlite call
// (exactly what happened), NEITHER hook can fire until that call returns
// control to JS — `mark()` cannot log a phase that hasn't finished either.
// The statement budget (sqlBudget.ts) is the layer that actually alarms
// DURING such a phase, seconds into it, from the first slow statement — this
// phase-level layer is the coarser backstop for phases that are slow
// end-to-end without any single statement individually breaching the SQL
// budget (e.g. a phase doing a very large number of small, each-individually-
// fast operations).
//
// DISCIPLINE: never throw, never kill. The existing no-progress watchdog
// (connectionsReconcileChildClient.ts, SIDETRACK_CONNECTIONS_CHILD_NOPROGRESS_MS)
// remains the hard backstop. This is audible-drain-failure only — the log
// IS the alarm.
//
// ZERO imports on purpose (see eventLoopYield.ts / sqlBudget.ts).

const DEFAULT_PHASE_BUDGET_MS = 120_000;

const numericEnvMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

/** Re-read every call — same rationale as sqlBudget.ts's `sqlBudgetMs`. */
export const phaseBudgetMs = (): number =>
  numericEnvMs('SIDETRACK_PHASE_BUDGET_MS', DEFAULT_PHASE_BUDGET_MS);

/** Structural subset of connectionsMaterializer.ts's `MaterializerPhaseDuration`
 *  (materializerDiagnostics.ts) — duck-typed so this module needs no import
 *  from either. */
export interface PhaseDurationLike {
  readonly label: string;
  readonly durationMs: number;
}

/** Logs `[phase.budget-exceeded]` for every phase whose `durationMs` exceeds
 *  SIDETRACK_PHASE_BUDGET_MS. Pure aside from the logging side effect: never
 *  throws (a logging failure must never break diagnostics collection, which
 *  itself must never break a drain), never mutates its input. Returns the
 *  flagged labels — a test/observability seam, not used by the default
 *  caller. `logger` defaults to `console.warn` and is overridable for tests. */
export const checkPhaseBudgetExceeded = (
  phaseDurations: readonly PhaseDurationLike[] | undefined,
  logger: (line: string) => void = (line) => console.warn(line),
): readonly string[] => {
  if (phaseDurations === undefined || phaseDurations.length === 0) return [];
  const budgetMs = phaseBudgetMs();
  const flagged: string[] = [];
  for (const phase of phaseDurations) {
    if (phase.durationMs <= budgetMs) continue;
    flagged.push(phase.label);
    try {
      logger(
        `[phase.budget-exceeded] phase=${phase.label} dt=${String(phase.durationMs)}ms budgetMs=${String(budgetMs)}`,
      );
    } catch {
      // Logging must never break diagnostics collection.
    }
  }
  return flagged;
};
