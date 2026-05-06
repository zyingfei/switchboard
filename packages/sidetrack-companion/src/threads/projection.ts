import {
  type AcceptedEvent,
  eventDominates,
  mergeRegister,
  type RegisterProjection,
  type RegisterValue,
  vectorFromEvents,
  type VersionVector,
} from '../sync/causal.js';

import {
  isThreadStatusPayload,
  isThreadUpsertedPayload,
  THREAD_ARCHIVED,
  THREAD_DELETED,
  THREAD_UNARCHIVED,
  THREAD_UPSERTED,
  type ThreadStatus,
  type ThreadTrackingMode,
  type ThreadUpsertedPayload,
} from './events.js';

// Thread projection. The base record (provider, threadUrl, title,
// tags, primaryWorkstreamId, trackingMode, lastSeenAt) is a single
// causal register over `thread.upserted` events. Status is a
// separate register so an archive/unarchive doesn't disturb the
// main fields, and vice versa.
//
// `deleted: true` short-circuits to the tombstoned state. A later
// `thread.upserted` whose deps cover the delete event revives the
// thread (same semantics as `review-draft.discarded`).

export interface ThreadProjectionRecord {
  readonly bac_id: string;
  readonly provider: string;
  readonly threadUrl: string;
  readonly title: string;
  readonly lastSeenAt: string;
  readonly tags: readonly string[];
  readonly primaryWorkstreamId?: string;
  readonly trackingMode?: ThreadTrackingMode;
}

export interface ThreadProjection {
  readonly bac_id: string;
  readonly record: RegisterProjection<ThreadProjectionRecord>;
  readonly status: RegisterProjection<ThreadStatus>;
  readonly deleted: boolean;
  readonly vector: VersionVector;
  readonly updatedAtMs: number;
}

const isRelevant = (event: AcceptedEvent, bacId: string): boolean => {
  if (event.type === THREAD_UPSERTED) {
    return isThreadUpsertedPayload(event.payload) && event.payload.bac_id === bacId;
  }
  if (
    event.type === THREAD_ARCHIVED ||
    event.type === THREAD_UNARCHIVED ||
    event.type === THREAD_DELETED
  ) {
    return isThreadStatusPayload(event.payload) && event.payload.bac_id === bacId;
  }
  return false;
};

const recordFromUpsert = (payload: ThreadUpsertedPayload): ThreadProjectionRecord => ({
  bac_id: payload.bac_id,
  provider: payload.provider,
  threadUrl: payload.threadUrl,
  title: payload.title,
  lastSeenAt: payload.lastSeenAt,
  tags: payload.tags ?? [],
  ...(payload.primaryWorkstreamId === undefined
    ? {}
    : { primaryWorkstreamId: payload.primaryWorkstreamId }),
  ...(payload.trackingMode === undefined ? {} : { trackingMode: payload.trackingMode }),
});

export const projectThread = (
  bacId: string,
  events: readonly AcceptedEvent[],
): ThreadProjection => {
  const relevant = events.filter((event) => isRelevant(event, bacId));
  const upsertCandidates: RegisterValue<ThreadProjectionRecord>[] = [];
  const statusCandidates: RegisterValue<ThreadStatus>[] = [];
  const deletes: AcceptedEvent[] = [];

  for (const event of relevant) {
    if (event.type === THREAD_UPSERTED && isThreadUpsertedPayload(event.payload)) {
      upsertCandidates.push({ value: recordFromUpsert(event.payload), event });
      // Each upsert can also carry an explicit status. Surface that
      // as a status-register candidate so a peer's later archive
      // doesn't lose to an upsert that arrived without observing it.
      if (event.payload.status !== undefined) {
        statusCandidates.push({ value: event.payload.status, event });
      }
      continue;
    }
    if (event.type === THREAD_ARCHIVED) {
      statusCandidates.push({ value: 'archived', event });
      continue;
    }
    if (event.type === THREAD_UNARCHIVED) {
      statusCandidates.push({ value: 'tracked', event });
      continue;
    }
    if (event.type === THREAD_DELETED) {
      deletes.push(event);
      continue;
    }
  }

  // A delete wins only over events it causally observed. Concurrent
  // later upserts revive the thread.
  const isErased = (event: AcceptedEvent): boolean =>
    deletes.some((tombstone) => eventDominates(tombstone, event));

  const liveUpserts = upsertCandidates.filter((candidate) => !isErased(candidate.event));
  const liveStatus = statusCandidates.filter((candidate) => !isErased(candidate.event));

  const record = mergeRegister(liveUpserts);
  const status = mergeRegister(liveStatus);
  const deleted =
    deletes.length > 0 &&
    record.status === 'resolved' &&
    record.value === undefined &&
    status.status === 'resolved' &&
    status.value === undefined;

  const lastEventMs = relevant.reduce(
    (latest, event) => Math.max(latest, event.acceptedAtMs),
    0,
  );

  return {
    bac_id: bacId,
    record,
    status,
    deleted,
    vector: vectorFromEvents(relevant),
    updatedAtMs: lastEventMs,
  };
};
