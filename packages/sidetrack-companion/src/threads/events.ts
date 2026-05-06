// Thread log-event types. PR3 introduces threads as a causal
// projection of these events, alongside the legacy `_BAC/threads/
// <bac_id>.json` write path (kept for back-compat readers; the log
// is the durable cross-replica truth going forward).
//
// Event semantics:
//   thread.upserted   — full-record register write. Each upsert
//                        carries the whole thread payload; the
//                        projection collapses concurrent upserts via
//                        causal-register merge.
//   thread.archived   — status sub-register write. Causally newer
//                        archive supersedes any prior status; tied
//                        with an unarchive resolves via the LWW
//                        register tiebreak.
//   thread.unarchived — symmetric to archived.
//   thread.deleted    — hard tombstone. The projection short-circuits
//                        to a deleted state; subsequent upserts
//                        whose deps cover the delete revive the
//                        thread. Concurrent later upserts revive on
//                        their own merit (matches review-draft
//                        discard semantics).

export const THREAD_UPSERTED = 'thread.upserted' as const;
export const THREAD_ARCHIVED = 'thread.archived' as const;
export const THREAD_UNARCHIVED = 'thread.unarchived' as const;
export const THREAD_DELETED = 'thread.deleted' as const;

export type ThreadEventType =
  | typeof THREAD_UPSERTED
  | typeof THREAD_ARCHIVED
  | typeof THREAD_UNARCHIVED
  | typeof THREAD_DELETED;

export type ThreadStatus =
  | 'active'
  | 'tracked'
  | 'queued'
  | 'needs_organize'
  | 'closed'
  | 'restorable'
  | 'archived'
  | 'removed';

export type ThreadTrackingMode = 'auto' | 'manual' | 'stopped' | 'removed';

export interface ThreadUpsertedPayload {
  readonly bac_id: string;
  readonly provider: string;
  readonly threadUrl: string;
  readonly title: string;
  readonly lastSeenAt: string;
  readonly status?: ThreadStatus;
  readonly primaryWorkstreamId?: string;
  readonly tags?: readonly string[];
  readonly trackingMode?: ThreadTrackingMode;
}

export interface ThreadArchivedPayload {
  readonly bac_id: string;
}

export interface ThreadUnarchivedPayload {
  readonly bac_id: string;
}

export interface ThreadDeletedPayload {
  readonly bac_id: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const isThreadUpsertedPayload = (
  value: unknown,
): value is ThreadUpsertedPayload => {
  if (!isRecord(value)) return false;
  return (
    typeof value['bac_id'] === 'string' &&
    typeof value['provider'] === 'string' &&
    typeof value['threadUrl'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['lastSeenAt'] === 'string'
  );
};

export const isThreadStatusPayload = (
  value: unknown,
): value is ThreadArchivedPayload =>
  isRecord(value) && typeof value['bac_id'] === 'string';
