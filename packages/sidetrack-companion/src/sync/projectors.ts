import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AcceptedEvent, VersionVector } from './causal.js';
import type { EventLog } from './eventLog.js';
import type { ProjectionChangeFeed, ProjectionChangeKind } from './projectionChanges.js';
import { isReviewDraftEvent, projectReviewDraft } from '../review/projection.js';
import { deleteReviewDraft, readReviewDraft, writeReviewDraft } from '../vault/reviewDrafts.js';
import {
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
} from '../threads/events.js';
import { projectThread } from '../threads/projection.js';
import { WORKSTREAM_DELETED, WORKSTREAM_UPSERTED } from '../workstreams/events.js';
import { projectWorkstream } from '../workstreams/projection.js';
import {
  ANNOTATION_CREATED,
  ANNOTATION_DELETED,
  ANNOTATION_NOTE_SET,
} from '../annotations/events.js';
import { projectAnnotations } from '../annotations/projection.js';
import { QUEUE_CREATED, QUEUE_STATUS_SET } from '../queue/events.js';
import { projectQueueItem } from '../queue/projection.js';
import { DISPATCH_LINKED, DISPATCH_RECORDED } from '../dispatches/events.js';
import { projectDispatches } from '../dispatches/projection.js';

// Aggregate-projector dispatch for events ingested from peers.
//
// `importPeerEvent` only persists the event under the peer's
// per-replica log shard. The browser watches `_BAC/<aggregate>/`
// projection files — NOT `_BAC/log/` — so without an explicit
// projector pass, peer events would land on disk but the extension
// would never see them until a route happened to recompute the
// projection. This module closes that loop.
//
// Invariant B (registry coverage): every event type the system
// emits MUST have a registered projector entry. Adding a new event
// type without registering its projector is a sync bug — the
// coverage test in projectors.test.ts asserts every emitted event
// type appears in PROJECTOR_REGISTRY (or is a review-draft event,
// which has its own predicate-based dispatch below).

export interface RunImportProjectorsDeps {
  readonly vaultRoot: string;
  readonly eventLog: EventLog;
  readonly projectionChanges?: ProjectionChangeFeed;
}

interface ProjectorEntry {
  readonly aggregate: string;
  readonly project: (
    deps: RunImportProjectorsDeps,
    event: AcceptedEvent,
    aggregateEvents: readonly AcceptedEvent[],
  ) => Promise<void>;
}

const PROJECTOR_REGISTRY: Record<string, ProjectorEntry> = {
  [THREAD_UPSERTED]: { aggregate: 'thread', project: projectThreadAfterImport },
  [THREAD_ARCHIVED]: { aggregate: 'thread', project: projectThreadAfterImport },
  [THREAD_UNARCHIVED]: { aggregate: 'thread', project: projectThreadAfterImport },
  [THREAD_DELETED]: { aggregate: 'thread', project: projectThreadAfterImport },
  [WORKSTREAM_UPSERTED]: { aggregate: 'workstream', project: projectWorkstreamAfterImport },
  [WORKSTREAM_DELETED]: { aggregate: 'workstream', project: projectWorkstreamAfterImport },
  [ANNOTATION_CREATED]: { aggregate: 'annotation', project: projectAnnotationAfterImport },
  [ANNOTATION_NOTE_SET]: { aggregate: 'annotation', project: projectAnnotationAfterImport },
  [ANNOTATION_DELETED]: { aggregate: 'annotation', project: projectAnnotationAfterImport },
  [QUEUE_CREATED]: { aggregate: 'queue', project: projectQueueItemAfterImport },
  [QUEUE_STATUS_SET]: { aggregate: 'queue', project: projectQueueItemAfterImport },
  [DISPATCH_RECORDED]: { aggregate: 'dispatch', project: projectDispatchAfterImport },
  [DISPATCH_LINKED]: { aggregate: 'dispatch', project: projectDispatchAfterImport },
};

export const PROJECTED_EVENT_TYPES: readonly string[] = Object.keys(PROJECTOR_REGISTRY);

export const runImportProjectors = async (
  deps: RunImportProjectorsDeps,
  event: AcceptedEvent,
): Promise<void> => {
  const aggregateEvents = await deps.eventLog.readByAggregate(event.aggregateId);
  await runImportProjectorsFromEvents(deps, event, aggregateEvents);
};

export const runImportProjectorsFromEvents = async (
  deps: RunImportProjectorsDeps,
  event: AcceptedEvent,
  aggregateEvents: readonly AcceptedEvent[],
): Promise<void> => {
  if (isReviewDraftEvent(event)) {
    await projectReviewDraftAfterImport(deps, event, aggregateEvents);
    return;
  }
  const entry = PROJECTOR_REGISTRY[event.type];
  if (entry === undefined) return;
  await entry.project(deps, event, aggregateEvents);
};

interface WriteProjectionParams {
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly relDir: string;
  readonly body: unknown;
  readonly vector: VersionVector;
  readonly kind: ProjectionChangeKind;
}

const writeProjection = async (
  deps: RunImportProjectorsDeps,
  params: WriteProjectionParams,
): Promise<void> => {
  const dir = join(deps.vaultRoot, ...params.relDir.split('/'));
  await mkdir(dir, { recursive: true });
  const out = join(dir, `${params.aggregateId}.json`);
  if (params.kind === 'delete') {
    // Symmetric with vault/writer.ts's local-action delete path,
    // which unlinks the per-aggregate JSON. Without unlink here a
    // peer that observes a delete keeps a tombstoned projection
    // file on disk while the deleter has none — the two replicas'
    // _BAC/<aggregate>/ listings diverge even though the logical
    // state matches. Best-effort unlink (file may already be gone
    // on the deleter side, or a concurrent local writer may have
    // beat us to it).
    await unlink(out).catch(() => undefined);
  } else {
    await writeFile(out, JSON.stringify(params.body, null, 2), 'utf8');
  }
  await deps.projectionChanges
    ?.appendChange({
      aggregate: params.aggregate,
      aggregateId: params.aggregateId,
      relPath: `${params.relDir}/${params.aggregateId}.json`,
      vector: params.vector,
      kind: params.kind,
    })
    .catch(() => undefined);
};

async function projectThreadAfterImport(
  deps: RunImportProjectorsDeps,
  event: AcceptedEvent,
  aggregateEvents: readonly AcceptedEvent[],
): Promise<void> {
  const bacId = event.aggregateId;
  if (typeof bacId !== 'string' || bacId.length === 0) return;
  const projection = projectThread(bacId, aggregateEvents);
  await writeProjection(deps, {
    aggregate: 'thread',
    aggregateId: bacId,
    relDir: '_BAC/threads/projections',
    body: projection,
    vector: projection.vector,
    kind: projection.deleted ? 'delete' : 'upsert',
  });
}

async function projectWorkstreamAfterImport(
  deps: RunImportProjectorsDeps,
  event: AcceptedEvent,
  aggregateEvents: readonly AcceptedEvent[],
): Promise<void> {
  const bacId = event.aggregateId;
  if (typeof bacId !== 'string' || bacId.length === 0) return;
  const projection = projectWorkstream(bacId, aggregateEvents);
  await writeProjection(deps, {
    aggregate: 'workstream',
    aggregateId: bacId,
    relDir: '_BAC/workstreams/projections',
    body: projection,
    vector: projection.vector,
    kind: projection.deleted ? 'delete' : 'upsert',
  });
}

async function projectAnnotationAfterImport(
  deps: RunImportProjectorsDeps,
  event: AcceptedEvent,
  aggregateEvents: readonly AcceptedEvent[],
): Promise<void> {
  const bacId = event.aggregateId;
  if (typeof bacId !== 'string' || bacId.length === 0) return;
  const projection = projectAnnotations(aggregateEvents);
  const entry = projection.entries.find((candidate) => candidate.bac_id === bacId);
  if (entry === undefined) return;
  await writeProjection(deps, {
    aggregate: 'annotation',
    aggregateId: bacId,
    relDir: '_BAC/annotations/projections',
    body: { entry, vector: projection.vector, updatedAtMs: projection.updatedAtMs },
    vector: projection.vector,
    kind: entry.deleted ? 'delete' : 'upsert',
  });
}

async function projectQueueItemAfterImport(
  deps: RunImportProjectorsDeps,
  event: AcceptedEvent,
  aggregateEvents: readonly AcceptedEvent[],
): Promise<void> {
  const bacId = event.aggregateId;
  if (typeof bacId !== 'string' || bacId.length === 0) return;
  const projection = projectQueueItem(bacId, aggregateEvents);
  await writeProjection(deps, {
    aggregate: 'queue',
    aggregateId: bacId,
    relDir: '_BAC/queue/projections',
    body: projection,
    vector: projection.vector,
    kind: 'upsert',
  });
}

async function projectDispatchAfterImport(
  deps: RunImportProjectorsDeps,
  event: AcceptedEvent,
  aggregateEvents: readonly AcceptedEvent[],
): Promise<void> {
  const bacId = event.aggregateId;
  if (typeof bacId !== 'string' || bacId.length === 0) return;
  const projection = projectDispatches(aggregateEvents);
  const recorded = projection.entries.find((candidate) => candidate.bac_id === bacId);
  const link = projection.links.find((candidate) => candidate.dispatchId === bacId);
  if (recorded === undefined && link === undefined) return;
  await writeProjection(deps, {
    aggregate: 'dispatch',
    aggregateId: bacId,
    relDir: '_BAC/dispatches/projections',
    body: {
      ...(recorded === undefined ? {} : { entry: recorded }),
      ...(link === undefined ? {} : { link }),
      vector: projection.vector,
      updatedAtMs: projection.updatedAtMs,
    },
    vector: projection.vector,
    kind: 'upsert',
  });
}

async function projectReviewDraftAfterImport(
  deps: RunImportProjectorsDeps,
  event: AcceptedEvent,
  aggregateEvents: readonly AcceptedEvent[],
): Promise<void> {
  const threadId = event.aggregateId;
  const reviewEvents = aggregateEvents.filter((entry) => isReviewDraftEvent(entry));
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
}
