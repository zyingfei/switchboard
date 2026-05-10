// Annotation log-event types.
//
// Annotations are write-once-with-soft-delete:
//   annotation.created  — new annotation (anchor + url + note).
//   annotation.noteSet  — register update for the note text.
//   annotation.deleted  — soft-delete tombstone.
//
// The projection emits a non-deleted set; the note text is a causal
// register so concurrent edits surface as conflicts.
export const ANNOTATION_CREATED = 'annotation.created';
export const ANNOTATION_NOTE_SET = 'annotation.noteSet';
export const ANNOTATION_DELETED = 'annotation.deleted';
const isRecord = (value) => typeof value === 'object' && value !== null;
const isAnchor = (value) => {
    if (!isRecord(value))
        return false;
    const tq = value['textQuote'];
    const tp = value['textPosition'];
    return (isRecord(tq) &&
        isRecord(tp) &&
        typeof tq['exact'] === 'string' &&
        typeof tq['prefix'] === 'string' &&
        typeof tq['suffix'] === 'string' &&
        typeof tp['start'] === 'number' &&
        typeof tp['end'] === 'number' &&
        typeof value['cssSelector'] === 'string');
};
export const isAnnotationCreatedPayload = (value) => isRecord(value) &&
    typeof value['bac_id'] === 'string' &&
    typeof value['url'] === 'string' &&
    typeof value['note'] === 'string' &&
    isAnchor(value['anchor']);
export const isAnnotationNoteSetPayload = (value) => isRecord(value) && typeof value['bac_id'] === 'string' && typeof value['note'] === 'string';
export const isAnnotationDeletedPayload = (value) => isRecord(value) && typeof value['bac_id'] === 'string';
//# sourceMappingURL=events.js.map