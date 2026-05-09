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
  | 'unknown-event-type'
  | 'line-too-large';

// Safety caps on collector lines (Blocker 5).
// Raw lines exceeding this size never reach JSON.parse — they are
// quarantined with reason 'line-too-large' and audited via
// 'collector:line-too-large'. 1 MiB is the per-line ceiling; anything
// larger almost certainly indicates a malformed file (binary garbage,
// missing newlines) and should not consume parser memory.
export const MAX_RAW_LINE_BYTES = 1 * 1024 * 1024;

// Quarantine entries also have a per-entry size cap. The raw_line is
// truncated to this size when stored; the line_hash still hashes the
// original full bytes so dedup remains correct.
export const MAX_QUARANTINE_RAW_BYTES = 2 * 1024 * 1024;

export type DropReason = never; // unused in MVP

export type PromotionResult<E = unknown> =
  | { kind: 'promoted'; events: readonly E[] }
  | { kind: 'quarantined'; reason: QuarantineReason; line: CollectorEvent }
  | { kind: 'deduped'; original_class_a_id: string }
  | { kind: 'dropped'; reason: DropReason };
