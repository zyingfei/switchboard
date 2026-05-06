import {
  baseOutboxItemShape,
  createOutbox,
  type OutboxItem,
  type OutboxStorage,
} from '../companion/outbox';

import type { ReviewDraftClientEvent } from './draftClient';

// Per-thread queue of review-draft client events bound for the
// companion. The browser appends to chrome.storage immediately so the
// side panel sees the change without waiting for the network. Each
// queued ClientEvent already carries a `clientEventId` (UUID) — the
// outbox does NOT mint a separate id, so retries hit the companion's
// idempotency cache and resolve to the same AcceptedEvent.
//
// User-authored content: the queue uses `reject-when-full` overflow
// so a full queue surfaces an error rather than silently dropping a
// comment. The cap is sized for multi-day offline windows (10000) so
// rejection is a defensive backstop, not a normal occurrence.

export interface QueuedReviewDraftEvent {
  readonly threadId: string;
  readonly threadUrl: string;
  readonly event: ReviewDraftClientEvent;
}

const REVIEW_DRAFT_QUEUE_KEY = 'sidetrack.outbox.reviewDrafts';
const REVIEW_DRAFT_DROPPED_KEY = 'sidetrack.outbox.reviewDrafts.droppedCount';
const REVIEW_DRAFT_QUEUE_LIMIT = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isQueuedReviewEvent = (value: unknown): value is QueuedReviewDraftEvent => {
  if (!isRecord(value)) return false;
  if (typeof value.threadId !== 'string' || typeof value.threadUrl !== 'string') {
    return false;
  }
  const event = value.event;
  if (!isRecord(event)) return false;
  return (
    typeof event.clientEventId === 'string' &&
    typeof event.type === 'string' &&
    event.type.startsWith('review-draft.') &&
    typeof event.baseVector === 'object' &&
    event.baseVector !== null
  );
};

const migrate = (raw: unknown): OutboxItem<QueuedReviewDraftEvent> | null => {
  const base = baseOutboxItemShape(raw);
  if (base === null) return null;
  if (!isQueuedReviewEvent(base.payload)) return null;
  return {
    id: base.id,
    queuedAt: base.queuedAt,
    attempts: base.attempts,
    nextAttemptAt: base.nextAttemptAt,
    payload: base.payload,
  };
};

export const reviewDraftOutbox = createOutbox<QueuedReviewDraftEvent>({
  storageKey: REVIEW_DRAFT_QUEUE_KEY,
  droppedKey: REVIEW_DRAFT_DROPPED_KEY,
  defaultLimit: REVIEW_DRAFT_QUEUE_LIMIT,
  overflowPolicy: { kind: 'reject-when-full' },
  migrate,
});

export const enqueueReviewDraftEvent = async (
  threadId: string,
  threadUrl: string,
  event: ReviewDraftClientEvent,
  storage?: OutboxStorage,
): Promise<void> => {
  await reviewDraftOutbox.enqueue({ threadId, threadUrl, event }, storage);
};

export const readReviewDraftQueue = async (
  storage?: OutboxStorage,
): Promise<readonly OutboxItem<QueuedReviewDraftEvent>[]> =>
  await reviewDraftOutbox.read(storage);

export const readReviewDraftDroppedCount = async (
  storage?: OutboxStorage,
): Promise<number> => await reviewDraftOutbox.readDropped(storage);

export const clearReviewDraftQueue = async (
  storage?: OutboxStorage,
): Promise<void> => {
  await reviewDraftOutbox.clear(storage);
};

export interface DrainReviewDraftOutboxOptions {
  readonly storage?: OutboxStorage;
  readonly now?: Date;
  readonly random?: () => number;
  readonly ignoreBackoff?: boolean;
}

export const drainReviewDraftOutbox = async (
  send: (queued: QueuedReviewDraftEvent, idempotencyKey: string) => Promise<void>,
  options: DrainReviewDraftOutboxOptions = {},
): Promise<{ readonly sent: number; readonly remaining: number }> =>
  await reviewDraftOutbox.drain(
    async (item) => {
      await send(item.payload, item.id);
    },
    options.storage,
    options.now,
    options.random,
    { ignoreBackoff: options.ignoreBackoff ?? false },
  );
