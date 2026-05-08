export interface CollectorEvent<T = unknown> {
  readonly collector_id: string;
  readonly event_type: string;
  readonly payload_version: number;
  readonly emitted_at: string;
  readonly collector_version: string;
  readonly collector_run_id: string;
  readonly source_record_id?: string;
  readonly payload: T;
  readonly dimensions?: Record<string, unknown>;
}

export type PayloadVersionStatus = 'current' | 'accepted' | 'quarantine-only';

export type QuarantineReason =
  | 'payload-version-too-new'
  | 'materializer-validation-failed'
  | 'privacy-gate-denied'
  | 'manifest-not-loaded'
  | 'upcaster-threw'
  | 'unknown-collector-id'
  | 'unknown-event-type';

export type DropReason = never; // unused in MVP

export type PromotionResult<E = unknown> =
  | { kind: 'promoted'; events: readonly E[] }
  | { kind: 'quarantined'; reason: QuarantineReason; line: CollectorEvent }
  | { kind: 'deduped'; original_class_a_id: string }
  | { kind: 'dropped'; reason: DropReason };
