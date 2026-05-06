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
  isWorkstreamDeletedPayload,
  isWorkstreamUpsertedPayload,
  WORKSTREAM_DELETED,
  WORKSTREAM_UPSERTED,
  type WorkstreamChecklistItem,
  type WorkstreamPrivacy,
  type WorkstreamUpsertedPayload,
} from './events.js';

export interface WorkstreamProjectionRecord {
  readonly bac_id: string;
  readonly title: string;
  readonly parentId?: string;
  readonly privacy?: WorkstreamPrivacy;
  readonly screenShareSensitive?: boolean;
  readonly tags: readonly string[];
  readonly children: readonly string[];
  readonly checklist: readonly WorkstreamChecklistItem[];
  readonly description?: string;
}

export interface WorkstreamProjection {
  readonly bac_id: string;
  readonly record: RegisterProjection<WorkstreamProjectionRecord>;
  readonly deleted: boolean;
  readonly vector: VersionVector;
  readonly updatedAtMs: number;
}

const recordFromUpsert = (payload: WorkstreamUpsertedPayload): WorkstreamProjectionRecord => ({
  bac_id: payload.bac_id,
  title: payload.title,
  ...(payload.parentId === undefined ? {} : { parentId: payload.parentId }),
  ...(payload.privacy === undefined ? {} : { privacy: payload.privacy }),
  ...(payload.screenShareSensitive === undefined
    ? {}
    : { screenShareSensitive: payload.screenShareSensitive }),
  tags: payload.tags ?? [],
  children: payload.children ?? [],
  checklist: payload.checklist ?? [],
  ...(payload.description === undefined ? {} : { description: payload.description }),
});

const isRelevant = (event: AcceptedEvent, bacId: string): boolean => {
  if (event.type === WORKSTREAM_UPSERTED) {
    return isWorkstreamUpsertedPayload(event.payload) && event.payload.bac_id === bacId;
  }
  if (event.type === WORKSTREAM_DELETED) {
    return isWorkstreamDeletedPayload(event.payload) && event.payload.bac_id === bacId;
  }
  return false;
};

export const projectWorkstream = (
  bacId: string,
  events: readonly AcceptedEvent[],
): WorkstreamProjection => {
  const relevant = events.filter((event) => isRelevant(event, bacId));
  const upsertCandidates: RegisterValue<WorkstreamProjectionRecord>[] = [];
  const deletes: AcceptedEvent[] = [];
  for (const event of relevant) {
    if (event.type === WORKSTREAM_UPSERTED && isWorkstreamUpsertedPayload(event.payload)) {
      upsertCandidates.push({ value: recordFromUpsert(event.payload), event });
      continue;
    }
    if (event.type === WORKSTREAM_DELETED) {
      deletes.push(event);
    }
  }
  const isErased = (event: AcceptedEvent): boolean =>
    deletes.some((tombstone) => eventDominates(tombstone, event));
  const live = upsertCandidates.filter((candidate) => !isErased(candidate.event));
  const record = mergeRegister(live);
  const deleted =
    deletes.length > 0 && record.status === 'resolved' && record.value === undefined;
  const lastEventMs = relevant.reduce(
    (latest, event) => Math.max(latest, event.acceptedAtMs),
    0,
  );
  return {
    bac_id: bacId,
    record,
    deleted,
    vector: vectorFromEvents(relevant),
    updatedAtMs: lastEventMs,
  };
};
