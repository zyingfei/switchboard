import type { AcceptedEvent } from './causal.js';
import type { EventLog } from './eventLog.js';
import type { ProjectionChangeFeed } from './projectionChanges.js';
import { isReviewDraftEvent, projectReviewDraft } from '../review/projection.js';
import {
  deleteReviewDraft,
  readReviewDraft,
  writeReviewDraft,
} from '../vault/reviewDrafts.js';

// Aggregate-projector dispatch for events ingested from peers.
//
// `importPeerEvent` only persists the event under the peer's
// per-replica log shard. The browser watches `_BAC/review-drafts/`
// and aggregate projection files — NOT `_BAC/log/` — so without an
// explicit projector pass, peer events would land on disk but the
// extension would never see them until a route happened to recompute
// the projection. This module closes that loop.
//
// Today it dispatches review-draft events; capture/tombstone/threads
// projections are computed on-demand via `/v1/.../projection` so the
// file-based feed isn't load-bearing for them. Adding more projectors
// here is a matter of mapping the event type to a recompute function.

export interface RunImportProjectorsDeps {
  readonly vaultRoot: string;
  readonly eventLog: EventLog;
  readonly projectionChanges?: ProjectionChangeFeed;
}

export const runImportProjectors = async (
  deps: RunImportProjectorsDeps,
  event: AcceptedEvent,
): Promise<void> => {
  if (isReviewDraftEvent(event)) {
    await projectReviewDraftAfterImport(deps, event);
  }
  // Threads, workstreams, queue, dispatches, annotations are read
  // on-demand via `/v1/.../projection`; nothing to do here. Recall
  // tombstones land in the index via the next rebuild.
};

const projectReviewDraftAfterImport = async (
  deps: RunImportProjectorsDeps,
  event: AcceptedEvent,
): Promise<void> => {
  const threadId = event.aggregateId;
  const merged = await deps.eventLog.readByAggregate(threadId);
  const reviewEvents = merged.filter((entry) => isReviewDraftEvent(entry));
  const existing = await readReviewDraft(deps.vaultRoot, threadId);
  const threadUrl = existing?.threadUrl ?? '';
  const projection = projectReviewDraft(threadId, threadUrl, reviewEvents);
  if (projection.discarded) {
    await deleteReviewDraft(deps.vaultRoot, threadId);
  } else {
    await writeReviewDraft(deps.vaultRoot, threadId, projection);
  }
  await deps.projectionChanges
    ?.appendChange({
      aggregate: 'review-draft',
      aggregateId: threadId,
      relPath: `_BAC/review-drafts/${threadId}.json`,
      vector: projection.vector,
      kind: projection.discarded ? 'delete' : 'upsert',
    })
    .catch(() => undefined);
};
