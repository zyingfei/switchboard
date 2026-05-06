import {
  type AcceptedEvent,
  mergeRegister,
  type RegisterValue,
  vectorFromEvents,
  type VersionVector,
} from '../sync/causal.js';

import {
  DISPATCH_LINKED,
  DISPATCH_RECORDED,
  isDispatchLinkedPayload,
  isDispatchRecordedPayload,
  type DispatchLinkedPayload,
  type DispatchRecordedPayload,
} from './events.js';

export interface DispatchProjectionEntry {
  readonly bac_id: string;
  readonly target: { readonly provider: string };
  readonly workstreamId?: string;
  readonly createdAt: string;
  readonly body: string;
  readonly replicaId: string;
  readonly seq: number;
}

export interface DispatchLinkProjection {
  readonly dispatchId: string;
  readonly threadId?: string;
  // When two replicas link the same dispatch to different threads
  // concurrently, surface both candidates so the UI can resolve.
  readonly conflict?: readonly { readonly threadId: string; readonly replicaId: string }[];
}

export interface DispatchesProjection {
  readonly entries: readonly DispatchProjectionEntry[];
  readonly links: readonly DispatchLinkProjection[];
  readonly vector: VersionVector;
  readonly updatedAtMs: number;
}

const recordedFromPayload = (
  event: AcceptedEvent,
  payload: DispatchRecordedPayload,
): DispatchProjectionEntry => ({
  bac_id: payload.bac_id,
  target: payload.target,
  ...(payload.workstreamId === undefined ? {} : { workstreamId: payload.workstreamId }),
  createdAt: payload.createdAt,
  body: payload.body,
  replicaId: event.dot.replicaId,
  seq: event.dot.seq,
});

export const projectDispatches = (
  events: readonly AcceptedEvent[],
): DispatchesProjection => {
  const entries: DispatchProjectionEntry[] = [];
  const linksByDispatch = new Map<string, RegisterValue<DispatchLinkedPayload>[]>();
  for (const event of events) {
    if (event.type === DISPATCH_RECORDED && isDispatchRecordedPayload(event.payload)) {
      entries.push(recordedFromPayload(event, event.payload));
      continue;
    }
    if (event.type === DISPATCH_LINKED && isDispatchLinkedPayload(event.payload)) {
      const payload = event.payload;
      let bucket = linksByDispatch.get(payload.dispatchId);
      if (bucket === undefined) {
        bucket = [];
        linksByDispatch.set(payload.dispatchId, bucket);
      }
      bucket.push({ value: payload, event });
    }
  }

  // Stable order: createdAt then dot. Same input → same output.
  entries.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.replicaId !== b.replicaId) return a.replicaId < b.replicaId ? -1 : 1;
    return a.seq - b.seq;
  });

  const links: DispatchLinkProjection[] = [];
  for (const [dispatchId, candidates] of linksByDispatch.entries()) {
    const merged = mergeRegister(candidates);
    if (merged.status === 'resolved') {
      links.push({
        dispatchId,
        ...(merged.value === undefined ? {} : { threadId: merged.value.threadId }),
      });
    } else {
      links.push({
        dispatchId,
        conflict: merged.candidates.map((candidate) => ({
          threadId: candidate.value.threadId,
          replicaId: candidate.replicaId,
        })),
      });
    }
  }
  links.sort((a, b) => (a.dispatchId < b.dispatchId ? -1 : a.dispatchId > b.dispatchId ? 1 : 0));

  return {
    entries,
    links,
    vector: vectorFromEvents(events.filter((event) =>
      event.type === DISPATCH_RECORDED || event.type === DISPATCH_LINKED,
    )),
    updatedAtMs: events.reduce((max, event) => Math.max(max, event.acceptedAtMs), 0),
  };
};
