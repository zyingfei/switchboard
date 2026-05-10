import type { TabSessionRecord, TabSessionWorkstreamOption } from './types';

const formatDate = (input: string): string => {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export interface AttributionProvenanceProps {
  readonly record: TabSessionRecord;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
}

export function AttributionProvenance({ record, workstreams }: AttributionProvenanceProps) {
  const attribution = record.currentAttribution;
  if (attribution === undefined || attribution.workstreamId === null) {
    return <span className="tab-session-provenance mono">No attribution</span>;
  }
  const label =
    workstreams.find((workstream) => workstream.bac_id === attribution.workstreamId)?.path ??
    attribution.workstreamId;
  return (
    <span className="tab-session-provenance mono">
      Attributed by you on {formatDate(attribution.observedAt)} · {label}
    </span>
  );
}
