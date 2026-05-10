import { type AcceptedEvent, type Dot, type RegisterProjection, type VersionVector } from '../sync/causal.js';
export type ReviewVerdict = 'agree' | 'disagree' | 'partial' | 'needs_source' | 'open';
export interface ReviewProjectionAnchor {
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
export interface ReviewProjectionSpan {
    readonly spanId: string;
    readonly quote: string;
    readonly anchor: ReviewProjectionAnchor;
    readonly comment: RegisterProjection<string>;
    readonly capturedAt: string;
    readonly addDots: readonly Dot[];
    readonly removeDots: readonly Dot[];
}
export interface ReviewDraftProjection {
    readonly threadId: string;
    readonly threadUrl: string;
    readonly vector: VersionVector;
    readonly spans: readonly ReviewProjectionSpan[];
    readonly overall: RegisterProjection<string>;
    readonly verdict: RegisterProjection<ReviewVerdict>;
    readonly tombstones: {
        readonly spanIds: readonly string[];
    };
    readonly discarded: boolean;
    readonly updatedAtMs: number;
}
export declare const REVIEW_DRAFT_EVENT_TYPES: readonly ["review-draft.span.added", "review-draft.span.removed", "review-draft.comment.set", "review-draft.overall.set", "review-draft.verdict.set", "review-draft.discarded"];
export type ReviewDraftEventType = (typeof REVIEW_DRAFT_EVENT_TYPES)[number];
export declare const isReviewDraftEvent: (event: AcceptedEvent) => boolean;
export declare const projectReviewDraft: (threadId: string, threadUrl: string, events: readonly AcceptedEvent[]) => ReviewDraftProjection;
//# sourceMappingURL=projection.d.ts.map