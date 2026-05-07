import type { RecallActivityTracker } from '../../recall/activity.js';
import type { RecallLifecycle } from '../../recall/lifecycle.js';
import type { EventLog } from '../eventLog.js';
import type { Materializer, MaterializerHealth } from './materializer.js';
import { eventTypesForMaterializer } from './registry.js';

// Class B materializer for the recall index.
//
// Uses the dirty-bit pattern: every onAccepted call sets `dirty`. If
// no worker is in-flight, start one. The worker drains while dirty
// is true, then exits. A burst of N events scheduled while a worker
// is already running coalesces into at most one extra drain pass.
// This is the "no deadlock + bounded scheduling under burst" answer
// (gate L1-G6) — even a 100-event reconnect backlog produces exactly
// one in-flight ingest worker.
//
// Lane 2 will reshape the trigger: instead of running
// ingestIncremental over the merged log directly, the materializer
// will react to extraction-store changes via the
// `latestExtractionRevision != indexedExtractionRevision` divergence
// and call replaceEntriesForSourceUnit. For Lane 1, we keep the
// existing ingestIncremental path so the contract closes the recall
// freshness bug without waiting for Lane 2.
//
// Replay-recoverability: catchUp does the same thing as a burst of
// onAccepted events — it asks the lifecycle's ingestIncremental to
// catch up the index frontier. After a crash, the next startup's
// catchUp brings the index back in line with the event log.

export interface CreateRecallMaterializerDeps {
  readonly recallLifecycle: RecallLifecycle;
  readonly recallActivity: RecallActivityTracker;
}

export const createRecallMaterializer = (
  deps: CreateRecallMaterializerDeps,
): Materializer => {
  const handles = eventTypesForMaterializer('recall');

  let dirty = false;
  let running = false;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  // Bound on first onAccepted or catchUp; closures capture it.
  let boundEventLog: EventLog | null = null;

  const drain = async (): Promise<void> => {
    while (dirty) {
      dirty = false;
      const eventLog = boundEventLog;
      if (eventLog === null) {
        // Nothing to drain to; an upcoming catchUp will set the log
        // and re-trigger.
        return;
      }
      try {
        await deps.recallLifecycle.ingestIncremental(eventLog);
        lastSuccessAt = new Date().toISOString();
        lastError = null;
      } catch (err) {
        const code =
          err !== null && typeof err === 'object' && 'code' in err
            ? String((err as { code: unknown }).code)
            : 'unknown';
        const message = err instanceof Error ? err.message : String(err);
        lastError = `${code}: ${message.slice(0, 200)}`;
        deps.recallActivity.recordIngestFailed(lastError);
        // Don't loop — the failure may be persistent (model missing).
        // Next event arrival OR next startup will retry.
        return;
      }
    }
  };

  const requestIngest = (): void => {
    dirty = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        await drain();
      } finally {
        running = false;
      }
    })();
  };

  const onAccepted: Materializer['onAccepted'] = (event) => {
    void event; // event type is in handles; we re-read the merged log inside drain
    requestIngest();
  };

  const catchUp: Materializer['catchUp'] = async (eventLog) => {
    boundEventLog = eventLog;
    requestIngest();
    // AWAIT drain — startup tests assert "contract restored," not
    // "kicked off."
    while (running) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const awaitIdle: Materializer['awaitIdle'] = async () => {
    while (running || dirty) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const health: Materializer['health'] = (): MaterializerHealth => ({
    status: lastError !== null ? 'failed' : running || dirty ? 'degraded' : 'healthy',
    lastSuccessAt,
    lastError,
    pending: running || dirty,
  });

  return {
    name: 'recall',
    handles,
    onAccepted,
    catchUp,
    awaitIdle,
    health,
  };
};
