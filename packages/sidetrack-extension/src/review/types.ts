import type { ProviderId } from '../companion/model';
import type { SerializedAnchor } from '../annotation/anchors';

export type ReviewVerdict = 'agree' | 'disagree' | 'partial' | 'needs_source' | 'open';
export type ReviewOutcome = 'save' | 'submit_back' | 'dispatch_out';

export interface ReviewEventSpanInput {
  readonly id: string;
  readonly text: string;
  readonly comment: string;
  readonly capturedAt?: string;
}

// Inline-review draft span anchored to a selection on the chat page.
// Captured by the content script; stored locally per thread until the
// user sends or discards the draft. The anchor is the standard text-
// quote/text-position fingerprint from src/annotation/anchors.ts so a
// span can be re-located if the page DOM mutates between capture and
// review.
export interface ReviewDraftSpan {
  readonly bac_id: string;
  readonly threadUrl: string;
  readonly anchor: SerializedAnchor;
  // The exact text that was selected when the comment was made.
  // Persisted separately so the draft footer can quote the span even
  // if the page anchor later fails to resolve.
  readonly quote: string;
  readonly comment: string;
  readonly capturedAt: string;
}

// Conflict surface from the companion's causal projection. Each
// register that came back as `status: 'conflict'` shows its
// candidate values here so the side panel can render a picker. The
// user's resolution choice mints a normal ClientEvent — its
// `baseVector` covers all candidates so the projection collapses
// back to `resolved` everywhere.
export interface ReviewDraftConflicts {
  readonly overall?: { readonly candidates: readonly string[] };
  readonly verdict?: { readonly candidates: readonly ReviewVerdict[] };
  readonly comments?: Readonly<Partial<Record<string, { readonly candidates: readonly string[] }>>>;
}

export interface ReviewDraft {
  readonly threadId: string;
  readonly threadUrl: string;
  readonly spans: readonly ReviewDraftSpan[];
  readonly overall?: string;
  readonly verdict?: ReviewVerdict;
  readonly updatedAt: string;
  readonly conflicts?: ReviewDraftConflicts;
}

export interface ReviewEventInput {
  readonly bac_id?: string;
  readonly sourceThreadId: string;
  readonly sourceTurnOrdinal: number;
  readonly provider: ProviderId;
  readonly verdict: ReviewVerdict;
  readonly reviewerNote: string;
  readonly spans: readonly ReviewEventSpanInput[];
  readonly outcome: ReviewOutcome;
  readonly createdAt?: string;
}

export interface ReviewEventRecord {
  readonly bac_id: string;
  readonly sourceThreadId: string;
  readonly sourceTurnOrdinal: number;
  readonly provider: ProviderId;
  readonly verdict: ReviewVerdict;
  readonly reviewerNote: string;
  readonly spans: readonly ReviewEventSpanInput[];
  readonly outcome: ReviewOutcome;
  readonly createdAt: string;
}

export interface ReviewSubmitResult {
  readonly bac_id: string;
  readonly status: 'recorded';
}
