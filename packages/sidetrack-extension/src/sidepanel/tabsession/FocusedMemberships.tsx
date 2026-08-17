import { useEffect } from 'react';

import { MembershipChips } from './MembershipChips';
import type { TabSessionRecord, TabSessionWorkstreamOption } from './types';

export interface FocusedMembershipsProps {
  readonly record: TabSessionRecord;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
  // True when the batched memberships overlay (the `/v1/visits/projection`
  // fetch that populates `record.memberships`) has NEVER loaded — the
  // companion's wire contract omits the `memberships` key entirely when a
  // URL has zero rows, so a per-record read can't tell "genuinely no
  // memberships" from "the overlay never arrived". The caller passes this
  // explicitly, derived from the projection fetch's own success/failure
  // state, not from the record.
  readonly fetchFailed?: boolean;
  // Opens the "add to workstream" picker (parent owns the modal). Omitted
  // -> the "+" affordance renders disabled.
  readonly onAdd?: (tabSessionId: string) => void;
  // Drops ONE secondary membership row. Omitted -> chips render read-only.
  readonly onRemove?: (tabSessionId: string, workstreamId: string) => void;
}

// Main "Now" card wrapper around MembershipChips (docs/plans/2026-08-16-
// category-flexibility-hyde.md §9 addendum — PR #384 wired MembershipChips
// into Inbox/timeline cards + pickers but missed the primary focused-page
// card, where the user actually looks). Adds ONE thing MembershipChips
// itself doesn't know about: WHY-VISIBILITY when the overlay fetch that
// feeds it has never succeeded. Rendering the normal (empty) chip row in
// that case would silently read as "confirmed: not in any other
// workstream" when the truth is "we don't know yet" — render a muted
// one-word fallback instead, and log audibly so a stuck fetch is
// discoverable rather than looking like a permanently-empty state.
export function FocusedMemberships({
  record,
  workstreams,
  fetchFailed = false,
  onAdd,
  onRemove,
}: FocusedMembershipsProps) {
  useEffect(() => {
    if (!fetchFailed) return;
    // eslint-disable-next-line no-console
    console.debug(
      '[sidetrack:panel] focused-page memberships overlay unavailable — rendering fallback',
      { tabSessionId: record.tabSessionId },
    );
  }, [fetchFailed, record.tabSessionId]);

  if (fetchFailed) {
    return (
      <span
        className="membership-chips-fallback subtle"
        title="Couldn't load workstream memberships — will retry automatically"
        data-testid="focused-memberships-fallback"
      >
        —
      </span>
    );
  }

  return (
    <MembershipChips
      record={record}
      workstreams={workstreams}
      {...(onAdd === undefined ? {} : { onAdd })}
      {...(onRemove === undefined ? {} : { onRemove })}
    />
  );
}
