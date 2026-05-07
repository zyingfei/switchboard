// Sync Contract v1 / Class F — per-tier plugin budgets.
//
// Three concrete tiers, bounded at every level:
//   1. active set    — rendered + locally searched; small + fast.
//   2. local spool   — bounded; not rendered; queued for companion drain
//                      or archive export.
//   3. archive export — file/pack handoff via chrome.downloads;
//                      not guaranteed to be imported.
//
// Defaults are conservative enough to survive a heavy user. A future
// stage adds user-tunable budgets in side-panel settings.

export interface PluginBudgets {
  // Total bytes the active set may use across all surfaces.
  // Conservative default for chrome.storage.local quota.
  readonly activeSetBytes: number;
  // Per-surface count caps. Eviction policy (recency, status-based,
  // etc.) is per-PluginMaterializer.
  readonly activeSetCount: Record<string, number>;
  // Total bytes the local spool may hold. Hard cap; overflow goes
  // to archive export (or visible rejection if export is also full).
  readonly spoolBytes: number;
  readonly spoolCount: number;
  // Maximum explicit-pending items in the spool. When exceeded,
  // new explicit user actions are visibly rejected with recovery
  // instructions. Never silently dropped.
  readonly maxExplicitPending: number;
  // Maximum passive-pending items in the spool. Overflow degrades
  // by configured policy (drop-oldest is typical), and the drop is
  // health-visible.
  readonly maxPassivePending: number;
  // When the spool grows past this many bytes AND companion has
  // been unreachable for the configured window, trigger archive
  // export (chrome.downloads). Stage L3.S4 follow-up wires this.
  readonly archiveExportTriggerBytes: number;
}

// Per-surface count cap defaults. Threads have the highest
// expected churn so they get the bigger budget. Workstreams +
// queue items rarely exceed 100. Recent dispatches already capped
// at 50 in the existing mirror function.
const DEFAULT_ACTIVE_COUNTS: Record<string, number> = {
  threads: 200,
  workstreams: 100,
  queue: 100,
  dispatches: 50,
  annotations: 100,
};

export const DEFAULT_PLUGIN_BUDGETS: PluginBudgets = {
  activeSetBytes: 4_500_000, // ~4.5 MB; chrome.storage.local quota is 10 MB
  activeSetCount: DEFAULT_ACTIVE_COUNTS,
  spoolBytes: 2_000_000,
  spoolCount: 1_000,
  maxExplicitPending: 200,
  maxPassivePending: 800,
  archiveExportTriggerBytes: 1_500_000,
};
