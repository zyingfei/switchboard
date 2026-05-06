// Workstream log-event types.
//
//   workstream.upserted — register write of the whole record
//                          (created + updated collapse to one
//                          event type since both replace fields).
//   workstream.deleted  — tombstone. Concurrent later upserts
//                          revive (matches thread + review-draft
//                          discard semantics).

export const WORKSTREAM_UPSERTED = 'workstream.upserted' as const;
export const WORKSTREAM_DELETED = 'workstream.deleted' as const;

export type WorkstreamEventType =
  | typeof WORKSTREAM_UPSERTED
  | typeof WORKSTREAM_DELETED;

export type WorkstreamPrivacy = 'private' | 'shared' | 'public';

export interface WorkstreamChecklistItem {
  readonly id: string;
  readonly text: string;
  readonly checked: boolean;
}

export interface WorkstreamUpsertedPayload {
  readonly bac_id: string;
  readonly title: string;
  readonly parentId?: string;
  readonly privacy?: WorkstreamPrivacy;
  readonly screenShareSensitive?: boolean;
  readonly tags?: readonly string[];
  readonly children?: readonly string[];
  readonly checklist?: readonly WorkstreamChecklistItem[];
  readonly description?: string;
}

export interface WorkstreamDeletedPayload {
  readonly bac_id: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const isWorkstreamUpsertedPayload = (
  value: unknown,
): value is WorkstreamUpsertedPayload =>
  isRecord(value) && typeof value['bac_id'] === 'string' && typeof value['title'] === 'string';

export const isWorkstreamDeletedPayload = (
  value: unknown,
): value is WorkstreamDeletedPayload =>
  isRecord(value) && typeof value['bac_id'] === 'string';
