import { formatAnchorDisplay, type EntityDisplayCtx } from '../entityDisplay/format';
import type { ConnectionNode } from '../connections/types';
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

export interface AttributionProvenanceProps {
  readonly record: TabSessionRecord;
  readonly suggestion?: TabSessionResolutionResult;
  readonly workstreams: readonly TabSessionWorkstreamOption[];
  // Live connections snapshot (id → node). When provided, anchor ids
  // resolve to the same human-friendly label used in the Connections
  // tab. When omitted, anchors degrade to kind-aware placeholders
  // ("Tab session", "(visit)") — never raw ids.
  readonly nodeById?: ReadonlyMap<string, ConnectionNode>;
  readonly displayCtx?: EntityDisplayCtx;
}

const EMPTY_NODE_BY_ID: ReadonlyMap<string, ConnectionNode> = new Map();
const DEFAULT_CTX: EntityDisplayCtx = {
  resolveWorkstreamPath: () => null,
  replicaAlias: () => 'Browser',
};

export function AttributionProvenance({
  record,
  suggestion,
  workstreams,
  nodeById,
  displayCtx,
}: AttributionProvenanceProps) {
  const ctx: EntityDisplayCtx = displayCtx ?? DEFAULT_CTX;
  const byId: ReadonlyMap<string, ConnectionNode> = nodeById ?? EMPTY_NODE_BY_ID;
  const attribution = record.currentAttribution;
  if (attribution !== undefined && attribution.workstreamId !== null) {
    const label =
      workstreams.find((workstream) => workstream.bac_id === attribution.workstreamId)?.path ??
      '(removed)';
    const source =
      attribution.source === 'user_asserted'
        ? 'you'
        : attribution.source === 'inferred'
          ? 'Sidetrack'
          : attribution.source;
    return (
      <span className="tab-session-provenance mono">
        Attributed by {source} on {formatDate(attribution.observedAt)} · {label}
      </span>
    );
  }
  if (suggestion?.decision.workstreamId !== undefined) {
    const top = suggestion.fusedCandidates[0];
    const source = top?.dominantSource ?? 'none';
    const seen = new Set<string>();
    const anchorLabels: string[] = [];
    for (const reason of top?.reasons ?? []) {
      for (const anchor of reason.anchors) {
        const display = formatAnchorDisplay(anchor, byId, ctx);
        // Skip low-signal generic placeholders so we don't waste row
        // space repeating "Tab session" / "(visit)". When every anchor
        // is generic, the empty list is honest about not knowing more.
        if (display.primary.startsWith('(')) continue;
        if (seen.has(display.primary)) continue;
        seen.add(display.primary);
        anchorLabels.push(display.primary);
        if (anchorLabels.length >= 3) break;
      }
      if (anchorLabels.length >= 3) break;
    }
    return (
      <span className="tab-session-provenance mono">
        Suggested by {source} · margin {suggestion.decision.margin.toFixed(2)}
        {anchorLabels.length > 0 ? ` · ${anchorLabels.join(' · ')}` : ''}
      </span>
    );
  }
  return <span className="tab-session-provenance mono">No attribution</span>;
}
