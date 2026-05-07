import type { PluginBudgets } from './budgetConfig';
import type { ResultScope, ScopedResult } from './resultScope';

// Sync Contract v1 / Class F — plugin-tier materializer interface.
//
// Mirror of the companion-side Materializer concept, adapted to the
// plugin tier's bounded storage. Each surface (threads, workstreams,
// queue, dispatches, future timeline) is one PluginMaterializer<T>.
//
// Required properties (asserted by tests):
//
//   1. Optimistic UI. admitLocal returns within < 50 ms regardless
//      of companion reachability.
//   2. Eviction is reversible. Evicted items go to coldArchive
//      (still in chrome.storage). NEVER lost client-side until
//      proven uploaded to companion.
//   3. Drain on connect. When companion transitions from
//      unreachable → reachable, drainSpoolToCompanion runs in the
//      background. Each drain attempt is idempotent on edgeDot.
//   4. Bounded UI. Side panel renders only the active set. Extended
//      queries trigger fetchExtended against companion (returns
//      ScopedResult).
//   5. No silent loss. Explicit actions that overflow capacity
//      visibly reject (failed-explicit terminal state). Passive
//      captures may degrade by configured policy; degradation is
//      health-visible.

export type AdmitIntent = 'explicit' | 'passive';

export type AdmitResult =
  | { ok: true; tier: 'active' | 'spool' }
  | {
      ok: false;
      reason: 'spool-full-explicit' | 'spool-full-passive-policy-drop' | 'export-required';
    };

export interface PluginMaterializerHealth {
  readonly status: 'healthy' | 'degraded' | 'failed';
  readonly activeSetSize: number;
  readonly activeSetBudget: number;
  readonly spoolSize: number;
  readonly spoolBudget: number;
  readonly companionReachable: boolean;
  readonly lastReconcileAt: string | null;
  readonly lastError: string | null;
  // Counts of items in terminal states for observability.
  readonly failedExplicitCount: number;
  readonly droppedPassiveCount: number;
}

export interface ExtendedQuery {
  readonly q?: string;
  readonly limit?: number;
}

export type ExtendedResult<TItem> = ScopedResult<TItem>;

export interface PluginMaterializer<TItem> {
  readonly name: string;
  // Local mutation: side panel calls this on user action. Always
  // optimistic — admits to active set immediately, queues for
  // companion. Returns within < 50 ms.
  readonly admitLocal: (item: TItem, intent: AdmitIntent) => Promise<AdmitResult>;
  // Companion → plugin sync (SSE-driven mirror).
  readonly mirrorFromCompanion: (item: TItem) => Promise<void>;
  // Extended-query fallback. Hits companion HTTP if reachable;
  // returns 'plugin-active-only-companion-unreachable' otherwise.
  readonly fetchExtended: (query: ExtendedQuery) => Promise<ExtendedResult<TItem>>;
  // Background drains.
  readonly drainSpoolToCompanion: () => Promise<{ uploaded: number; remaining: number }>;
  readonly exportSpoolToArchive: () => Promise<{ exported: number; archivePath: string }>;
  readonly health: () => PluginMaterializerHealth;
}

// A bounded helper for materializer implementations. Tracks the
// active set size + spool size + counts; rejects per the Class F
// state-machine rules.
export class PluginBudgetGuard {
  private failedExplicit = 0;
  private droppedPassive = 0;

  constructor(private readonly budgets: PluginBudgets) {}

  decideAdmit(args: {
    readonly intent: AdmitIntent;
    readonly activeSetCount: number;
    readonly spoolCount: number;
    readonly activeSetBudget: number;
  }): AdmitResult {
    if (args.activeSetCount < args.activeSetBudget) {
      return { ok: true, tier: 'active' };
    }
    // Active full — overflow goes to spool (subject to per-intent
    // caps).
    if (args.intent === 'explicit') {
      if (args.spoolCount < this.budgets.maxExplicitPending) {
        return { ok: true, tier: 'spool' };
      }
      this.failedExplicit += 1;
      return { ok: false, reason: 'spool-full-explicit' };
    }
    // Passive intent.
    if (args.spoolCount < this.budgets.maxPassivePending) {
      return { ok: true, tier: 'spool' };
    }
    this.droppedPassive += 1;
    return { ok: false, reason: 'spool-full-passive-policy-drop' };
  }

  metrics(): { failedExplicit: number; droppedPassive: number } {
    return {
      failedExplicit: this.failedExplicit,
      droppedPassive: this.droppedPassive,
    };
  }
}

// Type-only re-export so callers don't need to know about budgetConfig.
export type { ResultScope } from './resultScope';
