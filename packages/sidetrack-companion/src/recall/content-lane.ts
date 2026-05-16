// Sync Contract v1 / Stage 5.2 W7 — content / recall index lane
// (foundational types + dirty-source queue, no consumer wiring yet).
//
// Group B events (capture.recorded, capture.extraction.produced,
// future page.content.extracted, recall.tombstone.target) are
// append-only at the event log but their derived work (chunking,
// embedding, recall index replace, content-similarity revision) is
// expensive. The hot path must NOT do that work on the event loop;
// it marks the affected source units dirty and a reconciliation
// worker processes the queue off the critical path.
//
// Design context: docs/proposals/work-graph-stage5-2-incremental-materializer.md
// "W7 — Content / recall index lane."
//
// This commit ships:
//   - DirtySourceQueue — in-memory tracker for which sourceUnitIds
//     need re-chunking / re-embedding / recall-index replace.
//   - Hot-path fold: foldGroupBEventIntoQueue(event) — examines the
//     event type and marks the right sourceUnitId(s) dirty.
//   - Reconciliation contract: ContentLaneReconciler — the interface
//     the materializer-side reconciliation worker will implement to
//     drain the dirty queue.
//
// Out of scope (future PRs):
//   - Wiring the queue into the materializer's onAccepted dispatch.
//   - Worker_thread / async reconciliation execution.
//   - Embedding cache lookup by embedTextHash.
//   - Atomic source-unit replacement in the recall index.

import { CAPTURE_RECORDED, RECALL_TOMBSTONE_TARGET } from './events.js';
import { CAPTURE_EXTRACTION_PRODUCED } from './extraction/events.js';
import type { AcceptedEvent } from '../sync/causal.js';

// CaptureRecordedPayload / RecallTombstonePayload don't yet declare
// `sourceUnitId` (the W7 design doc anticipates the field; the wire
// shape is the load-bearing contract). Read it defensively the same
// way INVALIDATION_RULES in sync/contract/invalidation.ts does — the
// queue is a no-op when the field is absent.
const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export interface DirtySourceQueueSnapshot {
  readonly dirtySourceUnitIds: readonly string[];
  readonly tombstonedSourceUnitIds: readonly string[];
  readonly latestExtractionFor: ReadonlyMap<string, string>;
}

export interface DirtySourceQueue {
  /**
   * Mark a source unit dirty. Idempotent — a source unit only appears
   * once in the dirty set regardless of how many times this is
   * called with the same id.
   */
  markDirty(sourceUnitId: string): void;

  /**
   * Mark a source unit tombstoned. Implies dirty (it needs index
   * removal). Tombstoned sources stay tombstoned until reconciled.
   */
  markTombstoned(sourceUnitId: string): void;

  /**
   * Record the latest extractionRevisionId for a source unit. The
   * reconciler reads this when chunking / embedding; only the
   * latest revision matters.
   */
  recordLatestExtraction(sourceUnitId: string, extractionRevisionId: string): void;

  /** Snapshot the current queue state. Useful for the reconciler. */
  snapshot(): DirtySourceQueueSnapshot;

  /** Clear specific source units after the reconciler successfully
   * processes them. NOT idempotent across reconciler workers — caller
   * must hold a lock or stage one reconciler at a time. */
  clear(sourceUnitIds: readonly string[]): void;

  /** Clear all state — used on companion restart before re-seeding
   * from the event log. */
  clearAll(): void;
}

export const createDirtySourceQueue = (): DirtySourceQueue => {
  const dirty = new Set<string>();
  const tombstoned = new Set<string>();
  const latestExtraction = new Map<string, string>();

  const markDirty = (sourceUnitId: string): void => {
    if (sourceUnitId.length === 0) return;
    dirty.add(sourceUnitId);
  };

  const markTombstoned = (sourceUnitId: string): void => {
    if (sourceUnitId.length === 0) return;
    tombstoned.add(sourceUnitId);
    dirty.add(sourceUnitId);
  };

  const recordLatestExtraction = (sourceUnitId: string, extractionRevisionId: string): void => {
    if (sourceUnitId.length === 0 || extractionRevisionId.length === 0) return;
    latestExtraction.set(sourceUnitId, extractionRevisionId);
  };

  const snapshot = (): DirtySourceQueueSnapshot => ({
    dirtySourceUnitIds: [...dirty].sort(),
    tombstonedSourceUnitIds: [...tombstoned].sort(),
    latestExtractionFor: new Map(latestExtraction),
  });

  const clear = (sourceUnitIds: readonly string[]): void => {
    for (const id of sourceUnitIds) {
      dirty.delete(id);
      tombstoned.delete(id);
      // Intentionally retain latestExtraction — the next dirty cycle
      // for the same source unit may not include a fresh extraction
      // event but should still chunk the latest known revision.
    }
  };

  const clearAll = (): void => {
    dirty.clear();
    tombstoned.clear();
    latestExtraction.clear();
  };

  return { markDirty, markTombstoned, recordLatestExtraction, snapshot, clear, clearAll };
};

/**
 * Stage 5.2 W7 — fold a Group B event into the dirty-source queue.
 * Returns true if the event was a Group B event (handled), false
 * otherwise (caller can fall through to other handlers).
 *
 * This is the hot-path API: deliberately tiny, allocates nothing,
 * does no I/O. The actual chunk/embed/index work is the
 * reconciler's job (off-thread / on a debounced cadence).
 */
export const foldGroupBEventIntoQueue = (
  queue: DirtySourceQueue,
  event: AcceptedEvent,
): boolean => {
  if (event.type === CAPTURE_RECORDED) {
    const sourceUnitId = str(asRecord(event.payload)['sourceUnitId']);
    if (sourceUnitId !== undefined) queue.markDirty(sourceUnitId);
    return true;
  }
  if (event.type === CAPTURE_EXTRACTION_PRODUCED) {
    const payload = asRecord(event.payload);
    const sourceUnitId = str(payload['sourceUnitId']);
    const extractionRevisionId = str(payload['extractionRevisionId']);
    if (sourceUnitId !== undefined) {
      queue.markDirty(sourceUnitId);
      if (extractionRevisionId !== undefined) {
        queue.recordLatestExtraction(sourceUnitId, extractionRevisionId);
      }
    }
    return true;
  }
  if (event.type === RECALL_TOMBSTONE_TARGET) {
    const sourceUnitId = str(asRecord(event.payload)['sourceUnitId']);
    if (sourceUnitId !== undefined) queue.markTombstoned(sourceUnitId);
    return true;
  }
  return false;
};

// Reconciliation contract — implemented by the worker that drains the
// queue. Lives here so the API surface is co-located with the queue;
// a future PR provides the implementation backed by an embedding cache
// + recall index updater.
export interface ContentLaneReconciler {
  /**
   * Drain one source unit through the chunk → embed → recall-index
   * pipeline. Caller is responsible for honouring the embedding
   * cache (lookup by embedTextHash) and atomic source-unit
   * replacement semantics described in the design doc.
   *
   * Returns true if the source unit was successfully reconciled;
   * false on a recoverable error (caller should retry).
   */
  reconcileSourceUnit(sourceUnitId: string): Promise<boolean>;

  /**
   * Drain a tombstoned source unit. Removes its chunks from the
   * recall index and from the content-similarity revision.
   */
  reconcileTombstone(sourceUnitId: string): Promise<boolean>;
}

// Batch-level reconciliation triggers (out of scope here but enumerated
// so callers know what triggers a full re-embed pass).
export const BATCH_RECONCILE_TRIGGERS = {
  embeddingModelRevisionFlipped: 'embedding-model-revision-flipped',
  chunkerVersionFlipped: 'chunker-version-flipped',
  extractionSchemaFlipped: 'extraction-schema-flipped',
  contentSimilarityProducerVersionFlipped: 'content-similarity-producer-version-flipped',
} as const;

export type BatchReconcileTrigger =
  (typeof BATCH_RECONCILE_TRIGGERS)[keyof typeof BATCH_RECONCILE_TRIGGERS];
