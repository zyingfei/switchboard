import type {
  TabSessionRecord,
  TabSessionResolutionResult,
  TabSessionWorkstreamOption,
} from './types';

const workstreamLabel = (
  workstreamId: string | null | undefined,
  workstreams: readonly TabSessionWorkstreamOption[],
): string => {
  if (workstreamId === null || workstreamId === undefined) return '?';
  return workstreams.find((workstream) => workstream.bac_id === workstreamId)?.path ?? workstreamId;
};

export interface AttributionBadgeProps {
  readonly record?: TabSessionRecord;
  readonly suggestion?: TabSessionResolutionResult;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
}

export function AttributionBadge({ record, suggestion, workstreams }: AttributionBadgeProps) {
  const attribution = record?.currentAttribution;
  const suggestedWorkstreamId = suggestion?.decision.workstreamId;
  const label = workstreamLabel(attribution?.workstreamId ?? suggestedWorkstreamId, workstreams);
  const asserted = attribution?.source === 'user_asserted' && attribution.workstreamId !== null;
  const suggested = !asserted && suggestedWorkstreamId !== undefined;
  return (
    <span
      className={
        'tab-session-badge ' + (asserted ? 'is-asserted' : suggested ? 'is-suggested' : 'is-empty')
      }
      title={
        asserted
          ? `Attributed by you to ${label}`
          : suggested
            ? `Suggested by Sidetrack: ${label}`
            : 'No tab-session attribution'
      }
    >
      {label}
    </span>
  );
}
