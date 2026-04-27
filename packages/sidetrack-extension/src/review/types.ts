import type { ProviderId } from '../companion/model';

export type ReviewVerdict = 'agree' | 'disagree' | 'partial' | 'needs_source' | 'open';
export type ReviewOutcome = 'save' | 'submit_back' | 'dispatch_out';

export interface ReviewEventSpanInput {
  readonly id: string;
  readonly text: string;
  readonly comment: string;
  readonly capturedAt?: string;
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
