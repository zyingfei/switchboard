export declare const ANNOTATION_CREATED: "annotation.created";
export declare const ANNOTATION_NOTE_SET: "annotation.noteSet";
export declare const ANNOTATION_DELETED: "annotation.deleted";
export type AnnotationEventType = typeof ANNOTATION_CREATED | typeof ANNOTATION_NOTE_SET | typeof ANNOTATION_DELETED;
export interface SerializedAnchor {
    readonly textQuote: {
        readonly exact: string;
        readonly prefix: string;
        readonly suffix: string;
    };
    readonly textPosition: {
        readonly start: number;
        readonly end: number;
    };
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
export declare const isAnnotationCreatedPayload: (value: unknown) => value is AnnotationCreatedPayload;
export declare const isAnnotationNoteSetPayload: (value: unknown) => value is AnnotationNoteSetPayload;
export declare const isAnnotationDeletedPayload: (value: unknown) => value is AnnotationDeletedPayload;
//# sourceMappingURL=events.d.ts.map