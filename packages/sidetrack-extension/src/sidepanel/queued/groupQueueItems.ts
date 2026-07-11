// §13 step 9 — group the pending queue by its target so the Queued
// view can render "3 asks waiting on <thread/workstream>" sections.
// Pure: takes the same queue projection the per-thread list consumes
// plus lightweight thread/workstream lookups, and returns ordered
// groups. Unit-testable without React.

import { compareQueueItems, type QueueItem } from '../../workboard';

export interface QueueTargetLite {
  readonly bac_id: string;
  readonly title: string;
  readonly provider?: string;
}

export interface QueueGroup {
  // Stable key: `${scope}:${targetId ?? 'global'}`.
  readonly key: string;
  readonly scope: QueueItem['scope'];
  readonly targetId?: string;
  // Human label for the section header. Falls back to the scope word
  // when the target can't be resolved (deleted thread/workstream).
  readonly label: string;
  // Provider chip for thread-scoped groups when known.
  readonly provider?: string;
  readonly items: readonly QueueItem[];
}

const SCOPE_FALLBACK_LABEL: Record<QueueItem['scope'], string> = {
  thread: 'Unknown thread',
  workstream: 'Unknown workstream',
  global: 'Anywhere',
};

// Only pending items belong in the Queued view; done/dismissed have
// left the queue. Grouped by (scope, targetId); each group's items are
// sorted with the shared comparator (drag rank, then createdAt), and
// groups themselves are ordered by their earliest item so the oldest
// waiting target floats to the top.
export const groupQueueItems = (
  items: readonly QueueItem[],
  threads: readonly QueueTargetLite[],
  workstreams: readonly QueueTargetLite[],
): readonly QueueGroup[] => {
  const pending = items.filter((item) => item.status === 'pending');
  const byKey = new Map<string, QueueItem[]>();
  for (const item of pending) {
    const key = `${item.scope}:${item.targetId ?? 'global'}`;
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, [item]);
    } else {
      bucket.push(item);
    }
  }

  const groups: QueueGroup[] = [];
  for (const [key, bucket] of byKey) {
    const sorted = bucket.slice().sort(compareQueueItems);
    const first = sorted[0];
    const scope = first.scope;
    const targetId = first.targetId;
    let label = SCOPE_FALLBACK_LABEL[scope];
    let provider: string | undefined;
    if (scope === 'global') {
      label = SCOPE_FALLBACK_LABEL.global;
    } else if (targetId !== undefined) {
      const pool = scope === 'thread' ? threads : workstreams;
      const target = pool.find((t) => t.bac_id === targetId);
      if (target !== undefined) {
        label = target.title;
        provider = target.provider;
      }
    }
    groups.push({
      key,
      scope,
      ...(targetId === undefined ? {} : { targetId }),
      label,
      ...(provider === undefined ? {} : { provider }),
      items: sorted,
    });
  }

  // Earliest waiting item first. compareQueueItems already ordered
  // within a group, so items[0] is each group's front-runner.
  return groups.sort((a, b) => compareQueueItems(a.items[0], b.items[0]));
};
