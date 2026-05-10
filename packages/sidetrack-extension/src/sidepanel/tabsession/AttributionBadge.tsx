import type { TabSessionRecord, TabSessionWorkstreamOption } from './types';

const workstreamLabel = (
  workstreamId: string | null | undefined,
  workstreams: readonly TabSessionWorkstreamOption[],
): string => {
  if (workstreamId === null || workstreamId === undefined) return '?';
  return workstreams.find((workstream) => workstream.bac_id === workstreamId)?.path ?? workstreamId;
};

export interface AttributionBadgeProps {
  readonly record?: TabSessionRecord;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
}

export function AttributionBadge({ record, workstreams }: AttributionBadgeProps) {
  const attribution = record?.currentAttribution;
  const label = workstreamLabel(attribution?.workstreamId, workstreams);
  const asserted = attribution?.source === 'user_asserted' && attribution.workstreamId !== null;
  return (
    <span
      className={'tab-session-badge ' + (asserted ? 'is-asserted' : 'is-empty')}
      title={asserted ? `Attributed by you to ${label}` : 'No tab-session attribution'}
    >
      {label}
    </span>
  );
}
