import type { TabSessionRecord, TabSessionWorkstreamOption, UrlMembershipRow } from './types';

const workstreamName = (
  workstreamId: string,
  workstreams: readonly TabSessionWorkstreamOption[],
): string => workstreams.find((workstream) => workstream.bac_id === workstreamId)?.path ?? '(removed)';

export interface MembershipChipsProps {
  readonly record: TabSessionRecord;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
  // Opens the "add to workstream" picker (parent owns the modal, same
  // pattern as InboxCard's onPickAnother). Omitted -> the "+" affordance
  // renders disabled.
  readonly onAdd?: (tabSessionId: string) => void;
  // Drops ONE secondary membership row. Omitted -> chips render without a
  // remove button (read-only).
  readonly onRemove?: (tabSessionId: string, workstreamId: string) => void;
}

// Filed item cards (docs/plans/2026-08-16-category-flexibility-hyde.md,
// UI-visibility phase) — SECONDARY workstream chips beside the existing
// primary AttributionBadge. `currentAttribution` stays the single visually-
// distinct primary indicator (AttributionBadge, unchanged); this renders
// only the ADDITIONAL memberships, so a row already counted as primary
// never double-renders as a chip too. The remove ("×") affordance is
// rendered on secondary chips only — there is no "remove primary" here
// (that's the existing "Not in any stream" action).
export function MembershipChips({ record, workstreams, onAdd, onRemove }: MembershipChipsProps) {
  const primaryWorkstreamId = record.currentAttribution?.workstreamId ?? null;
  const secondary: readonly UrlMembershipRow[] = (record.memberships ?? []).filter(
    (row) => row.workstreamId !== primaryWorkstreamId,
  );

  return (
    <span className="membership-chips">
      {secondary.length > 0 ? (
        <span className="membership-chips-label subtle">Also in:</span>
      ) : null}
      {secondary.map((row) => (
        <span className="membership-chip" key={row.workstreamId}>
          <span className="membership-chip-label">{workstreamName(row.workstreamId, workstreams)}</span>
          {onRemove !== undefined ? (
            <button
              type="button"
              className="membership-chip-remove"
              onClick={() => {
                onRemove(record.tabSessionId, row.workstreamId);
              }}
              title={`Remove from ${workstreamName(row.workstreamId, workstreams)}`}
              aria-label={`Remove from ${workstreamName(row.workstreamId, workstreams)}`}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
      <button
        type="button"
        className="membership-chip-add"
        disabled={onAdd === undefined}
        onClick={() => {
          onAdd?.(record.tabSessionId);
        }}
        title="Add to another workstream"
        aria-label="Add to another workstream"
      >
        +
      </button>
    </span>
  );
}
