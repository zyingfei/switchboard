// Annotation log-event types.
//
// Annotations are write-once-with-soft-delete:
//   annotation.created  — new annotation (anchor + url + note).
//   annotation.noteSet  — register update for the note text.
//   annotation.deleted  — soft-delete tombstone.
//
// The projection emits a non-deleted set; the note text is a causal
// register so concurrent edits surface as conflicts.

export const ANNOTATION_CREATED = 'annotation.created' as const;
export const ANNOTATION_NOTE_SET = 'annotation.noteSet' as const;
export const ANNOTATION_DELETED = 'annotation.deleted' as const;

export type AnnotationEventType =
  | typeof ANNOTATION_CREATED
  | typeof ANNOTATION_NOTE_SET
  | typeof ANNOTATION_DELETED;

export interface SerializedAnchor {
  readonly textQuote: { readonly exact: string; readonly prefix: string; readonly suffix: string };
  readonly textPosition: { readonly start: number; readonly end: number };
  readonly cssSelector: string;
}

export interface AnnotationCreatedPayload {
  readonly bac_id: string;
  readonly url: string;
  readonly anchor: SerializedAnchor;
  readonly note: string;
  readonly pageTitle?: string;
}

export interface AnnotationNoteSetPayload {
  readonly bac_id: string;
  readonly note: string;
}

export interface AnnotationDeletedPayload {
  readonly bac_id: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isAnchor = (value: unknown): value is SerializedAnchor => {
  if (!isRecord(value)) return false;
  const tq = value['textQuote'];
  const tp = value['textPosition'];
  return (
    isRecord(tq) &&
    isRecord(tp) &&
    typeof tq['exact'] === 'string' &&
    typeof tq['prefix'] === 'string' &&
    typeof tq['suffix'] === 'string' &&
    typeof tp['start'] === 'number' &&
    typeof tp['end'] === 'number' &&
    typeof value['cssSelector'] === 'string'
  );
};

export const isAnnotationCreatedPayload = (
  value: unknown,
): value is AnnotationCreatedPayload =>
  isRecord(value) &&
  typeof value['bac_id'] === 'string' &&
  typeof value['url'] === 'string' &&
  typeof value['note'] === 'string' &&
  isAnchor(value['anchor']);

export const isAnnotationNoteSetPayload = (
  value: unknown,
): value is AnnotationNoteSetPayload =>
  isRecord(value) && typeof value['bac_id'] === 'string' && typeof value['note'] === 'string';

export const isAnnotationDeletedPayload = (
  value: unknown,
): value is AnnotationDeletedPayload =>
  isRecord(value) && typeof value['bac_id'] === 'string';
