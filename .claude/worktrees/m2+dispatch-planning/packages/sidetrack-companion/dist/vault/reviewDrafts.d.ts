import type { ReviewDraftProjection } from '../review/projection.js';
export declare const writeReviewDraft: (vaultRoot: string, threadId: string, projection: ReviewDraftProjection) => Promise<void>;
export declare const readReviewDraft: (vaultRoot: string, threadId: string) => Promise<ReviewDraftProjection | null>;
export declare const deleteReviewDraft: (vaultRoot: string, threadId: string) => Promise<void>;
export interface ReviewDraftSummary {
    readonly threadId: string;
    readonly updatedAtMs: number;
    readonly vector: Readonly<Record<string, number>>;
}
export declare const listReviewDrafts: (vaultRoot: string, sinceMs?: number | null) => Promise<readonly ReviewDraftSummary[]>;
//# sourceMappingURL=reviewDrafts.d.ts.map