import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AcceptedEvent } from './causal.js';
import type { EventLog } from './eventLog.js';
import type { ProjectionChangeFeed } from './projectionChanges.js';
import { isReviewDraftEvent, projectReviewDraft } from '../review/projection.js';
import { deleteReviewDraft, readReviewDraft, writeReviewDraft } from '../vault/reviewDrafts.js';
import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
} from '../threads/events.js';
import { projectThread } from '../threads/projection.js';

// Aggregate-projector dispatch for events ingested from peers.
//
// `importPeerEvent` only persists the event under the peer's
// per-replica log shard. The browser watches `_BAC/review-drafts/`
// + `_BAC/threads/` and aggregate projection files — NOT `_BAC/log/`
// — so without an explicit projector pass, peer events would land
// on disk but the extension would never see them until a route
// happened to recompute the projection. This module closes that
// loop.
//
// Dispatched today:
//   - review-draft.* — full projector, writes/deletes _BAC/review-drafts/<id>.json
//   - thread.{upserted,archived,unarchived,deleted} — minimal
//     projector that writes _BAC/threads/<bacId>.json so the
//     vault-changes SSE fires and the receiving extension's F9
//     subscription picks it up. The contents are the collapsed
//     ThreadProjection record (computed via projectThread) so the
//     file is also a valid read source for projection-aware
//     callers.
//
// capture/tombstone/queue/dispatch/annotation/workstream
// projections remain on-demand via `/v1/.../projection` since
// they don't need cross-browser real-time UI updates yet.

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
    return;
  }
  if (
    event.type === THREAD_UPSERTED ||
    event.type === THREAD_ARCHIVED ||
    event.type === THREAD_UNARCHIVED ||
    event.type === THREAD_DELETED
  ) {
    await projectThreadAfterImport(deps, event);
    return;
  }
  // Workstreams, queue, dispatches, annotations are read on-demand
  // via `/v1/.../projection`; nothing to do here. Recall tombstones
  // land in the index via the next rebuild.
};

const projectThreadAfterImport = async (
  deps: RunImportProjectorsDeps,
  event: AcceptedEvent,
): Promise<void> => {
  const bacId = event.aggregateId;
  if (typeof bacId !== 'string' || bacId.length === 0) return;
  const merged = await deps.eventLog.readByAggregate(bacId);
  const projection = projectThread(bacId, merged);
  // Write the projection to `_BAC/threads/<bacId>.json` so the
  // vault-changes SSE fires for subscribers (the extension's F9
  // listener at the receiving browser, plus any on-disk consumers
  // — markdown sidecar, search indexers, etc.). The full route
  // handler (vault/writer.ts:upsertThread) writes additional
  // bookkeeping (markdown sidecar, lock sentinel, audit) that we
  // skip here — those are local-action concerns, not peer-import
  // concerns. The file written here is the projection record;
  // matches what /v1/threads/<id>/projection returns.
  const dir = join(deps.vaultRoot, '_BAC', 'threads');
  await mkdir(dir, { recursive: true });
  const out = `${dir}/${bacId}.json`;
  await writeFile(out, JSON.stringify(projection, null, 2), 'utf8');
  await deps.projectionChanges
    ?.appendChange({
      aggregate: 'thread',
      aggregateId: bacId,
      relPath: `_BAC/threads/${bacId}.json`,
      vector: projection.vector,
      kind: projection.deleted ? 'delete' : 'upsert',
    })
    .catch(() => undefined);
};

const projectReviewDraftAfterImport = async (
  deps: RunImportProjectorsDeps,
  event: AcceptedEvent,
): Promise<void> => {
  const threadId = event.aggregateId;
  const merged = await deps.eventLog.readByAggregate(threadId);
  const reviewEvents = merged.filter((entry) => isReviewDraftEvent(entry));
  const existing = await readReviewDraft(deps.vaultRoot, threadId);
  const threadUrl = existing?.threadUrl ?? event.target?.canonicalUrl ?? '';
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
