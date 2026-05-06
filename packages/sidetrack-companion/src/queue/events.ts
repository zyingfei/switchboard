// Queue-item log-event types.
//
//   queue.created — full record at creation time.
//   queue.statusSet — status sub-register update (pending → done →
//                     dismissed).
//
// Per-item is a register over (text, scope, targetId) at creation
// plus a status sub-register. Concurrent status updates surface as
// conflicts; concurrent creates of the same id are unusual (the
// HTTP route mints the bac_id) so we don't model them.

export const QUEUE_CREATED = 'queue.created' as const;
export const QUEUE_STATUS_SET = 'queue.statusSet' as const;

export type QueueEventType = typeof QUEUE_CREATED | typeof QUEUE_STATUS_SET;

export type QueueScope = 'thread' | 'workstream' | 'global';
export type QueueStatus = 'pending' | 'done' | 'dismissed';

export interface QueueCreatedPayload {
  readonly bac_id: string;
  readonly text: string;
  readonly scope: QueueScope;
  readonly targetId?: string;
  readonly status?: QueueStatus;
}

export interface QueueStatusSetPayload {
  readonly bac_id: string;
  readonly status: QueueStatus;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const isQueueCreatedPayload = (
  value: unknown,
): value is QueueCreatedPayload =>
  isRecord(value) &&
  typeof value['bac_id'] === 'string' &&
  typeof value['text'] === 'string' &&
  typeof value['scope'] === 'string';

export const isQueueStatusSetPayload = (
  value: unknown,
): value is QueueStatusSetPayload =>
  isRecord(value) &&
  typeof value['bac_id'] === 'string' &&
  (value['status'] === 'pending' || value['status'] === 'done' || value['status'] === 'dismissed');
