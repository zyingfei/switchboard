import type { EngagementTotals } from './aggregator';

// Zero-delta periodic-beacon suppression.
//
// The content script emits a non-final interval snapshot every 30s per
// tab. From ~38 open tabs most snapshots carry NO new attention — only
// `idleMs` grows (the tab is abandoned in the background). Those beacons
// are pure dead weight: in production they were ~99.8% of a 1.2M-event
// buffer and buried the one starved signal (session.aggregated) FIFO.
//
// This decides whether a PERIODIC (non-final, non-gate) snapshot is worth
// sending: skip it when every attention dimension is unchanged since the
// last SENT snapshot. `idleMs` is intentionally excluded from the
// comparison — it monotonically grows on a dead tab, so including it would
// defeat the whole point (every tick would look "changed"). The first
// snapshot of a session, any final:true, and the attention-gate emit are
// always sent by the caller and never routed through here.
//
// Downstream consequence (see engagementCache.sweepDurable aging): a
// suppressed tab stops refreshing the SW durable mirror's `updatedAt`, so
// an abandoned session finally ages past the idle-sweep threshold and
// emits exactly one aggregate instead of being pinned "live" forever.

// Attention dimensions compared for periodic-emit suppression. Excludes
// `idleMs` (always grows on a dead tab). Kept as an explicit list so a new
// EngagementTotals field can't silently start (or stop) gating emits —
// adding a field is a deliberate edit here.
const COMPARED_DIMENSIONS: readonly (keyof EngagementTotals)[] = [
  'activeMs',
  'visibleMs',
  'focusedWindowMs',
  'foregroundBursts',
  'returnCount',
  'scrollEvents',
  'maxScrollRatio',
  'copyCount',
  'pasteCount',
];

/**
 * Decide whether a periodic (30s tick) snapshot should be sent.
 *
 * @param lastSentDims the attention dimensions of the last SENT snapshot,
 *   or undefined when nothing has been sent yet (first snapshot of the
 *   session — always emit).
 * @param nextDims the attention dimensions of the candidate snapshot.
 * @returns true to send; false to suppress (no attention delta besides
 *   idle time).
 */
export const shouldEmitPeriodicSnapshot = (
  lastSentDims: EngagementTotals | undefined,
  nextDims: EngagementTotals,
): boolean => {
  if (lastSentDims === undefined) return true;
  for (const key of COMPARED_DIMENSIONS) {
    if (lastSentDims[key] !== nextDims[key]) return true;
  }
  return false;
};
