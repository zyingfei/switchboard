import {
  type AcceptedEvent,
  mergeRegister,
  type RegisterProjection,
  type RegisterValue,
  vectorFromEvents,
  type VersionVector,
} from '../sync/causal.js';

import {
  isQueueCreatedPayload,
  isQueueStatusSetPayload,
  QUEUE_CREATED,
  QUEUE_STATUS_SET,
  type QueueScope,
  type QueueStatus,
} from './events.js';

export interface QueueItemProjection {
  readonly bac_id: string;
  readonly base?: {
    readonly text: string;
    readonly scope: QueueScope;
    readonly targetId?: string;
    readonly createdBy: { readonly replicaId: string; readonly seq: number };
  };
  readonly status: RegisterProjection<QueueStatus>;
  readonly vector: VersionVector;
  readonly updatedAtMs: number;
}

export const projectQueueItem = (
  bacId: string,
  events: readonly AcceptedEvent[],
): QueueItemProjection => {
  const relevant = events.filter((event) => {
    if (event.type === QUEUE_CREATED) {
      return isQueueCreatedPayload(event.payload) && event.payload.bac_id === bacId;
    }
    if (event.type === QUEUE_STATUS_SET) {
      return isQueueStatusSetPayload(event.payload) && event.payload.bac_id === bacId;
    }
    return false;
  });
  let base: QueueItemProjection['base'];
  const statusCandidates: RegisterValue<QueueStatus>[] = [];
  for (const event of relevant) {
    if (event.type === QUEUE_CREATED && isQueueCreatedPayload(event.payload)) {
      const payload = event.payload;
      // First creation wins (deterministic by event order). The
      // route mints bac_id so concurrent creates of the same id are
      // not expected in practice.
      base ??= {
        text: payload.text,
        scope: payload.scope,
        ...(payload.targetId === undefined ? {} : { targetId: payload.targetId }),
        createdBy: { replicaId: event.dot.replicaId, seq: event.dot.seq },
      };
      if (payload.status !== undefined) {
        statusCandidates.push({ value: payload.status, event });
      }
      continue;
    }
    if (event.type === QUEUE_STATUS_SET && isQueueStatusSetPayload(event.payload)) {
      statusCandidates.push({ value: event.payload.status, event });
    }
  }
  return {
    bac_id: bacId,
    ...(base === undefined ? {} : { base }),
    status: mergeRegister(statusCandidates),
    vector: vectorFromEvents(relevant),
    updatedAtMs: relevant.reduce((max, event) => Math.max(max, event.acceptedAtMs), 0),
  };
};
