import type { SerializedAnchor } from '../http/schemas.js';
export type RepeatedTermPolicy = 'first' | 'require_hint';
export interface AnchorPolicy {
    readonly repeatedTerm?: RepeatedTermPolicy;
    readonly shortTermMinLength?: number;
}
export type AnchorBuilderFailureReason = 'term_not_found' | 'short_term_requires_selection_hint' | 'ambiguous_term_requires_selection_hint' | 'invalid_ordinal' | 'selection_hint_no_match' | 'thread_not_found' | 'thread_url_unresolved' | 'no_assistant_turns';
export interface AnchorBuilderInput {
    readonly turnText: string;
    readonly term: string;
    readonly selectionHint?: string;
    readonly policy?: AnchorPolicy;
}
export interface AnchorBuilderOk {
    readonly ok: true;
    readonly anchor: SerializedAnchor;
    readonly occurrenceCount: number;
}
export interface AnchorBuilderFailure {
    readonly ok: false;
    readonly reason: AnchorBuilderFailureReason;
    readonly message: string;
    readonly occurrenceCount: number;
    readonly suggestedSelectionHints?: readonly string[];
}
export type AnchorBuilderResult = AnchorBuilderOk | AnchorBuilderFailure;
export declare class AnchorBuilderError extends Error {
    readonly reason: AnchorBuilderFailureReason;
    readonly occurrenceCount: number;
    readonly suggestedSelectionHints?: readonly string[] | undefined;
    constructor(reason: AnchorBuilderFailureReason, message: string, occurrenceCount?: number, suggestedSelectionHints?: readonly string[] | undefined);
}
export declare const buildAnchorFromTerm: (input: AnchorBuilderInput) => AnchorBuilderResult;
//# sourceMappingURL=anchorBuilder.d.ts.map