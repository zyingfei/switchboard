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
  ANNOTATION_CREATED,
  ANNOTATION_DELETED,
  ANNOTATION_NOTE_SET,
  isAnnotationCreatedPayload,
  isAnnotationDeletedPayload,
  isAnnotationNoteSetPayload,
  type SerializedAnchor,
} from './events.js';

export interface AnnotationProjectionEntry {
  readonly bac_id: string;
  readonly url: string;
  readonly anchor: SerializedAnchor;
  readonly note: RegisterProjection<string>;
  readonly pageTitle?: string;
  readonly deleted: boolean;
  readonly createdBy: { readonly replicaId: string; readonly seq: number };
}

export interface AnnotationsProjection {
  readonly entries: readonly AnnotationProjectionEntry[];
  readonly vector: VersionVector;
  readonly updatedAtMs: number;
}

interface PerAnnotation {
  bac_id: string;
  createdEvent?: AcceptedEvent;
  noteCandidates: RegisterValue<string>[];
  deletes: AcceptedEvent[];
}

const ensure = (map: Map<string, PerAnnotation>, bacId: string): PerAnnotation => {
  let entry = map.get(bacId);
  if (entry === undefined) {
    entry = { bac_id: bacId, noteCandidates: [], deletes: [] };
    map.set(bacId, entry);
  }
  return entry;
};

export const projectAnnotations = (
  events: readonly AcceptedEvent[],
): AnnotationsProjection => {
  const byId = new Map<string, PerAnnotation>();
  const relevantEvents: AcceptedEvent[] = [];
  for (const event of events) {
    if (event.type === ANNOTATION_CREATED && isAnnotationCreatedPayload(event.payload)) {
      const entry = ensure(byId, event.payload.bac_id);
      entry.createdEvent = event;
      entry.noteCandidates.push({ value: event.payload.note, event });
      relevantEvents.push(event);
      continue;
    }
    if (event.type === ANNOTATION_NOTE_SET && isAnnotationNoteSetPayload(event.payload)) {
      const entry = ensure(byId, event.payload.bac_id);
      entry.noteCandidates.push({ value: event.payload.note, event });
      relevantEvents.push(event);
      continue;
    }
    if (event.type === ANNOTATION_DELETED && isAnnotationDeletedPayload(event.payload)) {
      const entry = ensure(byId, event.payload.bac_id);
      entry.deletes.push(event);
      relevantEvents.push(event);
    }
  }

  const projected: AnnotationProjectionEntry[] = [];
  for (const entry of byId.values()) {
    if (entry.createdEvent === undefined || !isAnnotationCreatedPayload(entry.createdEvent.payload)) {
      continue;
    }
    const created = entry.createdEvent.payload;
    const isErased = (event: AcceptedEvent): boolean =>
      entry.deletes.some((tombstone) => eventDominates(tombstone, event));
    const liveNotes = entry.noteCandidates.filter((candidate) => !isErased(candidate.event));
    const note = mergeRegister(liveNotes);
    const fullyDeleted = entry.deletes.length > 0 && liveNotes.length === 0;
    projected.push({
      bac_id: entry.bac_id,
      url: created.url,
      anchor: created.anchor,
      note,
      ...(created.pageTitle === undefined ? {} : { pageTitle: created.pageTitle }),
      deleted: fullyDeleted,
      createdBy: {
        replicaId: entry.createdEvent.dot.replicaId,
        seq: entry.createdEvent.dot.seq,
      },
    });
  }
  projected.sort((a, b) => (a.bac_id < b.bac_id ? -1 : a.bac_id > b.bac_id ? 1 : 0));

  return {
    entries: projected,
    vector: vectorFromEvents(relevantEvents),
    updatedAtMs: relevantEvents.reduce((max, event) => Math.max(max, event.acceptedAtMs), 0),
  };
};
