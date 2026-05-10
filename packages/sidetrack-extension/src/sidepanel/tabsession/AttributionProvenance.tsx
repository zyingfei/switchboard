import type {
  TabSessionRecord,
  TabSessionResolutionResult,
  TabSessionWorkstreamOption,
} from './types';

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

const anchorLabel = (anchor: string): string =>
  anchor
    .replace(/^timeline-visit:/u, '')
    .replace(/^workstream:/u, '')
    .replace(/^tab-session:/u, '');

export interface AttributionProvenanceProps {
  readonly record: TabSessionRecord;
  readonly suggestion?: TabSessionResolutionResult;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
}

export function AttributionProvenance({
  record,
  suggestion,
  workstreams,
}: AttributionProvenanceProps) {
  const attribution = record.currentAttribution;
  if (attribution !== undefined && attribution.workstreamId !== null) {
    const label =
      workstreams.find((workstream) => workstream.bac_id === attribution.workstreamId)?.path ??
      attribution.workstreamId;
    return (
      <span className="tab-session-provenance mono">
        Attributed by you on {formatDate(attribution.observedAt)} · {label}
      </span>
    );
  }
  if (suggestion?.decision.workstreamId !== undefined) {
    const top = suggestion.fusedCandidates[0];
    const source = top?.dominantSource ?? 'none';
    const anchors = [
      ...new Set(top?.reasons.flatMap((reason) => reason.anchors).map(anchorLabel) ?? []),
    ].slice(0, 3);
    return (
      <span className="tab-session-provenance mono">
        Suggested by {source} · margin {suggestion.decision.margin.toFixed(2)}
        {anchors.length > 0 ? ` · ${anchors.join(' · ')}` : ''}
      </span>
    );
  }
  return <span className="tab-session-provenance mono">No attribution</span>;
}
