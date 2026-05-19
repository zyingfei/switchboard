// Optimistic-attribution overlay — kills the attribution flicker.
//
// Without this, picking a workstream on an inbox row / current-tab
// card cycled through three visible states over several seconds:
// the suggestion is cleared (→ "No attribution"), a refetch
// re-resolves and the stale suggestion re-appears (→ "That's right" /
// "Checking signals…"), then the projection finally catches up
// (→ the chosen workstream). One click, three renders.
//
// The fix: the instant the user decides, record the decision here.
// Every attribution surface reads the EFFECTIVE state through this
// overlay, so it shows the final answer immediately and the
// suggestion / re-resolve is suppressed for that URL until the server
// projection reconciles — at which point the overlay entry is dropped
// with zero visible change (server == overlay). On POST failure the
// entry is dropped (rollback) and the real state shows again.
//
// Pure + keyed by canonicalUrl so it is unit-tested and shared by the
// inbox row and the current-tab card (same pattern as
// effectiveThreadWorkstream / focusedUrlRecord).

export type OptimisticDecision =
  | { readonly kind: 'workstream'; readonly workstreamId: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ignored'; readonly reason: 'noise' | 'duplicate' | 'private' };

export type OptimisticDecisions = Readonly<Record<string, OptimisticDecision>>;

interface AttributionLike {
  readonly workstreamId: string | null;
  readonly source: 'user_asserted';
  readonly observedAt: string;
  readonly clientEventId: string;
}
interface IgnoredLike {
  readonly reason: 'noise' | 'duplicate' | 'private';
  readonly observedAt: string;
  readonly clientEventId: string;
}
export interface AttributableRecord {
  readonly currentAttribution?: AttributionLike | { readonly workstreamId: string | null };
  readonly currentIgnored?: IgnoredLike | { readonly reason: string };
}

export const setOptimisticDecision = (
  current: OptimisticDecisions,
  canonicalUrl: string,
  decision: OptimisticDecision,
): OptimisticDecisions => ({ ...current, [canonicalUrl]: decision });

export const clearOptimisticDecision = (
  current: OptimisticDecisions,
  canonicalUrl: string,
): OptimisticDecisions => {
  if (!(canonicalUrl in current)) return current;
  const next = { ...current };
  delete next[canonicalUrl];
  return next;
};

/** True while a user decision for this URL is awaiting reconcile —
 *  callers MUST suppress the suggestion / "Checking signals…" re-resolve
 *  for it so the optimistic final state isn't undercut by a stale one. */
export const hasOptimisticDecision = (
  decisions: OptimisticDecisions,
  canonicalUrl: string | undefined,
): boolean => canonicalUrl !== undefined && canonicalUrl in decisions;

/**
 * The record as it should be DISPLAYED: a pending user decision wins
 * over whatever the (possibly stale) projection currently says. When
 * there's no pending decision the record is returned unchanged
 * (referential stability — no needless re-renders).
 */
export const withOptimisticAttribution = <T extends AttributableRecord>(
  record: T,
  decision: OptimisticDecision | undefined,
  nowIso: string,
): T => {
  if (decision === undefined) return record;
  const stamp = { observedAt: nowIso, clientEventId: 'optimistic', source: 'user_asserted' as const };
  if (decision.kind === 'ignored') {
    return {
      ...record,
      currentIgnored: { reason: decision.reason, observedAt: nowIso, clientEventId: 'optimistic' },
    };
  }
  const workstreamId = decision.kind === 'workstream' ? decision.workstreamId : null;
  // A decision supersedes a prior ignore (re-organizing clears it).
  const { currentIgnored: _drop, ...rest } = record;
  return { ...(rest as T), currentAttribution: { workstreamId, ...stamp } };
};

/**
 * Reconciled when the server projection already reflects this exact
 * decision — then the overlay entry is safe to drop (no visible
 * change). Used to prune the map after the decision POST's projection
 * is applied so the overlay never lingers.
 */
export const isReconciled = (
  record: AttributableRecord | undefined,
  decision: OptimisticDecision,
): boolean => {
  if (record === undefined) return false;
  if (decision.kind === 'ignored') return record.currentIgnored !== undefined;
  const ws = record.currentAttribution?.workstreamId;
  if (ws === undefined && record.currentAttribution === undefined) return false;
  return decision.kind === 'workstream' ? ws === decision.workstreamId : ws === null;
};
