// Sync Contract v1 / Class F adoption — capture queue.
//
// The existing capture-queue (src/companion/queue.ts) was built before
// Class F was formalized. It already implements the contract:
//   - Bounded active set (QUEUE_LIMIT = 1000)
//   - Explicit/passive intent
//   - Drop-oldest on overflow (passive)
//   - Reject-explicit on full queue (failed → failedQueue)
//   - Idempotent retry (Idempotency-Key header)
//
// This module is a thin adapter that exposes the queue's metrics
// in the PluginMaterializer health shape so /v1/system/health (when
// the side panel surfaces it) can show capture-queue degradation
// alongside companion-side materializer health.
//
// A future stage may rewrite the queue on top of spool.ts, but
// today the queue is stable + tested. The contract is ABOUT the
// observable behavior, not about which file owns the
// implementation.

import { QUEUE_LIMIT, readDroppedCount, readFailedCaptures, readQueue } from '../companion/queue';
import { DEFAULT_PLUGIN_BUDGETS } from './budgetConfig';
import type { PluginMaterializerHealth } from './pluginMaterializer';

export const captureQueueHealth = async (): Promise<PluginMaterializerHealth> => {
  const queue = await readQueue();
  const dropped = await readDroppedCount();
  const failedExplicit = await readFailedCaptures();
  // Active set = the live queue (in-flight + retrying); failed-explicit
  // are the terminal-rejected items.
  const activeCount = queue.length;
  // Spool semantics: passive items waiting to drain. We don't have
  // a separate spool for capture today — the queue IS the active+
  // pending merged. Report the merged count as activeSetSize and
  // expose dropped+failed as the terminal-state indicators.
  const status: PluginMaterializerHealth['status'] =
    failedExplicit.length > 0 ? 'failed' : activeCount > QUEUE_LIMIT * 0.8 ? 'degraded' : 'healthy';
  return {
    status,
    activeSetSize: activeCount,
    activeSetBudget: QUEUE_LIMIT,
    spoolSize: 0,
    spoolBudget: DEFAULT_PLUGIN_BUDGETS.spoolBytes,
    // companionReachable is determined by the runtime (companion
    // status check); the queue itself is companion-agnostic.
    companionReachable: true,
    lastReconcileAt: null,
    lastError:
      failedExplicit.length > 0
        ? `${String(failedExplicit.length)} explicit captures rejected; queue full while companion offline`
        : null,
    failedExplicitCount: failedExplicit.length,
    droppedPassiveCount: dropped,
  };
};
