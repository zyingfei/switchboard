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
  const attributed = attribution !== undefined && attribution.workstreamId !== null;
  const asserted = attributed && attribution.source !== 'inferred';
  const suggested = !attributed && suggestedWorkstreamId !== undefined;
  const sourceLabel = attribution?.source ?? 'unknown';
  return (
    <span
      className={
        'tab-session-badge ' + (asserted ? 'is-asserted' : suggested ? 'is-suggested' : 'is-empty')
      }
      title={
        asserted
          ? `Attributed to ${label} (${sourceLabel})`
          : attributed
            ? `Inferred by Sidetrack: ${label}`
            : suggested
              ? `Suggested by Sidetrack: ${label}`
              : 'No tab-session attribution'
      }
    >
      {label}
    </span>
  );
}
